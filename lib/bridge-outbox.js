/**
 * 回传 Outbox：把「用户确认过的那一次投递」变成一条有状态、防重入、可查的记录。
 *
 * 三条硬规矩：
 * 1. 只有 confirm 才产生副作用，prepare 只冻结目标与正文。
 * 2. 同一条记录只允许派发一次；双击、并发、刷新都不能让它发两遍。
 * 3. 结果拿不准时记 unknown，绝不自动重试。宁可让用户看见"不确定"，也不重复说话。
 *
 * 正文不放进 storage.global，落在 App dataDir 的私有准备区，带 TTL。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { BRIDGE_LIMITS, bridgeError, computeContentHash, sanitizeId } from "./bridge-contract.js";

const ACTION_STATES = new Set(["prepared", "dispatching", "accepted", "delivered", "failed", "unknown"]);
const TERMINAL_STATES = new Set(["accepted", "delivered", "failed", "unknown"]);

function newActionId() {
  return `act_${randomBytes(12).toString("hex")}`;
}

export function createBridgeOutbox({ dataDir, logger, clock = () => Date.now(), dispatch }) {
  const actionsFile = path.join(dataDir, "bridge-actions.json");
  const exportDir = path.join(dataDir, "bridge-export");
  /** actionId → record */
  const actions = new Map();
  /** actionId → 正在进行的派发，用来挡并发 confirm */
  const inflight = new Map();
  let loaded = false;
  let saveChain = Promise.resolve();

  async function ensureDirs() {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(exportDir, { recursive: true, mode: 0o700 });
  }

  /** 元数据落盘：串行写，避免两个动作同时写坏文件 */
  function persist() {
    saveChain = saveChain.then(async () => {
      const payload = { version: 1, actions: [...actions.values()].map(toMeta) };
      const text = JSON.stringify(payload);
      if (Buffer.byteLength(text, "utf8") > BRIDGE_LIMITS.outboxMaxBytes) {
        throw bridgeError("canvas_quota", "回传记录过多，请先清理已完成的记录");
      }
      const tmp = `${actionsFile}.tmp`;
      await fs.writeFile(tmp, text, { mode: 0o600 });
      await fs.rename(tmp, actionsFile);
    }).catch((err) => {
      logger?.warn?.(`[bridge] Outbox 落盘失败：${err?.message || String(err)}`);
    });
    return saveChain;
  }

  function toMeta(record) {
    return {
      actionId: record.actionId,
      targetSessionId: record.targetSessionId,
      kind: record.kind,
      payloadHash: record.payloadHash,
      state: record.state,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      errorCode: record.errorCode || null,
      bytes: record.bytes || 0,
    };
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(actionsFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.actions)) {
        for (const meta of parsed.actions) {
          if (!meta || !sanitizeId(meta.actionId) || !ACTION_STATES.has(meta.state)) continue;
          actions.set(meta.actionId, {
            ...meta,
            // 重启时仍在 dispatching：结果不可知，按 unknown 收口，永不自动重发
            state: meta.state === "dispatching" ? "unknown" : meta.state,
            errorCode: meta.state === "dispatching" ? "action_unknown" : meta.errorCode || null,
          });
        }
      }
    } catch (err) {
      if (err?.code !== "ENOENT") logger?.warn?.(`[bridge] Outbox 读取失败：${err?.message || String(err)}`);
    }
    // 过期与超额清理：只清终态记录，绝不动用户的画布数据
    const now = clock();
    for (const [id, record] of actions) {
      if (TERMINAL_STATES.has(record.state) && record.expiresAt && record.expiresAt < now - BRIDGE_LIMITS.actionTtlMs) {
        actions.delete(id);
      }
    }
    while (actions.size > BRIDGE_LIMITS.outboxMaxActions) {
      const victim = [...actions.values()].find((r) => TERMINAL_STATES.has(r.state));
      if (!victim) break;
      actions.delete(victim.actionId);
    }
  }

  function bodyPath(actionId) {
    return path.join(exportDir, `${actionId}.txt`);
  }

  /**
   * 冻结一次投递。不调用宿主，不产生任何外部副作用。
   */
  async function prepare({ targetSessionId, kind, text, sessionTitle = "" }) {
    await load();
    const safeTarget = sanitizeId(targetSessionId);
    if (!safeTarget) throw bridgeError("session_not_addressable");
    if (kind !== "send-text" && kind !== "stage-markdown") throw bridgeError("invalid_request", "未知的投递类型");
    const body = typeof text === "string" ? text : "";
    if (!body.trim()) throw bridgeError("invalid_request", "内容为空");
    const bytes = Buffer.byteLength(body, "utf8");
    const limit = kind === "stage-markdown" ? BRIDGE_LIMITS.exportMaxBytes : BRIDGE_LIMITS.textMaxBytes;
    if (bytes > limit) {
      throw bridgeError("invalid_request", `内容超过 ${Math.round(limit / 1024)} KiB 上限`);
    }

    const now = clock();
    const actionId = newActionId();
    const record = {
      actionId,
      targetSessionId: safeTarget,
      targetTitle: String(sessionTitle || "").slice(0, BRIDGE_LIMITS.titleMaxLength),
      kind,
      payloadHash: computeContentHash([body]),
      state: "prepared",
      createdAt: new Date(now).toISOString(),
      expiresAt: now + BRIDGE_LIMITS.actionTtlMs,
      bytes,
      errorCode: null,
    };

    await ensureDirs();
    // 正文独占写（wx）：既有文件说明 actionId 撞了，宁可失败也不覆盖
    await fs.writeFile(bodyPath(actionId), body, { mode: 0o600, flag: "wx" });
    actions.set(actionId, record);
    await persist();
    logger?.info?.(`[bridge] 准备投递 ${actionId} · ${kind} · ${bytes} 字节`);
    return {
      actionId,
      kind,
      targetSessionId: record.targetSessionId,
      expiresAt: new Date(record.expiresAt).toISOString(),
      bytes,
      state: record.state,
    };
  }

  async function readBody(actionId) {
    try {
      return await fs.readFile(bodyPath(actionId), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * 唯一会产生副作用的地方。
   * @param {object} params
   * @param {string} params.actionId
   * @param {(input: {record: object, text: string}) => Promise<{accepted?: boolean, delivered?: boolean}>} [params.dispatcher]
   */
  async function confirm({ actionId, dispatcher }) {
    await load();
    const id = sanitizeId(actionId);
    if (!id) throw bridgeError("invalid_request", "actionId 不合法");
    const record = actions.get(id);
    if (!record) throw bridgeError("action_expired");
    // 占位必须是同步的：任何 await 之前先把锁合上，
    // 否则读正文那一瞬间三个调用会一起挤进来
    if (inflight.has(id)) throw bridgeError("action_already_used", "该动作正在派发中");
    if (record.state !== "prepared") throw bridgeError("action_already_used", record.state);
    inflight.set(id, true);

    try {
      if (record.expiresAt && record.expiresAt < clock()) {
        record.state = "failed";
        record.errorCode = "action_expired";
        await persist();
        throw bridgeError("action_expired");
      }

      const text = await readBody(id);
      if (text === null) {
        record.state = "failed";
        record.errorCode = "invalid_request";
        await persist();
        throw bridgeError("invalid_request", "待投递内容已丢失，请重新准备");
      }

      // 先落盘 dispatching 再碰宿主：崩在这一步，重启后会成 unknown，不会自动重发
      record.state = "dispatching";
      await persist();

      const run = dispatcher || dispatch;
      if (typeof run !== "function") throw bridgeError("dispatch_failed", "缺少派发适配器");
      try {
        const result = await run({ record, text });
        record.state = result?.delivered ? "delivered" : "accepted";
        record.errorCode = null;
        await persist();
        logger?.info?.(`[bridge] 投递 ${id} → ${record.state}`);
        return publicState(record);
      } catch (err) {
        // 能明确判定失败才算失败；其余一律 unknown，绝不自动重试
        const definite = err?.code === "permission_missing" || err?.definite === true;
        record.state = definite ? "failed" : "unknown";
        record.errorCode = definite ? err?.code || "dispatch_failed" : "action_unknown";
        await persist();
        logger?.warn?.(`[bridge] 投递 ${id} → ${record.state}（${record.errorCode}）`);
        throw err;
      }
    } finally {
      inflight.delete(id);
    }
  }

  function publicState(record) {
    return {
      actionId: record.actionId,
      kind: record.kind,
      targetSessionId: record.targetSessionId,
      state: record.state,
      errorCode: record.errorCode || null,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
    };
  }

  async function get({ actionId }) {
    await load();
    const id = sanitizeId(actionId);
    if (!id) throw bridgeError("invalid_request", "actionId 不合法");
    const record = actions.get(id);
    if (!record) throw bridgeError("action_expired");
    return publicState(record);
  }

  async function list({ limit = 20 } = {}) {
    await load();
    return [...actions.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map(publicState);
  }

  /** 过期内容清理：只删终态动作的正文文件 */
  async function sweep() {
    await load();
    const now = clock();
    for (const [id, record] of actions) {
      if (!TERMINAL_STATES.has(record.state)) continue;
      if (!record.expiresAt || record.expiresAt > now) continue;
      await fs.rm(bodyPath(id), { force: true }).catch(() => {});
      actions.delete(id);
    }
    await persist();
  }

  return { load, prepare, confirm, get, list, sweep, _actions: actions };
}

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
import nodeFs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { BRIDGE_LIMITS, bridgeError, computeContentHash, sanitizeId } from "./bridge-contract.js";

const ACTION_STATES = new Set(["prepared", "dispatching", "accepted", "delivered", "failed", "unknown"]);
const TERMINAL_STATES = new Set(["accepted", "delivered", "failed", "unknown"]);

function newActionId() {
  return `act_${randomBytes(12).toString("hex")}`;
}

export function createBridgeOutbox({ dataDir, logger, clock = () => Date.now(), dispatch, fs = nodeFs }) {
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

  /**
   * 返回本次写入的真实结果。内部队列可以恢复，但调用方不能吞掉失败。
   * 文件 sync + 原子替换 + 目录 sync 全部完成，才算跨过派发前的持久化屏障。
   */
  function persist() {
    const payload = { version: 1, actions: [...actions.values()].map(toMeta) };
    const text = JSON.stringify(payload);
    const write = saveChain.then(async () => {
      if (Buffer.byteLength(text, "utf8") > BRIDGE_LIMITS.outboxMaxBytes) {
        throw bridgeError("canvas_quota", "回传记录过多，请先清理已完成的记录");
      }
      const tmp = `${actionsFile}.${randomBytes(12).toString("hex")}.tmp`;
      let file, directory;
      try {
        file = await fs.open(tmp, "wx", 0o600);
        await file.writeFile(text, "utf8");
        await file.sync();
        await file.close();
        file = null;
        await fs.rename(tmp, actionsFile);
        directory = await fs.open(dataDir, "r");
        await directory.sync();
      } finally {
        await file?.close().catch(() => {});
        await directory?.close().catch(() => {});
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    }).catch((err) => {
      logger?.warn?.("[bridge] Outbox 持久化失败；未越过落盘屏障不得派发");
      if (err?.code === "canvas_quota") throw err;
      throw bridgeError("outbox_persist_failed", "本地记录未能可靠保存，已阻止继续投递");
    });
    // 只恢复队列尾巴。返回 write（仍然拒绝），不能返回这个已吃掉错误的尾巴。
    saveChain = write.catch(() => {});
    return write;
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
    try {
      await persist();
    } catch (err) {
      // prepare 未成功就不交出 actionId，也不保留可继续确认的内存动作。
      actions.delete(actionId);
      await fs.rm(bodyPath(actionId), { force: true }).catch(() => {});
      throw err;
    }
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

      const run = dispatcher || dispatch;
      if (typeof run !== "function") throw bridgeError("dispatch_failed", "缺少派发适配器");

      // 必须先可靠落盘 dispatching，再碰宿主。失败时关闭本内存动作，不自动重试。
      record.state = "dispatching";
      try {
        await persist();
      } catch (err) {
        record.state = "failed";
        record.errorCode = err.code || "outbox_persist_failed";
        throw err;
      }

      let result;
      try {
        result = await run({ record, text });
      } catch (err) {
        // 宿主调用已经开始：能明确判定失败才算 failed，其余一律 unknown。
        const definite = err?.code === "permission_missing" || err?.definite === true;
        record.state = definite ? "failed" : "unknown";
        record.errorCode = definite ? err?.code || "dispatch_failed" : "action_unknown";
        try {
          await persist();
        } catch {
          record.state = "unknown";
          record.errorCode = "action_unknown";
          throw bridgeError("action_unknown", "投递回执及终态记录未能确认，请核对原动作，勿重新发送");
        }
        logger?.warn?.(`[bridge] 投递 ${id} → ${record.state}（${record.errorCode}）`);
        throw err;
      }

      record.state = result?.delivered ? "delivered" : "accepted";
      record.errorCode = null;
      try {
        await persist();
      } catch {
        // 不能把“已经碰过宿主，但终态保存失败”说成“没有发送”。
        // 磁盘上的 dispatching 屏障仍在，重启会转 unknown，不得重发。
        record.state = "unknown";
        record.errorCode = "action_unknown";
        throw bridgeError("action_unknown", "宿主可能已接纳，终态记录未可靠保存；请核对原动作，勿重新发送");
      }
      logger?.info?.(`[bridge] 投递 ${id} → ${record.state}`);
      return publicState(record);
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

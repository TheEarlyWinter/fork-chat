/**
 * 导入意图：本体那边点了「送到分叉对话」，先在这里留一张凭条。
 *
 * 为什么不当场导入：工具触发时主卡可能没开，而且用户还得选落到哪。
 * 所以这里只记「哪个会话的哪条消息想进来」，正文不落这张凭条，
 * 真正内容等主卡打开后按权限重新读。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { BRIDGE_LIMITS, bridgeError, sanitizeId, sanitizeTitle } from "./bridge-contract.js";

const INTENTS_FILE = "bridge-intents.json";
const MAX_INTENTS = 20;
const MAX_BYTES = BRIDGE_LIMITS.outboxMaxBytes;

/** 领取租约：窗口崩溃后，超过这个时长的 claim 允许被别的窗口接管 */
const CLAIM_LEASE_MS = 10 * 60 * 1000;

export function createBridgeIntents({ dataDir, logger, clock = () => Date.now() }) {
  const file = path.join(dataDir, INTENTS_FILE);
  /** intentId → record */
  const intents = new Map();
  let loaded = false;
  let saveChain = Promise.resolve();

  function meta(record) {
    return {
      intentId: record.intentId,
      sessionId: record.sessionId,
      messageId: record.messageId,
      title: record.title,
      origin: record.origin,
      createdAt: record.createdAt,
      claimedBy: record.claimedBy,
      claimedAt: record.claimedAt ?? null,
      consumed: record.consumed,
    };
  }

  function persist() {
    saveChain = saveChain
      .then(async () => {
        const text = JSON.stringify({ version: 1, intents: [...intents.values()].map(meta) });
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
          // 只清已完成/已消费的，不动用户还在等的那些
          for (const [id, record] of intents) {
            if (record.consumed) intents.delete(id);
          }
        }
        const finalText = JSON.stringify({ version: 1, intents: [...intents.values()].map(meta) });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, finalText, { mode: 0o600 });
        await fs.rename(tmp, file);
      })
      .catch((err) => logger?.warn?.(`[bridge] 导入意图落盘失败：${err?.message || String(err)}`));
    return saveChain;
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.intents)) {
        for (const record of parsed.intents) {
          if (!record?.intentId) continue;
          intents.set(record.intentId, {
            ...meta(record),
            claimedBy: record.claimedBy || null,
            claimedAt: typeof record.claimedAt === "number" ? record.claimedAt : null,
          });
        }
      }
    } catch (err) {
      if (err?.code !== "ENOENT") logger?.warn?.(`[bridge] 导入意图读取失败：${err?.message || String(err)}`);
    }
  }

  /**
   * 记一张凭条。只存定位符，不存正文、不存 token。
   */
  async function enqueue({ sessionId, messageId = null, title = "", origin = "message-action" }) {
    await load();
    const safeSession = sanitizeId(sessionId);
    if (!safeSession) throw bridgeError("session_not_addressable", "缺少真实 sessionId");
    const safeMessage = messageId ? sanitizeId(messageId) : null;

    for (const record of intents.values()) {
      if (record.consumed) continue;
      if (record.sessionId === safeSession && record.messageId === safeMessage) {
        // 同一个入口重复点：回同一张凭条，不叠新的
        return meta(record);
      }
    }

    while (intents.size >= MAX_INTENTS) {
      const victim = [...intents.values()].find((r) => r.consumed);
      if (!victim) throw bridgeError("canvas_quota", "待确认的导入请求过多");
      intents.delete(victim.intentId);
    }

    const record = {
      intentId: `int_${randomBytes(9).toString("hex")}`,
      sessionId: safeSession,
      messageId: safeMessage,
      title: sanitizeTitle(title),
      origin: origin === "context-menu" ? "context-menu" : "message-action",
      createdAt: new Date(clock()).toISOString(),
      claimedBy: null,
      consumed: false,
    };
    intents.set(record.intentId, record);
    await persist();
    logger?.info?.(`[bridge] 导入意图 ${record.intentId} · ${origin}`);
    return meta(record);
  }

  async function list() {
    await load();
    return [...intents.values()]
      .filter((record) => !record.consumed)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(meta);
  }

  /**
   * 抢占一张凭条：多窗口同时打开时只有一个能拿到。
   * 拿不到就明确说被别人领走了，不假装成功。
   */
  async function claim({ intentId, claimer }) {
    await load();
    const id = sanitizeId(intentId);
    if (!id) throw bridgeError("invalid_request", "intentId 不合法");
    const record = intents.get(id);
    if (!record) throw bridgeError("action_expired", "导入请求不存在");
    if (record.consumed) throw bridgeError("action_already_used", "导入请求已使用");
    const who = String(claimer || "").slice(0, 120);
    // 领取要有租约：崩溃、断电、进程被杀时，claim 不会自己放手，
    // 没租约的话那张凭条就被一个再也不会回来的随机 canvasId 永久占住。
    const leaseExpired = typeof record.claimedAt === "number"
      && clock() - record.claimedAt > CLAIM_LEASE_MS;
    if (record.claimedBy && record.claimedBy !== who && !leaseExpired) {
      throw bridgeError("action_already_used", "导入请求已被另一个窗口领取");
    }
    record.claimedBy = who;
    record.claimedAt = clock();
    await persist();
    return meta(record);
  }

  /** 只有在内容真正落进画布并保存成功之后才 ack */
  async function ack({ intentId, claimer }) {
    await load();
    const id = sanitizeId(intentId);
    const record = intents.get(id);
    if (!record) throw bridgeError("action_expired", "导入请求不存在");
    const who = String(claimer || "").slice(0, 120);
    if (record.claimedBy && record.claimedBy !== who) {
      // 租约过期被别人接管后，原窗口的迟到 ACK 必须被拒
      const leaseExpired = typeof record.claimedAt === "number"
        && clock() - record.claimedAt > CLAIM_LEASE_MS;
      if (!leaseExpired) {
        throw bridgeError("action_already_used", "导入请求属于另一个窗口");
      }
    }
    record.claimedAt = clock();
    record.consumed = true;
    await persist();
    return meta(record);
  }

  /** 放弃抢占：把 claimedBy 放回去，让别的窗口还能用 */
  async function release({ intentId, claimer }) {
    await load();
    const record = intents.get(sanitizeId(intentId));
    if (!record || record.consumed) return null;
    if (record.claimedBy === String(claimer || "").slice(0, 120)) {
      record.claimedBy = null;
      await persist();
    }
    return meta(record);
  }

  return { load, enqueue, list, claim, ack, release, _intents: intents };
}

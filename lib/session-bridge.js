/**
 * 本体会话桥：只走公开 SDK 总线，不读会话文件、不走宿主内部 HTTP。
 *
 * 设计要点：
 * - 只读优先。查询、预览、导入全都不产生副作用。
 * - 一切身份来自宿主回包；App 不自己拼 sessionPath，也不信前端自报的来源。
 * - 权限拒绝要说清楚缺哪一条、去哪儿开，而不是抛个笼统错误。
 */
import {
  BRIDGE_ERRORS,
  BRIDGE_LIMITS,
  bridgeError,
  buildEntryTree,
  buildSourceRef,
  composeImportText,
  estimateBytes,
  projectHistory,
  projectTreePath,
  sanitizeId,
  sanitizeTitle,
} from "./bridge-contract.js";

/** 本功能用到的能力词与它们的用途，报错时按这张表说话 */
const CAPABILITY_LABELS = Object.freeze({
  "app/sessions.read": "读取本体会话",
  "app/sessions.manage": "向本体会话投递",
  "app/session.start-turn": "让投递的内容触发一轮对话",
  "app/session.stage-file": "把文件交付到本体会话",
});

const READ_GRANTED_STATES = new Set(["always", "session"]);

export function createSessionBridge({ bus, logger }) {
  // 构造时不抛错：没有总线的环境（比如裁过的测试宿主）应该能加载，
  // 真正用到的时候再说清楚缺什么。
  const requireBus = () => {
    if (!bus || typeof bus.request !== "function") {
      throw bridgeError("surface_unsupported", "当前宿主没有提供会话总线");
    }
    return bus;
  };

  /** 能力账本：只回答本应用自己的授予情况 */
  async function readCapabilities({ sessionId } = {}) {
    try {
      const payload = sessionId ? { sessionId } : undefined;
      const result = await requireBus().request("app:capabilities", payload);
      const rows = Array.isArray(result?.capabilities) ? result.capabilities : [];
      const map = {};
      for (const row of rows) {
        if (row && typeof row.capability === "string") {
          map[row.capability] = {
            status: typeof row.status === "string" ? row.status : "not_asked",
            enforcement: typeof row.enforcement === "string" ? row.enforcement : "hard",
          };
        }
      }
      return map;
    } catch (err) {
      logger?.warn?.(`[bridge] 读取能力账本失败：${err?.message || String(err)}`);
      return {};
    }
  }

  function has(map, capability) {
    const row = map?.[capability];
    return Boolean(row) && READ_GRANTED_STATES.has(row.status);
  }

  function requireCapability(map, capability) {
    if (has(map, capability)) return;
    const label = CAPABILITY_LABELS[capability] || capability;
    throw bridgeError("permission_missing", `${capability}（${label}）`);
  }

  /** 把总线抛出的原始错误收敛成稳定错误码，别把宿主内部文案透出去 */
  function mapBusError(err, fallback = "invalid_request") {
    const message = String(err?.message || err || "");
    if (/permission|denied|not permitted|EACCES|403/i.test(message)) return bridgeError("permission_missing", null);
    if (/not found|ENOENT|404|不存在/i.test(message)) return bridgeError("session_not_found", null);
    if (/too large|EMSGSIZE|exceeds|413|超限/i.test(message)) return bridgeError("source_too_large", null);
    return bridgeError(fallback, message.slice(0, 160) || null);
  }

  /**
   * 会话列表：默认只要宿主正常会话（ownerPluginId 为空），
   * 不把别的 App 的私有会话混进来，也不返回路径与提示词。
   */
  async function listSessions({ lifecycle = "active", limit = 50 } = {}) {
    const caps = await readCapabilities();
    requireCapability(caps, "app/sessions.read");
    let result;
    try {
      result = await requireBus().request("session:list", { scope: "all", lifecycle });
    } catch (err) {
      throw mapBusError(err);
    }
    const rows = Array.isArray(result?.sessions) ? result.sessions : [];
    const sessions = rows
      .filter((row) => row && (row.ownerPluginId === null || row.ownerPluginId === undefined))
      .map((row) => ({
        sessionId: sanitizeId(row.sessionId),
        title: sanitizeTitle(row.title || row.firstMessage || ""),
        agentName: sanitizeTitle(row.agentName || ""),
        messageCount: Number.isFinite(row.messageCount) ? row.messageCount : null,
        modified: typeof row.modified === "string" || typeof row.modified === "number" ? row.modified : null,
        lifecycle: row.lifecycle === "archived" ? "archived" : "active",
      }))
      .filter((row) => row.sessionId)
      .slice(0, Math.max(1, Math.min(limit, BRIDGE_LIMITS.historyMax)));
    return { sessions, total: sessions.length };
  }

  /** 单个会话的身份复核：回包里必须有 sessionId，且和我们请求的一致 */
  async function resolveSession(sessionId) {
    const safe = sanitizeId(sessionId);
    if (!safe) throw bridgeError("session_not_addressable");
    let result;
    try {
      result = await requireBus().request("session:get", { sessionId: safe, scope: "all" });
    } catch (err) {
      throw mapBusError(err);
    }
    const session = result?.session;
    if (!session) throw bridgeError("session_not_found");
    const resolvedId = sanitizeId(session.sessionId);
    if (!resolvedId || resolvedId !== safe) throw bridgeError("session_not_addressable");
    if (session.ownerPluginId) throw bridgeError("session_not_addressable", "不是宿主正常会话");
    return {
      sessionId: resolvedId,
      title: sanitizeTitle(session.title || session.firstMessage || ""),
      agentName: sanitizeTitle(session.agentName || ""),
      messageCount: Number.isFinite(session.messageCount) ? session.messageCount : null,
      lifecycle: session.lifecycle === "archived" ? "archived" : "active",
    };
  }

  /** 运行状态：只投影"在不在生成"，绝不把 systemPrompt 交给 UI */
  async function readStatus(sessionId) {
    const safe = sanitizeId(sessionId);
    if (!safe) throw bridgeError("session_not_addressable");
    try {
      const result = await requireBus().request("session:context", { sessionId: safe, scope: "all" });
      return {
        isStreaming: result?.isStreaming === true,
        isCompacting: result?.isCompacting === true,
        pendingMessageCount: Number.isFinite(result?.pendingMessageCount) ? result.pendingMessageCount : null,
      };
    } catch (err) {
      if (err?.code === "permission_missing") throw err;
      logger?.debug?.(`[bridge] 读取运行状态失败：${err?.message || String(err)}`);
      return { isStreaming: false, isCompacting: false, pendingMessageCount: null, unknown: true };
    }
  }

  /** 有限历史预览（优先使用 session:entries 从当前活动叶节点回溯，确保导入的是最新对话） */
  async function previewHistory({ sessionId, limit = BRIDGE_LIMITS.historyDefault }) {
    const caps = await readCapabilities();
    requireCapability(caps, "app/sessions.read");
    const session = await resolveSession(sessionId);
    const bus = requireBus();
    const requested = Math.min(
      Math.max(Number.isInteger(limit) ? limit : BRIDGE_LIMITS.historyDefault, 1),
      BRIDGE_LIMITS.historyMax,
    );

    let messages = null;
    let truncated = false;
    let available = 0;
    let droppedCount = 0;
    let activeLeafId = null;

    // 优先尝试 session:entries：宿主 session:history 存在只从第0条正向截断的缺陷，
    // 而 session:entries 返回完整条目树与当前活动叶节点 (leafId)，能精确还原包括最新消息在内的当前分支历史。
    try {
      const entriesResult = await bus.request("session:entries", { sessionId: session.sessionId, scope: "all" });
      if (Array.isArray(entriesResult?.entries) && entriesResult.entries.length > 0) {
        const tree = buildEntryTree(entriesResult.entries);
        if (!tree.cyclicIds.length && tree.nodeCount > 0) {
          let targetLeaf = sanitizeId(entriesResult?.leafId);
          if (!targetLeaf || !tree.nodes.has(targetLeaf)) {
            const leaves = [...tree.nodes.values()].filter((n) => n.children.length === 0);
            if (leaves.length > 0) {
              leaves.sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
              targetLeaf = leaves[0].id;
            }
          }
          if (targetLeaf) {
            const path = projectTreePath(tree, targetLeaf);
            if (path && Array.isArray(path.messages) && path.messages.length > 0) {
              available = path.messages.length;
              messages = path.messages.slice(-requested);
              truncated = available > messages.length;
              droppedCount = path.droppedCount;
              activeLeafId = targetLeaf;
            }
          }
        }
      }
    } catch (err) {
      if (err?.code === "permission_missing") throw err;
      logger?.debug?.(`[bridge] session:entries 读取失败，降级到 session:history: ${err?.message || String(err)}`);
    }

    // 降级回 session:history（例如测试环境或老版本宿主）
    if (!messages) {
      let result;
      try {
        result = await bus.request("session:history", { sessionId: session.sessionId, limit: requested, scope: "all" });
      } catch (err) {
        throw mapBusError(err);
      }
      const projected = projectHistory(result?.messages, { limit: requested });
      messages = projected.messages;
      truncated = projected.truncated;
      available = projected.available;
      droppedCount = projected.droppedCount;
    }

    const status = await readStatus(session.sessionId);
    const preview = {
      kind: "history",
      session,
      messages,
      truncated,
      available,
      droppedCount,
      leafId: activeLeafId,
      status,
    };
    if (estimateBytes(preview) > BRIDGE_LIMITS.previewMaxBytes) {
      throw bridgeError("source_too_large", "历史预览超过 1 MiB，请减小读取条数");
    }
    return preview;
  }

  /** 完整树预览：只在用户明确要求时才读 entries */
  async function previewTree({ sessionId, leafId = null }) {
    const caps = await readCapabilities();
    requireCapability(caps, "app/sessions.read");
    const session = await resolveSession(sessionId);
    let result;
    try {
      result = await requireBus().request("session:entries", { sessionId: session.sessionId, scope: "all" });
    } catch (err) {
      throw mapBusError(err);
    }
    const tree = buildEntryTree(result?.entries);
    if (tree.cyclicIds.length) throw bridgeError("invalid_request", "条目树存在环状关系，已停止解析");
    if (!tree.nodeCount) throw bridgeError("session_not_found", "该会话没有可读取的条目");

    // 分叉点在任何一个节点上，不在根层。按叶节点数算分支才对。
    const leafIds = [...tree.nodes.values()].filter((node) => node.children.length === 0).map((node) => node.id);
    const branches = leafIds.map((leafId) => {
      const path = projectTreePath(tree, leafId);
      return {
        rootId: path ? path.entryIds[0] : null,
        leafId,
        nodeCount: path ? path.entryIds.length : 0,
        messageCount: path ? path.messages.length : 0,
        lastText: path ? (path.messages.at(-1)?.text || "").slice(0, 160) : "",
      };
    });

    const chosenLeaf = sanitizeId(leafId) || (leafIds.length === 1 ? leafIds[0] : null);
    const projected = chosenLeaf ? projectTreePath(tree, chosenLeaf) : null;
    const status = await readStatus(session.sessionId);
    const preview = {
      kind: "tree",
      session,
      rootCount: tree.roots.length,
      nodeCount: tree.nodeCount,
      skippedCount: tree.skippedCount,
      danglingParents: tree.danglingParents.length,
      branches,
      leafId: chosenLeaf,
      messages: projected?.messages || [],
      entryIds: projected?.entryIds || [],
      droppedCount: projected?.droppedCount || 0,
      needsLeafChoice: !chosenLeaf && leafIds.length > 1,
      status,
    };
    if (estimateBytes(preview) > BRIDGE_LIMITS.previewMaxBytes) {
      throw bridgeError("source_too_large", "条目树预览超过 1 MiB，请先选定一条分支");
    }
    return preview;
  }

  /**
   * 统一预览入口。
   * kind: 'message' | 'history' | 'tree-path'
   */
  async function preview({ sessionId, kind = "history", leafId = null, limit }) {
    if (kind === "history") return previewHistory({ sessionId, limit });
    if (kind === "tree-path") return previewTree({ sessionId, leafId });
    // 单条消息走 history 预览里选，这里不另开一条路径，避免两套语义
    if (kind === "message") throw bridgeError("invalid_request", "单条消息请先用 history 预览选条");
    throw bridgeError("invalid_request", `未知的预览类型 ${kind}`);
  }

  /** 由预览结果组装来源引用 */
  function sourceRefFromPreview(previewResult, { messages, entryIds = [], leafId = null, importKind }) {
    return buildSourceRef({
      sessionId: previewResult.session.sessionId,
      entryIds,
      leafId,
      titleAtImport: previewResult.session.title,
      importKind,
      messages: messages || previewResult.messages || [],
    });
  }

  return {
    readCapabilities,
    has,
    requireCapability,
    listSessions,
    resolveSession,
    readStatus,
    previewHistory,
    previewTree,
    preview,
    sourceRefFromPreview,
    composeImportText,
    BRIDGE_ERRORS,
  };
}

/**
 * 桥接契约：只放纯函数与常量，不碰 SDK、不碰 DOM、不碰文件系统。
 *
 * 这里定的是两侧交接的边界：宿主给什么算可信、什么字段允许进 App、
 * 什么样的会话内容可以给用户看、来源引用长什么样。
 * 所有判断都写成可单测的函数，面板与服务端共用同一套。
 */

/** 统一错误码：前后端、日志、界面提示都用这一份，不各说各话 */
export const BRIDGE_ERRORS = Object.freeze({
  permission_missing: "缺少所需权限",
  surface_unsupported: "当前窗口不支持读取本体会话",
  session_not_found: "会话不存在或已归档",
  session_not_addressable: "缺少可用的会话标识",
  entry_not_mappable: "无法把该消息映射到原生条目",
  source_too_large: "来源内容超过可读取上限",
  preview_truncated: "预览已截断",
  canvas_quota: "画布容量不足",
  save_conflict: "保存冲突",
  action_expired: "回传动作已过期",
  action_already_used: "回传动作已使用",
  action_unknown: "投递结果未知",
  outbox_persist_failed: "回传记录保存失败",
  outbox_full: "回传动作已达上限",
  dispatch_failed: "投递失败",
  invalid_request: "请求不合法",
  invalid_source_ref: "来源引用不合法",
});

export class BridgeError extends Error {
  constructor(code, detail) {
    const base = BRIDGE_ERRORS[code] || "桥接失败";
    super(detail ? `${base}：${detail}` : base);
    this.name = "BridgeError";
    this.code = code;
    this.detail = detail || null;
  }
}

export function bridgeError(code, detail) {
  return new BridgeError(code, detail);
}

/** 尺寸与条数上限：都在这里定，别散落在各处 */
export const BRIDGE_LIMITS = Object.freeze({
  historyDefault: 50,
  historyMax: 200,
  /** 单条消息正文给 UI 的上限 */
  messageMaxChars: 200_000,
  /** 一次预览回包的总字节上限 */
  previewMaxBytes: 1024 * 1024,
  /** 待回传文本上限 */
  textMaxBytes: 64 * 1024,
  /** Outbox 元数据上限 */
  outboxMaxBytes: 256 * 1024,
  outboxMaxActions: 64,
  /** 回传动作有效期 */
  actionTtlMs: 30 * 60 * 1000,
  /** 导出文件上限 */
  exportMaxBytes: 2 * 1024 * 1024,
  /** 来源引用里 entryIds 的条数上限 */
  sourceMaxEntries: 512,
  idMaxLength: 200,
  titleMaxLength: 300,
});

const ID_RE = /^[\w.:@~+-]{1,200}$/;

/**
 * 宿主给的 ID 一律当不透明字符串，只做类型、长度、字符集检查。
 * 不假设是 UUID，也不按分隔符切它。
 */
export function sanitizeId(value, field = "id") {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > BRIDGE_LIMITS.idMaxLength) return null;
  if (!ID_RE.test(trimmed)) return null;
  void field;
  return trimmed;
}

export function sanitizeTitle(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, BRIDGE_LIMITS.titleMaxLength);
}

/** 正文截断：明说截断了多少，不假装完整 */
export function truncateText(text, max = BRIDGE_LIMITS.messageMaxChars) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= max) return { text: value, truncated: false, originalLength: value.length };
  return { text: value.slice(0, max), truncated: true, originalLength: value.length };
}

/** 稳定哈希：只对白名单投影后的正文算，不掺时间戳 */
export function computeContentHash(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  const payload = list
    .filter((item) => typeof item === "string")
    .join("\u0000");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < payload.length; i += 1) {
    const code = payload.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + code * (i + 1)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * 把宿主 history 的一条消息投影成白名单结构。
 * thinking / toolCalls / images 一律不进 App —— 不是"先带上再说"。
 */
export function projectHistoryMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "user" || raw.role === "assistant" ? raw.role : null;
  if (!role) return null;
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!content) return null;
  const { text, truncated, originalLength } = truncateText(content);
  const dropped = {};
  if (Array.isArray(raw.images) && raw.images.length) dropped.images = raw.images.length;
  if (typeof raw.thinking === "string" && raw.thinking) dropped.thinking = 1;
  if (Array.isArray(raw.toolCalls) && raw.toolCalls.length) dropped.toolCalls = raw.toolCalls.length;
  const entryId = sanitizeId(raw.entryId);
  return {
    role,
    text,
    entryId,
    truncated,
    originalLength,
    dropped: Object.keys(dropped).length ? dropped : null,
    /** 没有原生 entryId 的消息只展示，不参与定位与去重 */
    addressable: Boolean(entryId),
  };
}

/**
 * 投影一段 history。
 * @returns {{messages: object[], truncated: boolean, requested: number, available: number}}
 */
export function projectHistory(rawMessages, { limit = BRIDGE_LIMITS.historyDefault } = {}) {
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  const requested = Math.min(
    Math.max(Number.isInteger(limit) ? limit : BRIDGE_LIMITS.historyDefault, 1),
    BRIDGE_LIMITS.historyMax,
  );
  // 取最后 N 条：对话的尾部才是用户要看的地方
  const slice = list.slice(-requested);
  const messages = slice.map(projectHistoryMessage).filter(Boolean);
  return {
    messages,
    truncated: list.length > slice.length,
    requested,
    available: list.length,
    droppedCount: list.length - messages.length,
  };
}

export const ENTRY_KIND = Object.freeze({
  message: "message",
  other: "other",
});

const KNOWN_ROLES = new Set(["user", "assistant"]);

/** 从一个 entry 里尽力取稳定标识与父子关系，取不到就算未知节点 */
function readEntryMeta(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const id = sanitizeId(raw.id) || sanitizeId(raw.entryId) || sanitizeId(raw.entry_id);
  if (!id) return null;
  const parentRaw = raw.parentId ?? raw.parent_id ?? raw.parent ?? null;
  const parentId = parentRaw === null ? null : sanitizeId(parentRaw);
  const rawRole = raw.role || raw.message?.role || null;
  const role = KNOWN_ROLES.has(rawRole) ? rawRole : null;
  const type = typeof raw.type === "string" ? raw.type : null;
  return { id, parentId, role, type, index };
}

/** 从 entry 里取可见正文；取不到就返回空串，不猜 */
function readEntryText(raw) {
  if (!raw || typeof raw !== "object") return "";
  const content = raw.content ?? raw.text ?? raw.message?.content ?? raw.message?.text ?? null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (part.type === "thinking" || part.type === "toolCall" || part.type === "toolResult") return "";
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.parts)) {
      return content.parts
        .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n\n");
    }
  }
  return "";
}

/**
 * 把宿主 entries 还原成树。
 * 节点、父子边、根、叶全部按宿主给的关系走，绝不靠文本相似度补边。
 * 环、重复 ID、悬空父节点都明确报出来。
 */
export function buildEntryTree(rawEntries) {
  const list = Array.isArray(rawEntries) ? rawEntries : [];
  const nodes = new Map();
  const skipped = [];
  const duplicates = [];

  list.forEach((raw, index) => {
    const meta = readEntryMeta(raw, index);
    if (!meta) {
      skipped.push(index);
      return;
    }
    if (nodes.has(meta.id)) {
      duplicates.push(meta.id);
      return;
    }
    const text = readEntryText(raw);
    const projected = text
      ? (() => {
          const { text: kept, truncated, originalLength } = truncateText(text);
          return { text: kept, truncated, originalLength };
        })()
      : null;
    nodes.set(meta.id, {
      id: meta.id,
      parentId: meta.parentId,
      role: meta.role,
      type: meta.type,
      kind: meta.role ? ENTRY_KIND.message : ENTRY_KIND.other,
      text: projected,
      children: [],
      index: meta.index,
    });
  });

  // 悬空父节点：把边降级成根，并记下来
  const danglingParents = [];
  for (const node of nodes.values()) {
    if (!node.parentId) continue;
    if (!nodes.has(node.parentId)) {
      danglingParents.push(node.id);
      node.parentId = null;
    }
  }

  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentId) nodes.get(node.parentId).children.push(node.id);
    else roots.push(node.id);
  }

  // 环检测：从每个节点往上走，步数超过节点总数必是环
  const cyclic = [];
  for (const node of nodes.values()) {
    let cursor = node;
    let steps = 0;
    const seen = new Set([node.id]);
    while (cursor.parentId && steps <= nodes.size) {
      if (seen.has(cursor.parentId)) {
        cyclic.push(node.id);
        break;
      }
      seen.add(cursor.parentId);
      cursor = nodes.get(cursor.parentId);
      if (!cursor) break;
      steps += 1;
    }
  }

  return {
    nodes,
    roots,
    skippedCount: skipped.length,
    duplicateIds: duplicates,
    danglingParents,
    cyclicIds: [...new Set(cyclic)],
    nodeCount: nodes.size,
  };
}

/**
 * 从叶节点往根走，得到一条分支路径（根在前）。
 * 找不到叶节点或路径断掉时返回 null，不返回半截路径。
 */
export function resolveTreePath(tree, leafId) {
  if (!tree?.nodes || !leafId) return null;
  const path = [];
  let cursor = tree.nodes.get(leafId);
  if (!cursor) return null;
  let steps = 0;
  while (cursor) {
    path.unshift(cursor.id);
    if (!cursor.parentId) break;
    cursor = tree.nodes.get(cursor.parentId);
    steps += 1;
    if (steps > tree.nodes.size) return null;
  }
  return path;
}

/** 列出一条分支上的可导入消息（只读投影） */
export function projectTreePath(tree, leafId) {
  const path = resolveTreePath(tree, leafId);
  if (!path) return null;
  const messages = [];
  let droppedCount = 0;
  for (const id of path) {
    const node = tree.nodes.get(id);
    if (!node) return null;
    if (node.kind !== ENTRY_KIND.message || !node.text) {
      droppedCount += 1;
      continue;
    }
    messages.push({
      role: node.role,
      text: node.text.text,
      entryId: node.id,
      truncated: node.text.truncated,
      originalLength: node.text.originalLength,
      dropped: null,
      addressable: true,
    });
  }
  return { entryIds: path, messages, droppedCount };
}

/** 来源引用：卡片的可选字段，也是跳回与去重的依据 */
export function buildSourceRef({
  sessionId,
  entryIds,
  leafId = null,
  titleAtImport = "",
  importKind,
  messages,
  importedAt = new Date().toISOString(),
}) {
  const safeSessionId = sanitizeId(sessionId);
  if (!safeSessionId) throw bridgeError("invalid_source_ref", "缺少 sessionId");
  const safeEntryIds = (Array.isArray(entryIds) ? entryIds : [])
    .map((id) => sanitizeId(id))
    .filter(Boolean)
    .slice(0, BRIDGE_LIMITS.sourceMaxEntries);
  const safeLeaf = sanitizeId(leafId);
  if (!["message", "history", "tree-path"].includes(importKind)) {
    throw bridgeError("invalid_source_ref", "importKind 不合法");
  }
  const hashParts = (Array.isArray(messages) ? messages : []).map((m) => `${m.role}:${m.text}`);
  return {
    version: 1,
    kind: "hana-session",
    sessionId: safeSessionId,
    entryIds: safeEntryIds,
    leafId: safeLeaf,
    titleAtImport: sanitizeTitle(titleAtImport),
    importedAt,
    contentHash: computeContentHash(hashParts),
    importKind,
  };
}

/** 校验从存储里读回来的来源引用；坏数据当没有，不让它污染画布 */
export function validateSourceRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  if (ref.version !== 1 || ref.kind !== "hana-session") return null;
  const sessionId = sanitizeId(ref.sessionId);
  if (!sessionId) return null;
  const importKind = ["message", "history", "tree-path"].includes(ref.importKind) ? ref.importKind : null;
  if (!importKind) return null;
  return {
    version: 1,
    kind: "hana-session",
    sessionId,
    entryIds: (Array.isArray(ref.entryIds) ? ref.entryIds : [])
      .map((id) => sanitizeId(id))
      .filter(Boolean)
      .slice(0, BRIDGE_LIMITS.sourceMaxEntries),
    leafId: sanitizeId(ref.leafId),
    titleAtImport: sanitizeTitle(ref.titleAtImport),
    importedAt: typeof ref.importedAt === "string" ? ref.importedAt.slice(0, 40) : "",
    contentHash: typeof ref.contentHash === "string" ? ref.contentHash.slice(0, 32) : "",
    importKind,
  };
}

/** 去重键：会话 + 条目 + 叶 + 方式 + 正文哈希 */
export function sourceRefKey(ref) {
  const safe = validateSourceRef(ref);
  if (!safe) return null;
  const ids = [...safe.entryIds].sort().join(",");
  return [safe.sessionId, ids, safe.leafId || "-", safe.importKind, safe.contentHash].join("|");
}

export function isSameImport(a, b) {
  const ka = sourceRefKey(a);
  const kb = sourceRefKey(b);
  return Boolean(ka) && ka === kb;
}

/** 同一来源但正文变了：提示建新快照，不覆盖用户的修改 */
export function isSameOriginDifferentContent(a, b) {
  const sa = validateSourceRef(a);
  const sb = validateSourceRef(b);
  if (!sa || !sb) return false;
  if (sa.sessionId !== sb.sessionId) return false;
  if (sa.importKind !== sb.importKind) return false;
  if (sa.entryIds.join(",") !== sb.entryIds.join(",")) return false;
  return sa.contentHash !== sb.contentHash;
}

/** 组装导入用的纯文本快照正文 */
export function composeImportText(messages, { title = "", importKind = "history" } = {}) {
  const head = title ? `# ${sanitizeTitle(title)}\n\n` : "";
  const body = (Array.isArray(messages) ? messages : [])
    .map((m) => `【${m.role === "user" ? "用户" : "助手"}】${m.text}`)
    .join("\n\n");
  const note = "> 本体导入快照。此处为只读摘录，不代表原会话仍在同步。\n\n";
  void importKind;
  return `${head}${note}${body}`;
}

/** 估算预览回包大小，超限前就拦，别等宿主拒 */
export function estimateBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

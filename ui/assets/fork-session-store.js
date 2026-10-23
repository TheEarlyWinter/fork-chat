/**
 * fork-session-store.js
 * App 自有分叉会话管理模块。
 * 遵循 Hana APPS.md 存储规范：
 * 1. 使用 hana.storage.global（宿主原子落盘，owner-only，不伪造 user 分区，不建自定义 HTTP 后端）；
 * 2. 使用 Web Locks API 串行化读-修订-写事务；无 locks 写入显式抛 STORAGE_LOCK_UNAVAILABLE；
 * 3. 根键 'fork-chat.sessions.v1'，版本 1，上限 100 个会话，单文档 JSON 上限 12MB；
 * 4. 纯函数 normalizeForkSnapshot 白名单深拷贝与断流截断，杜绝污染与未完成状态残留。
 */

import { normalizeContextRefs } from './fork-context-policy.js';

export const FORK_SESSION_STORAGE_KEY = "fork-chat.sessions.v1";
export const STORAGE_MAX_SESSIONS = 100;
export const STORAGE_MAX_BYTES = 12 * 1024 * 1024; // 12MB
export const STORE_LOCK_NAME = "fork-chat-session-store-v1";

const ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;

/** 只有这两种根版本能读；写出去永远是当前版本 */
export const STORE_VERSION = 2;
export const READABLE_STORE_VERSIONS = Object.freeze([1, 2]);

function parentIdsOf(card) {
  return Array.from(new Set([
    ...(card?.parentId ? [card.parentId] : []),
    ...(Array.isArray(card?.parentIds) ? card.parentIds : []),
  ]));
}

function createError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function unwrapStorageValue(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value;
  }
  return result;
}

/**
 * 校验并清洗会话标题：空白压缩+trim、非空、<=80 UTF16字符、拒绝剩余控制字符
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeSessionTitle(raw) {
  if (typeof raw !== "string") {
    throw createError("INVALID_SESSION_TITLE", "Title must be a string");
  }
  const compressed = raw.trim().replace(/\s+/g, " ");
  if (compressed.length === 0) {
    throw createError("INVALID_SESSION_TITLE", "Title cannot be empty");
  }
  if (compressed.length > 80) {
    throw createError("INVALID_SESSION_TITLE", "Title exceeds maximum length of 80 characters");
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(compressed)) {
    throw createError("INVALID_SESSION_TITLE", "Title contains illegal control characters");
  }
  return compressed;
}

/**
 * 自动提取标题：取卡片树中第一条 user 文本，压缩空白并截取前 40 字符，否则回退 '新会话'
 * @param {object} snapshot
 * @returns {string}
 */
export function generateAutoTitle(snapshot) {
  if (snapshot && Array.isArray(snapshot.cards)) {
    for (const card of snapshot.cards) {
      if (Array.isArray(card.messages)) {
        for (const msg of card.messages) {
          if (msg && msg.role === "user" && typeof msg.text === "string") {
            const compressed = msg.text.trim().replace(/\s+/g, " ");
            if (compressed) {
              return compressed.slice(0, 40);
            }
          }
        }
      }
    }
  }
  return "新会话";
}

/**
 * 校验并深度克隆 Snapshot，不修改传入的活对象。
 * @param {any} input
 * @returns {object} normalizedSnapshot
 */
/** 单卡文档正文上限：与 MinerU 的 MAX_MARKDOWN_CHARS 对齐 */
export const DOC_CONTENT_MAX_CHARS = 2000000;
/** 单个附件正文上限 */
export const ATTACHMENT_MAX_CHARS = 1000000;
/**
 * 盖戳的合法取值。真实循环是 无 → starred → accepted → rejected → 无，
 * 这里少写一档就等于每次重开都把那一档重置掉。
 */
export const STATUS_STAMPS = Object.freeze(['starred', 'accepted', 'rejected']);

/**
 * 会话级引用身份校验：整个快照里 ref.id 必须唯一。
 * 单卡内去重不够——跨卡撞 ID 会让"按 ID 去重"的历史预算前提失效。
 */
function assertSnapshotRefIdentity(cards) {
  const seen = new Map();
  for (const card of cards) {
    const refs = Array.isArray(card?.contextRefs) ? card.contextRefs : [];
    for (const ref of refs) {
      const previous = seen.get(ref.id);
      if (previous) {
        const sameContent = previous.sourceCardId === ref.sourceCardId && previous.text === ref.text;
        throw createError(
          'INVALID_SESSION_SNAPSHOT',
          sameContent
            ? `引用 id ${ref.id} 在同一会话里出现了两次`
            : `引用 id ${ref.id} 被两张卡用于不同内容（${previous.owner} / ${card.id}）`,
        );
      }
      seen.set(ref.id, { sourceCardId: ref.sourceCardId, text: ref.text, owner: card.id });
    }
  }
}

export function normalizeForkSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createError("INVALID_SESSION_SNAPSHOT", "Snapshot must be a valid non-null object");
  }

  // 1. 校验视口 view
  const rawView = input.view;
  if (!rawView || typeof rawView !== "object" || Array.isArray(rawView)) {
    throw createError("INVALID_SESSION_SNAPSHOT", "Snapshot.view must be a valid object");
  }
  const x = Number(rawView.x);
  const y = Number(rawView.y);
  const scale = Number(rawView.scale);

  if (!Number.isFinite(x) || x < -1e6 || x > 1e6) {
    throw createError("INVALID_SESSION_SNAPSHOT", "view.x must be a finite number between -1e6 and 1e6");
  }
  if (!Number.isFinite(y) || y < -1e6 || y > 1e6) {
    throw createError("INVALID_SESSION_SNAPSHOT", "view.y must be a finite number between -1e6 and 1e6");
  }
  if (!Number.isFinite(scale) || scale < 0.4 || scale > 2.2) {
    throw createError("INVALID_SESSION_SNAPSHOT", "view.scale must be a finite number between 0.4 and 2.2");
  }

  const normalizedView = { x, y, scale };

  // 2. 校验 agent 字段
  const normalizedAgent = {};
  if (input.agent && typeof input.agent === "object" && !Array.isArray(input.agent)) {
    if (typeof input.agent.id === "string") normalizedAgent.id = input.agent.id.slice(0, 200);
    if (typeof input.agent.name === "string") normalizedAgent.name = input.agent.name.slice(0, 200);
    if (typeof input.agent.model === "string") normalizedAgent.model = input.agent.model.slice(0, 200);
    if (typeof input.agent.provider === "string") normalizedAgent.provider = input.agent.provider.slice(0, 200);
    if (typeof input.agent.reasoningEffort === "string") normalizedAgent.reasoningEffort = input.agent.reasoningEffort.slice(0, 50);
  }

  // 3. 校验 cards 数组
  if (!Array.isArray(input.cards)) {
    throw createError("INVALID_SESSION_SNAPSHOT", "Snapshot.cards must be an array");
  }
  if (input.cards.length > 300) {
    throw createError("INVALID_SESSION_SNAPSHOT", "Snapshot.cards count exceeds maximum limit of 300");
  }

  const cardIds = new Set();
  const cardMap = new Map();
  let totalMessagesCount = 0;
  const normalizedCards = [];

  for (const rawCard of input.cards) {
    if (!rawCard || typeof rawCard !== "object" || Array.isArray(rawCard)) {
      throw createError("INVALID_SESSION_SNAPSHOT", "Card item must be a valid object");
    }

    const cardId = rawCard.id;
    if (typeof cardId !== "string" || !ID_REGEX.test(cardId)) {
      throw createError("INVALID_SESSION_SNAPSHOT", `Invalid card id: ${cardId}`);
    }
    if (cardIds.has(cardId)) {
      throw createError("INVALID_SESSION_SNAPSHOT", `Duplicate card id: ${cardId}`);
    }
    cardIds.add(cardId);

    // parentId 校验
    let parentId = null;
    if (rawCard.parentId !== undefined && rawCard.parentId !== null) {
      if (typeof rawCard.parentId !== "string" || !ID_REGEX.test(rawCard.parentId)) {
        throw createError("INVALID_SESSION_SNAPSHOT", `Invalid parentId: ${rawCard.parentId}`);
      }
      if (rawCard.parentId === cardId) {
        throw createError("INVALID_SESSION_SNAPSHOT", `Card cannot be its own parent: ${cardId}`);
      }
      parentId = rawCard.parentId;
    }

    // requestId 校验（可选）
    let requestId = undefined;
    if (rawCard.requestId !== undefined && rawCard.requestId !== null) {
      if (typeof rawCard.requestId !== "string" || !ID_REGEX.test(rawCard.requestId)) {
        throw createError("INVALID_SESSION_SNAPSHOT", `Invalid card requestId: ${rawCard.requestId}`);
      }
      requestId = rawCard.requestId;
    }

    // 坐标与尺寸
    const cardX = Number(rawCard.x);
    const cardY = Number(rawCard.y);
    const cardWidth = Number(rawCard.width);

    if (!Number.isFinite(cardX) || cardX < -1e6 || cardX > 1e6) {
      throw createError("INVALID_SESSION_SNAPSHOT", `Card x coordinate out of range: ${cardX}`);
    }
    if (!Number.isFinite(cardY) || cardY < -1e6 || cardY > 1e6) {
      throw createError("INVALID_SESSION_SNAPSHOT", `Card y coordinate out of range: ${cardY}`);
    }
    if (!Number.isFinite(cardWidth) || cardWidth < 220 || cardWidth > 2000) {
      throw createError("INVALID_SESSION_SNAPSHOT", `Card width out of range [220, 2000]: ${cardWidth}`);
    }
    let cardHeight = undefined;
    if (rawCard.height !== undefined && rawCard.height !== null) {
      const parsedH = Number(rawCard.height);
      if (!Number.isFinite(parsedH) || parsedH < 180 || parsedH > 3000) {
        throw createError("INVALID_SESSION_SNAPSHOT", `Card height out of range [180, 3000]: ${parsedH}`);
      }
      cardHeight = Math.round(parsedH);
    }

    // draft 字段
    const draft = typeof rawCard.draft === "string" ? rawCard.draft : "";

    // 消息列表校验与归一化
    if (!Array.isArray(rawCard.messages)) {
      throw createError("INVALID_SESSION_SNAPSHOT", `Card messages must be an array: ${cardId}`);
    }

    const normalizedMessages = [];
    for (const rawMsg of rawCard.messages) {
      totalMessagesCount++;
      if (totalMessagesCount > 10000) {
        throw createError("INVALID_SESSION_SNAPSHOT", "Total messages count across cards exceeds maximum 10000");
      }

      if (!rawMsg || typeof rawMsg !== "object" || Array.isArray(rawMsg)) {
        throw createError("INVALID_SESSION_SNAPSHOT", "Message item must be a valid object");
      }

      // role 严格白名单
      if (rawMsg.role !== "user" && rawMsg.role !== "assistant") {
        throw createError("INVALID_SESSION_SNAPSHOT", `Invalid message role: ${rawMsg.role}`);
      }

      // text 原文保留
      if (typeof rawMsg.text !== "string") {
        throw createError("INVALID_SESSION_SNAPSHOT", "Message text must be a string");
      }

      const msg = {
        role: rawMsg.role,
        text: rawMsg.text,
      };

      if (typeof rawMsg.id === "string") {
        msg.id = rawMsg.id.slice(0, 100);
      }
      if (rawMsg.requestId !== undefined && rawMsg.requestId !== null) {
        if (typeof rawMsg.requestId !== 'string' || !ID_REGEX.test(rawMsg.requestId)) {
          throw createError('INVALID_SESSION_SNAPSHOT', 'Invalid message requestId');
        }
        msg.requestId = rawMsg.requestId;
      }
      if (rawMsg.localOnly !== undefined) {
        msg.localOnly = Boolean(rawMsg.localOnly);
      }
      if (rawMsg.asidesOpen !== undefined) {
        msg.asidesOpen = Boolean(rawMsg.asidesOpen);
      }
      if (typeof rawMsg.agentId === "string") {
        msg.agentId = rawMsg.agentId.slice(0, 200);
      }
      if (typeof rawMsg.agentName === "string") {
        msg.agentName = rawMsg.agentName.slice(0, 200);
      }
      if (typeof rawMsg.modelRef === "string") {
        msg.modelRef = rawMsg.modelRef.slice(0, 200);
      }
      // 资料预览可重算，但重开页面后必须能回来，否则卡片展开只剩空白
      if (typeof rawMsg.docPreview === "string") {
        msg.docPreview = rawMsg.docPreview.slice(0, 60000);
      }
      if (rawMsg.docMeta && typeof rawMsg.docMeta === "object") {
        msg.docMeta = {
          name: typeof rawMsg.docMeta.name === "string" ? rawMsg.docMeta.name.slice(0, 200) : "",
          size: typeof rawMsg.docMeta.size === "number" ? rawMsg.docMeta.size : 0,
          type: typeof rawMsg.docMeta.type === "string" ? rawMsg.docMeta.type.slice(0, 50) : "",
          charCount: typeof rawMsg.docMeta.charCount === "number" ? rawMsg.docMeta.charCount : 0,
          lineCount: typeof rawMsg.docMeta.lineCount === "number" ? rawMsg.docMeta.lineCount : 0,
          extension: typeof rawMsg.docMeta.extension === "string" ? rawMsg.docMeta.extension.slice(0, 50) : "",
        };
      }
      if (rawMsg.partial === true) msg.partial = true;

      if (Array.isArray(rawMsg.attachments)) {
        msg.attachments = rawMsg.attachments.slice(0, 10).map(att => ({
          name: typeof att?.name === 'string' ? att.name.slice(0, 200) : '',
          size: typeof att?.size === 'number' ? att.size : 0,
          extension: typeof att?.extension === 'string' ? att.extension.slice(0, 50) : '',
          charCount: typeof att?.charCount === 'number' ? att.charCount : 0,
          lineCount: typeof att?.lineCount === 'number' ? att.lineCount : 0,
          // 和暂存区用同一个上限。以前这里写死 30 万，暂存区已经放宽到 100 万，
          // 于是发出去的消息在刷新之后被悄悄切掉大半，且没有任何标记。
          content: typeof att?.content === 'string' ? att.content.slice(0, ATTACHMENT_MAX_CHARS) : '',
          preview: typeof att?.preview === 'string' ? att.preview.slice(0, 3000) : '',
        }));
      }

      // 关键：streaming=true 或 status waiting/generating 统一转换为已中断终态
      const isInterrupted =
        rawMsg.streaming === true ||
        rawMsg.status === "waiting" ||
        rawMsg.status === "generating";

      if (isInterrupted) {
        msg.status = "cancelled";
        msg.streaming = false;
        msg.failed = true;
        msg.error = "REQUEST_INTERRUPTED: 会话切换或页面关闭，中断的回复未完成。";
      } else {
        msg.streaming = false;
        if (typeof rawMsg.status === "string") {
          msg.status = rawMsg.status.slice(0, 100);
        }
        msg.failed = Boolean(rawMsg.failed);
        if (typeof rawMsg.error === "string") {
          msg.error = rawMsg.error.slice(0, 1000);
        }
      }

      normalizedMessages.push(msg);
    }

    const normCard = {
      id: cardId,
      title: typeof rawCard.title === 'string' ? rawCard.title.slice(0, 200) : '对话卡片',
      parentId,
      x: cardX,
      y: cardY,
      width: cardWidth,
      draft,
      messages: normalizedMessages,
    };
    if (typeof cardHeight === 'number') normCard.height = cardHeight;
    if (requestId) normCard.requestId = requestId;
    // 盖戳与折叠是用户的操作结果，丢了就等于每次重开都被重置
    if (STATUS_STAMPS.includes(rawCard.statusStamp)) {
      normCard.statusStamp = rawCard.statusStamp;
    }
    // 上下文策略：exclude 必须保留；refs 走白名单重建并冻结，越限直接抛错
    if (rawCard.contextMode === 'exclude') {
      normCard.contextMode = 'exclude';
    } else if (rawCard.contextMode !== undefined && rawCard.contextMode !== 'include') {
      throw createError('INVALID_SESSION_SNAPSHOT', `Unknown contextMode: ${String(rawCard.contextMode)}`);
    }
    if (rawCard.contextRefs !== undefined) {
      let refs;
      try {
        refs = normalizeContextRefs(rawCard.contextRefs, { ownerCardId: cardId });
      } catch (err) {
        throw createError('INVALID_SESSION_SNAPSHOT', `卡片 ${cardId} 的引用不合法：${err.message || String(err)}`);
      }
      if (refs) normCard.contextRefs = refs;
    }
    if (rawCard.isCollapsed === true) normCard.isCollapsed = true;
    if (rawCard.isMerge) normCard.isMerge = true;
    if (rawCard.isBattle) normCard.isBattle = true;
    if (rawCard.isDoc) normCard.isDoc = true;
    if (Array.isArray(rawCard.stagedAttachments)) {
      // 上限还在，但越界不再无声无息：留一个可读的标记，让人知道丢过东西。
      if (rawCard.stagedAttachments.length > 20) {
        normCard.stagedAttachmentsDropped = rawCard.stagedAttachments.length - 20;
      }
      normCard.stagedAttachments = rawCard.stagedAttachments.slice(0, 20).map(att => ({
        name: typeof att?.name === 'string' ? att.name.slice(0, 200) : '',
        size: typeof att?.size === 'number' ? att.size : 0,
        extension: typeof att?.extension === 'string' ? att.extension.slice(0, 50) : '',
        charCount: typeof att?.charCount === 'number' ? att.charCount : 0,
        lineCount: typeof att?.lineCount === 'number' ? att.lineCount : 0,
        content: typeof att?.content === 'string' ? att.content.slice(0, ATTACHMENT_MAX_CHARS) : '',
        preview: typeof att?.preview === 'string' ? att.preview.slice(0, 3000) : '',
      }));
      // 记录哪些附件正文被截断，而不是让 charCount 继续撒谎
      const truncatedIdx = normCard.stagedAttachments
        .map((att, i) => (att.content.length >= ATTACHMENT_MAX_CHARS ? i : -1))
        .filter(i => i >= 0);
      if (truncatedIdx.length) normCard.stagedAttachmentsTruncated = truncatedIdx;
    }
    if (typeof rawCard.docContent === 'string') {
      normCard.docContent = rawCard.docContent.slice(0, DOC_CONTENT_MAX_CHARS);
      // 静默截断等于把「保存成功」当谎话说。留标记，界面要如实显示。
      if (rawCard.docContent.length > DOC_CONTENT_MAX_CHARS) {
        normCard.docContentTruncated = {
          kept: DOC_CONTENT_MAX_CHARS,
          original: rawCard.docContent.length,
        };
      }
    }
    if (rawCard.docMeta && typeof rawCard.docMeta === 'object') {
      normCard.docMeta = {
        name: typeof rawCard.docMeta.name === 'string' ? rawCard.docMeta.name.slice(0, 200) : '',
        size: typeof rawCard.docMeta.size === 'number' ? rawCard.docMeta.size : 0,
        type: typeof rawCard.docMeta.type === 'string' ? rawCard.docMeta.type.slice(0, 50) : '',
        charCount: typeof rawCard.docMeta.charCount === 'number' ? rawCard.docMeta.charCount : 0,
        lineCount: typeof rawCard.docMeta.lineCount === 'number' ? rawCard.docMeta.lineCount : 0,
      };
    }
    // 本体来源引用：可选字段，旧快照没有就照常工作。
    // 坏数据一律当没有，不让它污染画布；也不持久化 token 或正文。
    if (rawCard.sourceRef && typeof rawCard.sourceRef === 'object') {
      const ref = rawCard.sourceRef;
      const REF_KINDS = new Set(['message', 'history', 'tree-path']);
      const safeId = (value) => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return /^[\w.:@~+-]{1,200}$/.test(trimmed) ? trimmed : null;
      };
      const sessionId = safeId(ref.sessionId);
      const importKind = REF_KINDS.has(ref.importKind) ? ref.importKind : null;
      if (ref.version === 1 && ref.kind === 'hana-session' && sessionId && importKind) {
        normCard.sourceRef = {
          version: 1,
          kind: 'hana-session',
          sessionId,
          entryIds: (Array.isArray(ref.entryIds) ? ref.entryIds : []).map(safeId).filter(Boolean).slice(0, 512),
          leafId: safeId(ref.leafId),
          titleAtImport: typeof ref.titleAtImport === 'string' ? ref.titleAtImport.slice(0, 300) : '',
          importedAt: typeof ref.importedAt === 'string' ? ref.importedAt.slice(0, 40) : '',
          contentHash: typeof ref.contentHash === 'string' ? ref.contentHash.slice(0, 32) : '',
          importKind,
        };
      }
    }
    if (rawCard.parentIds !== undefined && rawCard.parentIds !== null) {
      if (!Array.isArray(rawCard.parentIds)) {
        throw createError("INVALID_SESSION_SNAPSHOT", `Invalid parentIds: ${cardId}`);
      }
      const validParentIds = [];
      const seenParentIds = new Set();
      for (const pid of rawCard.parentIds) {
        if (typeof pid !== 'string' || !ID_REGEX.test(pid)) {
          throw createError("INVALID_SESSION_SNAPSHOT", `Invalid parentIds entry: ${pid}`);
        }
        if (pid === cardId) {
          throw createError("INVALID_SESSION_SNAPSHOT", `Card cannot be its own parent: ${cardId}`);
        }
        if (!seenParentIds.has(pid)) {
          seenParentIds.add(pid);
          validParentIds.push(pid);
        }
      }
      if (validParentIds.length > 0) normCard.parentIds = validParentIds;
    }
    if (typeof rawCard.savedScrollTop === 'number' && Number.isFinite(rawCard.savedScrollTop) && rawCard.savedScrollTop >= 0) {
      normCard.savedScrollTop = rawCard.savedScrollTop;
    }

    normalizedCards.push(normCard);
    cardMap.set(cardId, normCard);
  }

  // 4. 校验父引用存在性与 DAG 无环性
  for (const card of normalizedCards) {
    for (const pId of parentIdsOf(card)) {
      if (!cardMap.has(pId)) {
        throw createError("INVALID_SESSION_SNAPSHOT", `Parent card not found: ${pId}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(cardId) {
    if (visiting.has(cardId)) {
      throw createError("INVALID_SESSION_SNAPSHOT", `Cycle detected in card DAG at card: ${cardId}`);
    }
    if (visited.has(cardId)) return;
    visiting.add(cardId);
    const card = cardMap.get(cardId);
    for (const parentId of parentIdsOf(card)) visit(parentId);
    visiting.delete(cardId);
    visited.add(cardId);
  }
  for (const card of normalizedCards) visit(card.id);
  // 跨卡引用身份校验：单卡内去重不够，同一快照里 ref.id 必须唯一
  assertSnapshotRefIdentity(normalizedCards);

  return {
    cards: normalizedCards,
    view: normalizedView,
    agent: normalizedAgent,
  };
}

/**
 * 校验已解析的 Session 存储完整文档
 */
function validateStoreDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw createError("SESSION_STORE_CORRUPT", "Storage document is corrupt or not an object");
  }
  if (!READABLE_STORE_VERSIONS.includes(doc.version)) {
    throw createError("SESSION_STORE_CORRUPT", `Unknown session store version: ${doc.version}`);
  }
  if (!Array.isArray(doc.sessions)) {
    throw createError("SESSION_STORE_CORRUPT", "Storage document sessions must be an array");
  }
  if (doc.sessions.length > STORAGE_MAX_SESSIONS) throw createError('SESSION_STORE_CORRUPT', 'Too many stored sessions');
  const ids = new Set();
  for (const rec of doc.sessions) {
    if (!rec || typeof rec !== 'object' || !ID_REGEX.test(rec.id || '') || ids.has(rec.id)
      || !Number.isSafeInteger(rec.revision) || rec.revision < 1 || typeof rec.title !== 'string'
      || !Number.isFinite(rec.createdAt) || !Number.isFinite(rec.updatedAt)) {
      throw createError('SESSION_STORE_CORRUPT', 'Invalid session record in storage document');
    }
    ids.add(rec.id);
    if (doc.version === 1) {
      const polluted = Array.isArray(rec.snapshot?.cards)
        && rec.snapshot.cards.some(card => card && (card.contextMode !== undefined || card.contextRefs !== undefined));
      if (polluted) {
        throw createError('SESSION_STORE_CORRUPT', 'Version 1 store carries version 2 context fields');
      }
    }
    try { rec.snapshot = normalizeForkSnapshot(rec.snapshot); }
    catch { throw createError('SESSION_STORE_CORRUPT', 'Invalid saved canvas; original storage was not overwritten'); }
  }
  if (doc.activeId !== null && !ids.has(doc.activeId)) throw createError('SESSION_STORE_CORRUPT', 'Invalid active session reference');
}

/**
 * 默认 ID 生成器
 */
function defaultIdFactory() {
  return `sess_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

/**
 * 创建 App 自有分叉会话管理 Store
 * @param {object} hana - 包含 hana.storage.global 的 SDK 或 facade
 * @param {object} [options]
 * @param {object} [options.locks] - Web Locks API（默认 globalThis.navigator?.locks）
 * @param {() => number} [options.now] - 时间源（默认 Date.now）
 * @param {() => string} [options.idFactory] - ID 工厂
 */
export function createForkSessionStore(hana, options = {}) {
  const {
    locks = globalThis.navigator?.locks,
    now = Date.now,
    idFactory = defaultIdFactory,
  } = options;

  if (!hana || !hana.storage || !hana.storage.global) {
    throw new Error("createForkSessionStore requires hana.storage.global");
  }

  const storage = hana.storage.global;

  // 内部：读取文档并严格校验
  async function readDoc() {
    const raw = await storage.get(FORK_SESSION_STORAGE_KEY);
    const val = unwrapStorageValue(raw);
    if (val === undefined || val === null) {
      return {
        version: STORE_VERSION,
        activeId: null,
        sessions: [],
        initialized: false,
      };
    }
    const doc = deepClone(val);
    validateStoreDoc(doc);
    if (doc.initialized === undefined) {
      doc.initialized = true;
    }
    return doc;
  }

  // 内部：写入文档并检查容量限制
  async function writeDoc(doc) {
    // 只写当前版本：旧窗口读不懂 v2，会在读的时候自己停下，而不是把新字段洗掉
    doc.version = STORE_VERSION;
    if (doc.sessions.length > STORAGE_MAX_SESSIONS) {
      throw createError("STORAGE_QUOTA_EXCEEDED", `Session count exceeds maximum quota of ${STORAGE_MAX_SESSIONS}`);
    }
    const serialized = JSON.stringify(doc);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > STORAGE_MAX_BYTES) {
      throw createError("STORAGE_QUOTA_EXCEEDED", `Session document size (${bytes} bytes) exceeds 12MB limit`);
    }
    await storage.set(FORK_SESSION_STORAGE_KEY, doc);
  }

  // 内部：带锁执行事务。无锁直接抛错，绝不降级覆盖写
  async function withLock(operation) {
    if (!locks || typeof locks.request !== "function") {
      throw createError("STORAGE_LOCK_UNAVAILABLE", "Web Locks API (navigator.locks) is unavailable");
    }
    return await locks.request(STORE_LOCK_NAME, async () => {
      return await operation();
    });
  }

  return {
    /**
     * 原子确保存在活动会话：返回当前活动记录或首条；若库为空则原子新建
     */
    async ensure(snapshot) {
      return await withLock(async () => {
        const doc = await readDoc();
        if (doc.sessions.length > 0) {
          if (doc.activeId) {
            const found = doc.sessions.find((s) => s.id === doc.activeId);
            if (found) return deepClone(found);
          }
          doc.activeId = doc.sessions[0].id;
          await writeDoc(doc);
          return deepClone(doc.sessions[0]);
        }

        // 若已被初始化过（即用户此前操作过并删空了所有会话），不自动重生会话，保持空状态
        if (doc.initialized) {
          return null;
        }

        // 仅在首次打开（存储中从未写入过会话库）时，才创建首条默认会话
        const normalized = normalizeForkSnapshot(snapshot);
        const title = generateAutoTitle(normalized);
        const currentTime = now();
        const newRecord = {
          id: idFactory(),
          title,
          revision: 1,
          createdAt: currentTime,
          updatedAt: currentTime,
          manualTitle: false,
          snapshot: normalized,
        };

        doc.sessions.push(newRecord);
        doc.activeId = newRecord.id;
        doc.initialized = true;
        await writeDoc(doc);
        return deepClone(newRecord);
      });
    },

    /**
     * 列出所有会话摘要信息（只读，无需锁）
     */
    async list() {
      const doc = await readDoc();
      return {
        activeId: doc.activeId,
        sessions: doc.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          revision: s.revision,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          cardCount: s.snapshot?.cards ? s.snapshot.cards.length : 0,
        })),
      };
    },

    /**
     * 获取指定 ID 的完整会话记录（只读，无需锁）
     */
    async get(id) {
      const doc = await readDoc();
      const found = doc.sessions.find((s) => s.id === id);
      if (!found) {
        throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
      }
      return deepClone(found);
    },

    /**
     * 新建会话并将 activeId 切换至新会话
     */
    async create(snapshot, { title } = {}) {
      return await withLock(async () => {
        const doc = await readDoc();
        if (doc.sessions.length >= STORAGE_MAX_SESSIONS) {
          throw createError("STORAGE_QUOTA_EXCEEDED", `Cannot create session: maximum ${STORAGE_MAX_SESSIONS} reached`);
        }

        const normalized = normalizeForkSnapshot(snapshot);
        const isManual = Boolean(title && typeof title === "string" && title.trim().length > 0);
        const sessionTitle = isManual ? sanitizeSessionTitle(title) : generateAutoTitle(normalized);
        const currentTime = now();

        const record = {
          id: idFactory(),
          title: sessionTitle,
          revision: 1,
          createdAt: currentTime,
          updatedAt: currentTime,
          manualTitle: isManual,
          snapshot: normalized,
        };

        doc.sessions.push(record);
        doc.activeId = record.id;
        await writeDoc(doc);
        return deepClone(record);
      });
    },

    /**
     * 仅切换 activeId
     */
    async activate(id) {
      return await withLock(async () => {
        const doc = await readDoc();
        const found = doc.sessions.find((s) => s.id === id);
        if (!found) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }
        if (doc.activeId !== id) {
          doc.activeId = id;
          await writeDoc(doc);
        }
        return deepClone(found);
      });
    },

    /**
     * 保存快照：严格比对 expectedRevision，版本冲突抛 SESSION_CONFLICT
     */
    async save(id, expectedRevision, snapshot) {
      return await withLock(async () => {
        const doc = await readDoc();
        const record = doc.sessions.find((s) => s.id === id);
        if (!record) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }
        if (record.revision !== expectedRevision) {
          throw createError(
            "SESSION_CONFLICT",
            `Session conflict: expected revision ${expectedRevision} but found ${record.revision}`
          );
        }

        const normalized = normalizeForkSnapshot(snapshot);
        record.revision = expectedRevision + 1;
        record.updatedAt = now();
        record.snapshot = normalized;

        if (!record.manualTitle) {
          record.title = generateAutoTitle(normalized);
        }

        await writeDoc(doc);
        return deepClone(record);
      });
    },

    /**
     * 重命名会话：校验标题合法性，CAS比对 expectedTitle（若传），仅递增 revision 与刷新 updatedAt
     */
    async rename(id, title, expectedTitle) {
      const sanitizedTitle = sanitizeSessionTitle(title);
      return await withLock(async () => {
        const doc = await readDoc();
        const record = doc.sessions.find((s) => s.id === id);
        if (!record) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }

        if (typeof expectedTitle === "string" && record.title !== expectedTitle) {
          throw createError(
            "SESSION_CONFLICT",
            "会话名称已变化，请取消编辑后重新操作。"
          );
        }

        record.title = sanitizedTitle;
        record.manualTitle = true;
        record.revision += 1;
        record.updatedAt = now();

        await writeDoc(doc);
        return deepClone(record);
      });
    },

    /**
     * 删除会话：比对 expectedRevision，若删最后一个则会话清空（activeId 为 null），若删全局 active 选剩余最近 updatedAt 记录
     */
    async remove(id, expectedRevision, fallbackSnapshot) {
      return await withLock(async () => {
        const doc = await readDoc();
        const index = doc.sessions.findIndex((s) => s.id === id);
        if (index === -1) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }

        const record = doc.sessions[index];
        if (record.revision !== expectedRevision) {
          throw createError(
            "SESSION_CONFLICT",
            `Session conflict: expected revision ${expectedRevision} but found ${record.revision}`
          );
        }

        // 删除目标记录
        doc.sessions.splice(index, 1);
        doc.initialized = true;

        // 若会话已被全部删空：activeId 置 null，返回 null session
        if (doc.sessions.length === 0) {
          doc.activeId = null;
          await writeDoc(doc);
          return {
            deletedId: id,
            activeId: null,
            session: null,
          };
        }

        // 存在剩余会话时：若删的是全局 active，则选择剩余中最近 updatedAt 记录
        if (doc.activeId === id) {
          let latest = doc.sessions[0];
          for (let i = 1; i < doc.sessions.length; i++) {
            if (doc.sessions[i].updatedAt > latest.updatedAt) {
              latest = doc.sessions[i];
            }
          }
          doc.activeId = latest.id;
        }

        await writeDoc(doc);
        const activeRecord = doc.sessions.find((s) => s.id === doc.activeId);
        return {
          deletedId: id,
          activeId: doc.activeId,
          session: deepClone(activeRecord),
        };
      });
    },

    /**
     * 监听当前 App 根键变更
     */
    watch(callback) {
      if (typeof storage.onChanged !== "function") {
        return () => {};
      }
      return storage.onChanged((keys) => {
        if (Array.isArray(keys) && keys.includes(FORK_SESSION_STORAGE_KEY)) {
          try {
            callback();
          } catch {
            // 回调异常安全隔离
          }
        }
      });
    },
  };
}

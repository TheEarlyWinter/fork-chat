/**
 * 会话快照的归一化：把任意输入清洗成白名单 DTO。
 *
 * 这里只做一件事——决定"什么能存下来"。存储事务、加锁、容量校验都在
 * fork-session-store.js；两者分开后，归一化可以单独喂输入测，不必搭一套存储。
 */

import { normalizeContextRefs } from './fork-context-policy.js';
import { normalizeArtifactList } from './artifact-contract.js';

/** 卡片 id 的合法形式 */
export const ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;
/** 单卡文档正文上限：与 MinerU 的 MAX_MARKDOWN_CHARS 对齐 */
export const DOC_CONTENT_MAX_CHARS = 2000000;
/** 单个附件正文上限 */
export const ATTACHMENT_MAX_CHARS = 1000000;
/**
 * 历史版本曾把已发送附件的正文裁到 30 万字符。恰好等于这个长度的正文
 * 既可能是被旧上限切过的，也可能本来就这么长；缺可靠原始长度时只能保守处理。
 */
export const LEGACY_ATTACHMENT_MAX_CHARS = 300000;
/**
 * 盖戳的合法取值。真实循环是 无 → starred → accepted → rejected → 无，
 * 这里少写一档就等于每次重开都把那一档重置掉。
 */
export const STATUS_STAMPS = Object.freeze(['starred', 'accepted', 'rejected']);

export function createError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function parentIdsOf(card) {
  return Array.from(new Set([
    ...(card?.parentId ? [card.parentId] : []),
    ...(Array.isArray(card?.parentIds) ? card.parentIds : []),
  ]));
}


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
      if (Array.isArray(rawMsg.artifacts)) msg.artifacts = normalizeArtifactList(rawMsg.artifacts);
      // A revision can update an older file card while this message keeps only a context reference.
      if (Array.isArray(rawMsg.artifactRefs)) msg.artifactRefs = normalizeArtifactList(rawMsg.artifactRefs);

      // 旧存档可能已经带着裁切标记回来：先原样接住，再与本次重算结果合并
      if (Number.isSafeInteger(rawMsg.attachmentsDropped) && rawMsg.attachmentsDropped > 0) {
        msg.attachmentsDropped = rawMsg.attachmentsDropped;
      }
      const savedTruncatedIdx = Array.isArray(rawMsg.attachmentsTruncated)
        ? rawMsg.attachmentsTruncated.filter(Number.isSafeInteger)
        : [];
      if (Array.isArray(rawMsg.attachments)) {
        // 裁切不能无声无息：数量与正文的丢减都要留下可恢复标记，
        // 否则重开之后 charCount 继续撒谎，交接会把残缺当完整。
        const droppedBySlice = rawMsg.attachments.length > 10 ? rawMsg.attachments.length - 10 : 0;
        if (droppedBySlice) msg.attachmentsDropped = Math.max(droppedBySlice, msg.attachmentsDropped ?? 0);
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
        // 与旧标记取并集，不因重算而丢掉历史信息
        const truncatedIdx = new Set(savedTruncatedIdx);
        msg.attachments.forEach((att, i) => {
          if (att.content.length >= ATTACHMENT_MAX_CHARS || att.content.length === LEGACY_ATTACHMENT_MAX_CHARS) {
            truncatedIdx.add(i);
          }
        });
        if (truncatedIdx.size) msg.attachmentsTruncated = [...truncatedIdx].sort((a, b) => a - b);
      } else if (savedTruncatedIdx.length) {
        msg.attachmentsTruncated = [...new Set(savedTruncatedIdx)].sort((a, b) => a - b);
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

/**
 * 交接上下文编译器：只沿目标节点的父依赖取子图，组装可校验的 HandoffContext。
 *
 * 纯函数：不碰 DOM、SDK、存储，也不调用会裁切历史的模型上下文计划器。
 * 拓扑遍历用显式栈，深链不会爆栈；派生统计最后由协议层按实际内容重算。
 */

import {
  ID_REGEX,
  ATTACHMENT_MAX_CHARS,
  LEGACY_ATTACHMENT_MAX_CHARS,
  DOC_CONTENT_MAX_CHARS,
  parentIdsOf,
} from './fork-snapshot.js';
import { getContextMode } from './fork-context-policy.js';
import { normalizeArtifactMetadata } from './artifact-contract.js';
import {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_LIMITS,
  HANDOFF_ERROR_CODES as CODES,
  handoffError,
  validateHandoffContext,
} from './fork-handoff-contract.js';

const GENERATING_STATUSES = new Set(['waiting', 'generating', 'delivering']);
const MESSAGE_STATUS_MAP = new Map([
  ['completed', 'ok'],
  ['failed', 'failed'],
  ['partial', 'partial'],
  ['cancelled', 'cancelled'],
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidSnapshot(message) {
  return handoffError(CODES.HANDOFF_INVALID_SNAPSHOT, message);
}

function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lines++;
  }
  return lines;
}

/** 可选集合字段：undefined 表示没有；null 或其它非数组一律拒绝 */
function optionalArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidSnapshot(`${label} 必须是数组`);
  return value;
}

function assertSource(source, targetCardId) {
  if (!isPlainObject(source)) throw handoffError(CODES.HANDOFF_INVALID_SOURCE, '缺少来源信息');
  if (source.targetCardId !== targetCardId) {
    throw handoffError(CODES.HANDOFF_INVALID_SOURCE, '来源信息里的目标节点与所选目标不一致');
  }
  if (typeof source.canvasId !== 'string' || source.canvasId.trim() === '') {
    throw handoffError(CODES.HANDOFF_INVALID_SOURCE, '缺少画布标识');
  }
  const revisionOk = (typeof source.revision === 'string' && source.revision !== '')
    || (typeof source.revision === 'number' && Number.isSafeInteger(source.revision) && source.revision >= 0);
  if (!revisionOk) throw handoffError(CODES.HANDOFF_INVALID_SOURCE, '缺少画布版本');
}

function assertAgentId(agentId) {
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw handoffError(CODES.HANDOFF_INVALID_AGENT, '必须明确指定目标 Agent');
  }
}

/** 快照卡片索引：只做严格校验，不提供旧导出函数的容错跳过 */
function indexCards(snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.cards)) {
    throw invalidSnapshot('快照必须是带 cards 数组的对象');
  }
  const cardMap = new Map();
  for (const card of snapshot.cards) {
    if (!isPlainObject(card)) throw invalidSnapshot('卡片必须是对象');
    if (typeof card.id !== 'string' || !ID_REGEX.test(card.id)) throw invalidSnapshot('卡片标识不合法');
    if (cardMap.has(card.id)) throw handoffError(CODES.HANDOFF_DUPLICATE_ID, `卡片标识重复：${card.id}`);
    if (card.contextMode !== undefined && card.contextMode !== 'include' && card.contextMode !== 'exclude') {
      throw invalidSnapshot(`卡片 ${card.id} 的上下文标记不合法`);
    }
    const parents = parentIdsOf(card);
    optionalArray(card.contextRefs, `卡片 ${card.id} 的 references`);
    for (const parentId of parents) {
      if (typeof parentId !== 'string' || !ID_REGEX.test(parentId)) {
        throw invalidSnapshot(`卡片 ${card.id} 的父节点标识不合法`);
      }
      if (parentId === card.id) {
        throw handoffError(CODES.HANDOFF_CYCLE, `卡片 ${card.id} 把自己当成父节点`);
      }
    }
    cardMap.set(card.id, card);
  }
  return cardMap;
}

/**
 * 从目标节点沿父边回溯，返回"父节点在前"的确定顺序。
 * 用显式栈的 DFS；遇到环、缺父或超限立即拒绝。
 * 每个 frame 只取一次父列表，不随边的数量重复重建集合。
 */
function collectDependencyOrder(cardMap, targetCardId) {
  const state = new Map([[targetCardId, 1]]);
  const finished = [];
  const stack = [{ id: targetCardId, cursor: 0, parents: parentIdsOf(cardMap.get(targetCardId)) }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const parents = frame.parents;
    if (frame.cursor < parents.length) {
      const parentId = parents[frame.cursor++];
      const parentState = state.get(parentId) ?? 0;
      if (parentState === 1) throw handoffError(CODES.HANDOFF_CYCLE, `父依赖成环：${parentId} → ${frame.id}`);
      if (parentState === 2) continue;
      if (!cardMap.has(parentId)) {
        throw handoffError(CODES.HANDOFF_MISSING_PARENT, `卡片 ${frame.id} 的父卡片 ${parentId} 不在快照里`);
      }
      state.set(parentId, 1);
      stack.push({ id: parentId, cursor: 0, parents: parentIdsOf(cardMap.get(parentId)) });
      if (state.size > HANDOFF_LIMITS.maxNodes) {
        throw handoffError(
          CODES.HANDOFF_TOO_MANY_NODES,
          `依赖子图超过 ${HANDOFF_LIMITS.maxNodes} 个节点`,
          { limit: HANDOFF_LIMITS.maxNodes },
        );
      }
      continue;
    }
    state.set(frame.id, 2);
    finished.push(frame.id);
    stack.pop();
  }
  return finished;
}

function buildDoc(card) {
  if (card.docContent !== undefined && typeof card.docContent !== 'string') {
    throw invalidSnapshot(`卡片 ${card.id} 的 docContent 必须是字符串`);
  }
  const claimsDoc = card.isDoc === true || isPlainObject(card.docMeta);
  if (!claimsDoc) {
    // 普通聊天卡没有 docContent 是合法的；空字符串也只是没有资料
    if (card.docContent === undefined || card.docContent === '') return null;
  }
  if (typeof card.docContent !== 'string' || card.docContent.trim() === '') {
    throw handoffError(CODES.HANDOFF_DOC_MISSING_CONTENT, `卡片 ${card.id} 声明为资料卡但没有保存正文`);
  }
  const content = card.docContent;
  if (card.docContentTruncated) {
    throw handoffError(CODES.HANDOFF_DOC_TRUNCATED, `卡片 ${card.id} 的资料正文已被裁切，无法完整交接`, {
      kept: card.docContentTruncated.kept,
      original: card.docContentTruncated.original,
    });
  }
  const meta = isPlainObject(card.docMeta) ? card.docMeta : {};
  const reported = Number.isSafeInteger(meta.charCount) ? meta.charCount : null;
  if (reported !== null && reported > content.length) {
    throw handoffError(
      CODES.HANDOFF_DOC_TRUNCATED,
      `卡片 ${card.id} 的资料正文比记录的 ${reported} 字短，判定为被裁切`,
      { reported, actual: content.length },
    );
  }
  if (content.length >= DOC_CONTENT_MAX_CHARS) {
    throw handoffError(
      CODES.HANDOFF_DOC_INTEGRITY_UNKNOWN,
      `卡片 ${card.id} 的资料正文达到历史截断阈值且没有可靠原始长度，完整性无法确认`,
    );
  }
  return {
    name: typeof meta.name === 'string' ? meta.name : '',
    extension: typeof meta.extension === 'string' ? meta.extension : (typeof meta.type === 'string' ? meta.type : ''),
    charCount: content.length,
    lineCount: countLines(content),
    content,
  };
}

function buildAttachments(message, cardId, messageIndex) {
  if (Number.isSafeInteger(message.attachmentsDropped) && message.attachmentsDropped > 0) {
    throw handoffError(
      CODES.HANDOFF_ATTACHMENT_DROPPED,
      `卡片 ${cardId} 第 ${messageIndex + 1} 条消息有 ${message.attachmentsDropped} 个附件被丢弃，无法完整交接`,
      { dropped: message.attachmentsDropped },
    );
  }
  if (Array.isArray(message.attachmentsTruncated) && message.attachmentsTruncated.length > 0) {
    throw handoffError(
      CODES.HANDOFF_ATTACHMENT_TRUNCATED,
      `卡片 ${cardId} 第 ${messageIndex + 1} 条消息的附件正文已被裁切，无法完整交接`,
      { truncated: [...message.attachmentsTruncated] },
    );
  }
  const list = optionalArray(message.attachments, `卡片 ${cardId} 第 ${messageIndex + 1} 条消息的 attachments`);
  if (list.length > HANDOFF_LIMITS.maxAttachmentsPerMessage) {
    throw invalidSnapshot(`卡片 ${cardId} 第 ${messageIndex + 1} 条消息的附件数量超过上限`);
  }
  return list.map((raw, index) => {
    if (!isPlainObject(raw)) throw invalidSnapshot(`卡片 ${cardId} 第 ${messageIndex + 1} 条消息的附件不是对象`);
    if (typeof raw.content !== 'string' || raw.content.trim() === '') {
      throw handoffError(
        CODES.HANDOFF_ATTACHMENT_MISSING_CONTENT,
        `卡片 ${cardId} 第 ${messageIndex + 1} 条消息的附件 ${index + 1} 没有保存正文`,
      );
    }
    const content = raw.content;
    const reported = Number.isSafeInteger(raw.charCount) ? raw.charCount : null;
    if (reported !== null && reported > content.length) {
      throw handoffError(
        CODES.HANDOFF_ATTACHMENT_TRUNCATED,
        `卡片 ${cardId} 第 ${messageIndex + 1} 条消息的附件 ${index + 1} 记 ${reported} 字但只保存了 ${content.length} 字`,
        { reported, actual: content.length },
      );
    }
    if (content.length >= ATTACHMENT_MAX_CHARS) {
      throw handoffError(
        CODES.HANDOFF_ATTACHMENT_INTEGRITY_UNKNOWN,
        `卡片 ${cardId} 第 ${messageIndex + 1} 条消息的附件 ${index + 1} 达到历史截断阈值，完整性无法确认`,
      );
    }
    if (content.length === LEGACY_ATTACHMENT_MAX_CHARS) {
      throw handoffError(
        CODES.HANDOFF_ATTACHMENT_INTEGRITY_UNKNOWN,
        `卡片 ${cardId} 第 ${messageIndex + 1} 条消息的附件 ${index + 1} 恰好等于旧版裁切阈值 ${LEGACY_ATTACHMENT_MAX_CHARS}，完整性无法确认`,
      );
    }
    return {
      name: typeof raw.name === 'string' ? raw.name : '',
      extension: typeof raw.extension === 'string' ? raw.extension : '',
      charCount: content.length,
      lineCount: countLines(content),
      content,
    };
  });
}

function collectArtifacts(message, cardId, state) {
  const receipts = [];
  for (const [field, label] of [['artifacts', '产物'], ['artifactRefs', '产物引用']]) {
    receipts.push(...optionalArray(message[field], `卡片 ${cardId} 的 ${label}（${field}）`));
  }
  const ids = [];
  for (const raw of receipts) {
    if (!isPlainObject(raw)) {
      throw handoffError(CODES.HANDOFF_INVALID_ARTIFACT, `卡片 ${cardId} 的产物回执不是对象`);
    }
    if (typeof raw.bytes === 'number' && raw.bytes > HANDOFF_LIMITS.maxArtifactBytes) {
      throw handoffError(
        CODES.HANDOFF_ARTIFACT_TOO_LARGE,
        `产物 ${raw.artifactId} 有 ${raw.bytes} 字节，超过单产物上限 ${HANDOFF_LIMITS.maxArtifactBytes}`,
        { bytes: raw.bytes, limit: HANDOFF_LIMITS.maxArtifactBytes },
      );
    }
    // 复用 artifact-contract 的公共 receipt 规则；无效回执直接报错，不过滤吞掉
    const metadata = normalizeArtifactMetadata(raw);
    if (!metadata) {
      throw handoffError(
        CODES.HANDOFF_INVALID_ARTIFACT,
        `卡片 ${cardId} 的产物回执不完整或不可交付（${String(raw.artifactId ?? '缺少标识')}）`,
      );
    }
    const signature = [
      metadata.name, metadata.mime, metadata.format, metadata.bytes, metadata.sha256,
      metadata.createdAt, metadata.revisedFrom ?? '', metadata.version ?? 1, metadata.revisionRootId ?? '',
    ].join('\u0000');
    const previous = state.signatures.get(metadata.artifactId);
    if (previous === undefined) {
      if (state.bytes.size >= HANDOFF_LIMITS.maxArtifacts) {
        throw handoffError(
          CODES.HANDOFF_TOO_MANY_ARTIFACTS,
          `产物数量超过上限 ${HANDOFF_LIMITS.maxArtifacts}`,
          { limit: HANDOFF_LIMITS.maxArtifacts },
        );
      }
      state.bytes.set(metadata.artifactId, metadata.bytes);
      state.signatures.set(metadata.artifactId, signature);
      state.order.push(metadata.artifactId);
    } else {
      if (previous !== signature) {
        throw handoffError(
          CODES.HANDOFF_ARTIFACT_CONFLICT,
          `产物 ${metadata.artifactId} 在不同位置的无变字段不一致`,
          { artifactId: metadata.artifactId },
        );
      }
      state.deduped = true;
    }
    if (!ids.includes(metadata.artifactId)) ids.push(metadata.artifactId);
  }
  return ids;
}

function buildMessage(raw, cardId, index, artifactState) {
  if (!isPlainObject(raw)) throw invalidSnapshot(`卡片 ${cardId} 的消息不是对象`);
  if (raw.role !== 'user' && raw.role !== 'assistant') throw invalidSnapshot(`卡片 ${cardId} 的消息角色不合法`);
  if (typeof raw.text !== 'string') throw invalidSnapshot(`卡片 ${cardId} 的消息正文必须是字符串`);
  if (raw.localOnly) return null;
  if (raw.streaming === true || GENERATING_STATUSES.has(raw.status)) {
    throw handoffError(
      CODES.HANDOFF_GENERATING,
      `卡片 ${cardId} 第 ${index + 1} 条消息仍在生成或解析，先停止或等待完成再交接`,
    );
  }
  const explicit = raw.status;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    if (typeof explicit !== 'string' || !MESSAGE_STATUS_MAP.has(explicit)) {
      throw handoffError(
        CODES.HANDOFF_UNKNOWN_MESSAGE_STATUS,
        `卡片 ${cardId} 第 ${index + 1} 条消息的状态 ${String(explicit)} 无法识别`,
      );
    }
  }
  let status = MESSAGE_STATUS_MAP.get(explicit) ?? 'ok';
  if (raw.partial === true) status = 'partial';
  else if (raw.failed === true) status = explicit === 'cancelled' ? 'cancelled' : 'failed';
  return {
    role: raw.role,
    text: raw.text,
    agentName: typeof raw.agentName === 'string' ? raw.agentName : '',
    status,
    attachments: buildAttachments(raw, cardId, index),
    artifactIds: collectArtifacts(raw, cardId, artifactState),
  };
}

/** 只提取预览元数据：草稿只报字符数，暂存附件只报名称与裁切状态 */
function buildUnsent(card) {
  const draft = typeof card.draft === 'string' ? card.draft : '';
  const staged = optionalArray(card.stagedAttachments, `卡片 ${card.id} 的 stagedAttachments`);
  const droppedSaved = Number.isSafeInteger(card.stagedAttachmentsDropped) && card.stagedAttachmentsDropped > 0
    ? card.stagedAttachmentsDropped
    : 0;
  const droppedBySlice = staged.length > HANDOFF_LIMITS.maxUnsentAttachments
    ? staged.length - HANDOFF_LIMITS.maxUnsentAttachments
    : 0;
  const truncatedIdx = new Set(
    Array.isArray(card.stagedAttachmentsTruncated)
      ? card.stagedAttachmentsTruncated.filter(Number.isSafeInteger)
      : [],
  );
  const attachments = staged.slice(0, HANDOFF_LIMITS.maxUnsentAttachments).map((raw, index) => {
    const content = typeof raw?.content === 'string' ? raw.content : '';
    const truncated = truncatedIdx.has(index)
      || content.length >= ATTACHMENT_MAX_CHARS
      || content.length === LEGACY_ATTACHMENT_MAX_CHARS;
    return { name: typeof raw?.name === 'string' ? raw.name : '', contentTruncated: truncated };
  });
  const hasDraft = draft.trim() !== '';
  const attachmentsDropped = Math.max(droppedSaved, droppedBySlice);
  if (!hasDraft && attachments.length === 0 && attachmentsDropped === 0) return null;
  return {
    cardId: card.id,
    hasDraft,
    draftChars: hasDraft ? draft.length : 0,
    attachments,
    attachmentsDropped,
  };
}

function buildReferences(includedCards, cardMap) {
  const entries = new Map();
  const order = [];
  const sources = new Map();
  let deduped = false;
  let deletedSources = 0;
  let excludedSources = 0;
  for (const card of includedCards) {
    const refs = Array.isArray(card.contextRefs) ? card.contextRefs : [];
    for (const raw of refs) {
      if (!isPlainObject(raw)) throw invalidSnapshot(`卡片 ${card.id} 的引用不是对象`);
      if (typeof raw.id !== 'string' || !ID_REGEX.test(raw.id)) throw invalidSnapshot(`卡片 ${card.id} 的引用标识不合法`);
      if (typeof raw.sourceCardId !== 'string' || !ID_REGEX.test(raw.sourceCardId)) {
        throw invalidSnapshot(`卡片 ${card.id} 的引用来源标识不合法`);
      }
      if (typeof raw.text !== 'string' || raw.text.trim() === '') throw invalidSnapshot(`卡片 ${card.id} 的引用正文为空`);
      if (raw.sourceCardId === card.id) {
        throw handoffError(CODES.HANDOFF_INVALID_REFERENCE, `卡片 ${card.id} 的引用指向自身，不允许`);
      }
      const sourceCard = cardMap.get(raw.sourceCardId);
      const exists = Boolean(sourceCard);
      const contextMode = exists ? getContextMode(sourceCard) : null;
      let status = 'snapshot';
      if (!exists) status = 'source-deleted';
      else if (contextMode === 'exclude') status = 'source-excluded';
      const text = status === 'source-excluded' ? '' : raw.text;
      const sourceTitle = typeof raw.sourceTitle === 'string' ? raw.sourceTitle : '';
      sources.set(raw.sourceCardId, exists
        ? { cardId: raw.sourceCardId, exists: true, contextMode }
        : { cardId: raw.sourceCardId, exists: false, contextMode: null });
      const existing = entries.get(raw.id);
      if (existing) {
        if (existing.sourceCardId !== raw.sourceCardId || existing.text !== text || existing.status !== status) {
          throw handoffError(
            CODES.HANDOFF_REFERENCE_CONFLICT,
            `引用 ${raw.id} 在不同位置内容或来源不一致`,
          );
        }
        if (!existing.positions.includes(card.id)) existing.positions.push(card.id);
        deduped = true;
        continue;
      }
      const entry = {
        refId: raw.id,
        sourceCardId: raw.sourceCardId,
        sourceTitle,
        text,
        status,
        included: status !== 'source-excluded',
        positions: [card.id],
      };
      if (status === 'source-deleted') deletedSources++;
      if (status === 'source-excluded') excludedSources++;
      entries.set(raw.id, entry);
      order.push(entry);
    }
  }
  return { order, sources: [...sources.values()], deduped, deletedSources, excludedSources };
}

/**
 * 组装并校验一次交接上下文。
 *
 * 返回的 HandoffContext 已由协议层白名单重建、统计按实际内容重算，并通过体积检查。
 * 统计、指纹、正文和完整性说明都不采信调用方提供的派生值；说明在协议层
 * 根据已验证结构重建，本地提示的丢弃数量只以omissions元数据上报。
 */
export function buildHandoffContext({ snapshot, source, targetCardId, agentId, nextStep = '' } = {}) {
  if (typeof targetCardId !== 'string' || !ID_REGEX.test(targetCardId)) {
    throw handoffError(CODES.HANDOFF_TARGET_MISSING, '必须选择合法的目标节点');
  }
  assertSource(source, targetCardId);
  assertAgentId(agentId);
  const cardMap = indexCards(snapshot);
  if (!cardMap.has(targetCardId)) throw handoffError(CODES.HANDOFF_TARGET_MISSING, `目标节点 ${targetCardId} 不在快照里`);

  const dependencyOrder = collectDependencyOrder(cardMap, targetCardId);
  const excludedIds = new Set();
  for (const id of dependencyOrder) {
    if (id !== targetCardId && getContextMode(cardMap.get(id)) === 'exclude') excludedIds.add(id);
  }
  const includedIds = dependencyOrder.filter(id => !excludedIds.has(id));
  const includedCards = includedIds.map(id => cardMap.get(id));

  const artifactState = { bytes: new Map(), signatures: new Map(), order: [], deduped: false };
  const nodes = [];
  let localNoticeCount = 0;

  for (const card of includedCards) {
    const doc = buildDoc(card);
    if (!Array.isArray(card.messages)) throw invalidSnapshot(`卡片 ${card.id} 的 messages 必须是数组`);
    const messages = [];
    for (const [index, raw] of card.messages.entries()) {
      const message = buildMessage(raw, card.id, index, artifactState);
      if (!message) {
        localNoticeCount++;
        continue;
      }
      messages.push(message);
    }
    nodes.push({
      cardId: card.id,
      title: typeof card.title === 'string' ? card.title : '',
      parentIds: parentIdsOf(card),
      contextMode: getContextMode(card),
      doc,
      messages,
      // 节点级产物位置：只表示节点本身的产物，不复制消息里的 ID
      // （总去重由顶层 artifactIds 负责，重复 notice 按原始位置统计）
      artifactIds: [],
    });
  }

  const artifactBytesTotal = [...artifactState.bytes.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (artifactBytesTotal > HANDOFF_LIMITS.maxArtifactsTotalBytes) {
    throw handoffError(
      CODES.HANDOFF_ARTIFACTS_TOTAL_TOO_LARGE,
      `产物合计 ${artifactBytesTotal} 字节超过上限 ${HANDOFF_LIMITS.maxArtifactsTotalBytes}`,
      { bytes: artifactBytesTotal, limit: HANDOFF_LIMITS.maxArtifactsTotalBytes },
    );
  }

  const references = buildReferences(includedCards, cardMap);

  const exclusions = dependencyOrder
    .filter(id => excludedIds.has(id))
    .map(id => ({
      cardId: id,
      title: typeof cardMap.get(id).title === 'string' ? cardMap.get(id).title : '',
      parentIds: parentIdsOf(cardMap.get(id)),
    }));

  const unsent = [];
  for (const id of dependencyOrder) {
    const item = buildUnsent(cardMap.get(id));
    if (item) unsent.push(item);
  }

  const context = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    source: { canvasId: source.canvasId, revision: source.revision, targetCardId },
    agentId,
    nextStep,
    nodes,
    references: references.order,
    referenceSources: references.sources,
    artifactIds: artifactState.order,
    exclusions,
    omissions: { localNoticeCount },
    unsent,
    notices: [],
    stats: {},
  };
  const validated = validateHandoffContext(context);
  // 深链与体积错误在协议层抛出；这里再兜底一次"不要交给调用方半成品"
  if (validated.stats.transcriptBytes > HANDOFF_LIMITS.maxTranscriptBytes - HANDOFF_LIMITS.fileIndexReserveBytes) {
    throw handoffError(
      CODES.HANDOFF_TRANSCRIPT_TOO_LARGE,
      `转录正文 ${validated.stats.transcriptBytes} 字节超过上限`,
      { bytes: validated.stats.transcriptBytes, limit: HANDOFF_LIMITS.maxTranscriptBytes - HANDOFF_LIMITS.fileIndexReserveBytes },
    );
  }
  return validated;
}

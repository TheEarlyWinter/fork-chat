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
import {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_LIMITS,
  HANDOFF_ERROR_CODES as CODES,
  HANDOFF_NOTICE_CODES as NOTICES,
  handoffError,
  validateHandoffContext,
} from './fork-handoff-contract.js';

const ARTIFACT_ID_REGEX = /^[a-f0-9]{32}$/;
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
    if (card.contextRefs !== undefined && card.contextRefs !== null && !Array.isArray(card.contextRefs)) {
      throw invalidSnapshot(`卡片 ${card.id} 的 references 必须是数组`);
    }
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
 */
function collectDependencyOrder(cardMap, targetCardId) {
  const state = new Map([[targetCardId, 1]]);
  const finished = [];
  const stack = [{ id: targetCardId, cursor: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const parents = parentIdsOf(cardMap.get(frame.id));
    if (frame.cursor < parents.length) {
      const parentId = parents[frame.cursor++];
      const parentState = state.get(parentId) ?? 0;
      if (parentState === 1) throw handoffError(CODES.HANDOFF_CYCLE, `父依赖成环：${parentId} → ${frame.id}`);
      if (parentState === 2) continue;
      if (!cardMap.has(parentId)) {
        throw handoffError(CODES.HANDOFF_MISSING_PARENT, `卡片 ${frame.id} 的父卡片 ${parentId} 不在快照里`);
      }
      state.set(parentId, 1);
      stack.push({ id: parentId, cursor: 0 });
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
  const list = Array.isArray(message.attachments) ? message.attachments : [];
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
  const receipts = [
    ...(Array.isArray(message.artifacts) ? message.artifacts : []),
    ...(Array.isArray(message.artifactRefs) ? message.artifactRefs : []),
  ];
  const ids = [];
  for (const raw of receipts) {
    if (!isPlainObject(raw)) throw invalidSnapshot(`卡片 ${cardId} 的产物元数据不是对象`);
    if (typeof raw.artifactId !== 'string' || !ARTIFACT_ID_REGEX.test(raw.artifactId)) {
      throw handoffError(CODES.HANDOFF_INVALID_ARTIFACT, `卡片 ${cardId} 的产物标识不合法`);
    }
    if (!Number.isSafeInteger(raw.bytes) || raw.bytes <= 0) {
      throw handoffError(CODES.HANDOFF_INVALID_ARTIFACT, `卡片 ${cardId} 的产物 ${raw.artifactId} 缺少体积信息`);
    }
    if (raw.bytes > HANDOFF_LIMITS.maxArtifactBytes) {
      throw handoffError(
        CODES.HANDOFF_ARTIFACT_TOO_LARGE,
        `产物 ${raw.artifactId} 有 ${raw.bytes} 字节，超过单产物上限 ${HANDOFF_LIMITS.maxArtifactBytes}`,
        { bytes: raw.bytes, limit: HANDOFF_LIMITS.maxArtifactBytes },
      );
    }
    if (!state.bytes.has(raw.artifactId)) {
      if (state.bytes.size >= HANDOFF_LIMITS.maxArtifacts) {
        throw handoffError(
          CODES.HANDOFF_TOO_MANY_ARTIFACTS,
          `产物数量超过上限 ${HANDOFF_LIMITS.maxArtifacts}`,
          { limit: HANDOFF_LIMITS.maxArtifacts },
        );
      }
      state.bytes.set(raw.artifactId, raw.bytes);
      state.order.push(raw.artifactId);
    } else {
      state.deduped = true;
    }
    if (!ids.includes(raw.artifactId)) ids.push(raw.artifactId);
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

function buildReferences(includedCards, cardMap) {
  const entries = new Map();
  const order = [];
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
      let status = 'snapshot';
      if (!sourceCard) status = 'source-deleted';
      else if (getContextMode(sourceCard) === 'exclude') status = 'source-excluded';
      const text = status === 'source-excluded' ? '' : raw.text;
      const sourceTitle = typeof raw.sourceTitle === 'string' ? raw.sourceTitle : '';
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
  return { order, deduped, deletedSources, excludedSources };
}

function buildNotices({ targetExcluded, exclusions, failedCount, localNoticeCount, references, artifacts, hasOriginalBodies, nextStep }) {
  const notices = [];
  const push = (code, message) => notices.push({ code, message });
  push(NOTICES.SNAPSHOT_ONLY, '导入内容只是 App 当前保存的快照，不是原始文件、原始会话或实时画布的逐字副本。');
  if (targetExcluded) {
    push(NOTICES.TARGET_EXCLUDED, '目标节点自身被标记为不向后代贡献正文；本次仍将其纳入，且不修改它的排除设置。');
  }
  if (exclusions.length) {
    push(
      NOTICES.EXCLUDED_ANCESTORS,
      `${exclusions.length} 个祖先节点按现有上下文策略被排除，未导入其正文；本次不代表整条原始对话链无遗漏。`,
    );
  }
  if (failedCount) {
    push(NOTICES.FAILED_MESSAGES, `${failedCount} 条消息未正常完成（失败/中断/部分回答），已逐条标注，不能当作已完成结论。`);
  }
  if (localNoticeCount) {
    push(NOTICES.LOCAL_NOTICES_OMITTED, `${localNoticeCount} 条本地提示不是业务内容，未导入。`);
  }
  if (references.deletedSources) {
    push(NOTICES.REFERENCE_SOURCE_DELETED, `${references.deletedSources} 条引用的来源已不可定位，只保留保存时的引用快照。`);
  }
  if (references.excludedSources) {
    push(NOTICES.REFERENCE_SOURCE_EXCLUDED, `${references.excludedSources} 条引用因来源被排除而未导入正文。`);
  }
  if (references.deduped) {
    push(NOTICES.DUPLICATE_REFERENCES_DEDUPED, '相同内容的重复引用已合并，引用位置全部保留。');
  }
  if (hasOriginalBodies) {
    push(NOTICES.ORIGINALS_NOT_RETAINED, '资料与附件的原文件没有随交接保留，这里只有 App 保存的解析正文。');
  }
  if (artifacts.deduped) {
    push(NOTICES.DUPLICATE_ARTIFACTS_DEDUPED, '同一产物在多个位置出现，按不可变产物标识去重交付。');
  }
  if (nextStep) {
    push(NOTICES.NEXT_STEP_PENDING, '下一步要求只是写入交接正文的待执行文字，不会自动发送，也不会启动模型。');
  }
  return notices;
}

/**
 * 组装并校验一次交接上下文。
 *
 * 返回的 HandoffContext 已由协议层白名单重建、统计按实际内容重算，并通过体积检查。
 * 统计、指纹和正文都不采信调用方提供的派生值。
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
  const reached = new Set(dependencyOrder);
  const excludedIds = new Set();
  for (const id of dependencyOrder) {
    if (id !== targetCardId && getContextMode(cardMap.get(id)) === 'exclude') excludedIds.add(id);
  }
  const includedIds = dependencyOrder.filter(id => !excludedIds.has(id));
  const includedCards = includedIds.map(id => cardMap.get(id));

  const artifactState = { bytes: new Map(), order: [], deduped: false };
  const nodes = [];
  let failedCount = 0;
  let localNoticeCount = 0;
  let hasOriginalBodies = false;

  for (const card of includedCards) {
    const doc = buildDoc(card);
    if (doc) hasOriginalBodies = true;
    if (!Array.isArray(card.messages)) throw invalidSnapshot(`卡片 ${card.id} 的 messages 必须是数组`);
    const messages = [];
    for (const [index, raw] of card.messages.entries()) {
      const message = buildMessage(raw, card.id, index, artifactState);
      if (!message) {
        localNoticeCount++;
        continue;
      }
      if (message.status !== 'ok') failedCount++;
      if (message.attachments.length) hasOriginalBodies = true;
      messages.push(message);
    }
    nodes.push({
      cardId: card.id,
      title: typeof card.title === 'string' ? card.title : '',
      parentIds: parentIdsOf(card),
      contextMode: getContextMode(card),
      doc,
      messages,
      artifactIds: [...new Set(messages.flatMap(message => message.artifactIds))],
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
  const messageCount = nodes.reduce((sum, node) => sum + node.messages.length, 0);
  const docCount = nodes.filter(node => node.doc).length;
  if (messageCount === 0 && docCount === 0 && references.order.length === 0) {
    throw handoffError(CODES.HANDOFF_NO_CONTENT, '所选分支没有可导入的已保存内容');
  }

  const exclusions = dependencyOrder
    .filter(id => excludedIds.has(id))
    .map(id => ({ cardId: id, title: typeof cardMap.get(id).title === 'string' ? cardMap.get(id).title : '' }));

  const notices = buildNotices({
    targetExcluded: getContextMode(cardMap.get(targetCardId)) === 'exclude',
    exclusions,
    failedCount,
    localNoticeCount,
    references,
    artifacts: artifactState,
    hasOriginalBodies,
    nextStep,
  });

  const context = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    source: { canvasId: source.canvasId, revision: source.revision, targetCardId },
    agentId,
    nextStep,
    nodes,
    references: references.order,
    artifactIds: artifactState.order,
    exclusions,
    notices,
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

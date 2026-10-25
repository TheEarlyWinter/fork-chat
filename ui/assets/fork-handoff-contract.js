/**
 * 分支交接的共享纯协议：DTO 版本、限额、错误码、白名单校验与格式化。
 *
 * 这个模块同时被浏览器和 Node 后端导入，因此不碰 DOM、SDK、文件系统和宿主调用。
 * 限额只在这里写一份；别处引用 HANDOFF_LIMITS，不复制数值。
 * 客户端提交的正文、统计和指纹都不可信：服务端用 validateHandoffContext 重建白名单，
 * 再用 formatHandoffTranscript 重新生成正文，派生字段一律按实际内容重算。
 */

import { ID_REGEX } from './fork-snapshot.js';
import {
  HANDOFF_NOTICE_CODES,
  buildHandoffNotices,
  hasHandoffBusinessContent,
} from './fork-handoff-definitions.js';
import { renderTranscriptBody } from './fork-handoff-transcript.js';

export { HANDOFF_NOTICE_CODES };

export const HANDOFF_SCHEMA_VERSION = 1;

/** App 自身的保护值，不是对宿主或模型窗口容量的承诺 */
export const HANDOFF_LIMITS = Object.freeze({
  /** 节点数沿用快照上限 */
  maxNodes: 300,
  /** 最终 UTF-8 转录正文上限 */
  maxTranscriptBytes: 2 * 1024 * 1024,
  /** prepare JSON 上限 */
  maxPrepareJsonBytes: 4 * 1024 * 1024,
  /** 单个产物上限，沿用现有 artifact store */
  maxArtifactBytes: 16 * 1024 * 1024,
  /** 每次最多交付的产物数 */
  maxArtifacts: 16,
  /** 一次动作产物合计上限 */
  maxArtifactsTotalBytes: 64 * 1024 * 1024,
  /** 正文里为宿主文件索引预留的空间 */
  fileIndexReserveBytes: 64 * 1024,
  /** 下一步要求的字符上限（App 保护值） */
  maxNextStepChars: 8000,
  /** 单条消息 / 资料正文的字符上限，避免在体积检查前构造超大字符串 */
  maxTextChars: 4 * 1024 * 1024,
  /** 单条消息最多携带的已发送附件，与快照一致 */
  maxAttachmentsPerMessage: 10,
  /** omissions.localNoticeCount 的上限，与快照的消息总量一致 */
  maxOmittedLocalNotices: 10000,
  /** 预览用未发送项：每卡最多 20 个暂存附件名 */
  maxUnsentAttachments: 20,
  /** 草稿字符数上限（只作预览计数，不装正文） */
  maxUnsentDraftChars: 100000,
  /** 暂存附件丢失计数上限 */
  maxStagedAttachmentsDropped: 10000,
});

export const HANDOFF_ERROR_CODES = Object.freeze(Object.fromEntries([
  'HANDOFF_INVALID_SNAPSHOT',
  'HANDOFF_TARGET_MISSING',
  'HANDOFF_DUPLICATE_ID',
  'HANDOFF_MISSING_PARENT',
  'HANDOFF_CYCLE',
  'HANDOFF_ORDER',
  'HANDOFF_UNREACHABLE_NODE',
  'HANDOFF_TOO_MANY_NODES',
  'HANDOFF_NO_CONTENT',
  'HANDOFF_INVALID_SOURCE',
  'HANDOFF_INVALID_AGENT',
  'HANDOFF_INVALID_NEXT_STEP',
  'HANDOFF_GENERATING',
  'HANDOFF_UNKNOWN_MESSAGE_STATUS',
  'HANDOFF_DOC_MISSING_CONTENT',
  'HANDOFF_ATTACHMENT_MISSING_CONTENT',
  'HANDOFF_DOC_TRUNCATED',
  'HANDOFF_DOC_INTEGRITY_UNKNOWN',
  'HANDOFF_ATTACHMENT_TRUNCATED',
  'HANDOFF_ATTACHMENT_DROPPED',
  'HANDOFF_ATTACHMENT_INTEGRITY_UNKNOWN',
  'HANDOFF_REFERENCE_CONFLICT',
  'HANDOFF_INVALID_REFERENCE',
  'HANDOFF_INVALID_ARTIFACT',
  'HANDOFF_ARTIFACT_CONFLICT',
  'HANDOFF_TOO_MANY_ARTIFACTS',
  'HANDOFF_ARTIFACT_TOO_LARGE',
  'HANDOFF_ARTIFACTS_TOTAL_TOO_LARGE',
  'HANDOFF_TRANSCRIPT_TOO_LARGE',
  'HANDOFF_PREPARE_TOO_LARGE',
  'HANDOFF_INVALID_CONTEXT',
  'HANDOFF_INVALID_FILE',
  'HANDOFF_FILE_INDEX_TOO_LARGE',
].map(code => [code, code])));

const ARTIFACT_ID_REGEX = /^[a-f0-9]{32}$/;
/** 产物标识的唯一共享定义：编译器与校验器都不再各自维护一份正则 */
export { ARTIFACT_ID_REGEX };
const TOKEN_REGEX = /^[A-Za-z0-9_.:@~+-]{1,200}$/;
const MIME_REGEX = /^[A-Za-z0-9!#$&^_.+-]{1,60}\/[A-Za-z0-9!#$&^_.+-]{1,60}$/;
const MESSAGE_STATUSES = Object.freeze(['ok', 'failed', 'cancelled', 'partial']);

export function handoffError(code, message, details) {
  const error = new Error(message);
  error.name = 'HandoffError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export function contextByteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message, code = HANDOFF_ERROR_CODES.HANDOFF_INVALID_CONTEXT) {
  return handoffError(code, message);
}

/** 标签类元数据：去掉控制字符与首尾空白，按码点截断 */
function sanitizeLabel(value, max, labelName) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(`${labelName}必须是字符串`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return Array.from(cleaned).slice(0, max).join('');
}

function sanitizeToken(value, labelName, { allowEmpty = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowEmpty) return '';
    throw invalid(`${labelName}不能为空`);
  }
  if (typeof value !== 'string' || !TOKEN_REGEX.test(value)) throw invalid(`${labelName}格式不合法`);
  return value;
}

/** 画布版本可能是存储里的整数修订，也可能是指纹：只要求可读且不带控制字符 */
function sanitizeRevision(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || value === '') throw invalid('画布版本不能为空');
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid('画布版本格式不合法');
  return value;
}

function requireString(value, labelName, { max = HANDOFF_LIMITS.maxTextChars } = {}) {
  if (typeof value !== 'string') throw invalid(`${labelName}必须是字符串`);
  if (value.length > max) throw invalid(`${labelName}超过 ${max} 字符`);
  return value;
}

function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lines++;
  }
  return lines;
}

function normalizeDoc(raw) {
  if (!isPlainObject(raw)) throw invalid('资料必须是非空对象');
  const content = requireString(raw.content, '资料正文');
  if (content.trim() === '') throw invalid('资料正文不能为空');
  return {
    name: sanitizeLabel(raw.name, 200, '资料名称'),
    extension: sanitizeLabel(raw.extension, 50, '资料类型'),
    charCount: content.length,
    lineCount: countLines(content),
    content,
  };
}

function normalizeAttachment(raw, index) {
  if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 个附件不是对象`);
  const content = requireString(raw.content, `第 ${index + 1} 个附件正文`);
  if (content.trim() === '') throw invalid(`第 ${index + 1} 个附件正文不能为空`);
  return {
    name: sanitizeLabel(raw.name, 200, '附件名称'),
    extension: sanitizeLabel(raw.extension, 50, '附件类型'),
    charCount: content.length,
    lineCount: countLines(content),
    content,
  };
}

function normalizeArtifactIdList(value, labelName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${labelName}必须是数组`);
  const seen = new Set();
  const ids = [];
  for (const id of value) {
    if (typeof id !== 'string' || !ARTIFACT_ID_REGEX.test(id)) throw invalid(`${labelName}含非法产物标识`);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > HANDOFF_LIMITS.maxArtifacts) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_TOO_MANY_ARTIFACTS,
      `产物数量 ${ids.length} 超过上限 ${HANDOFF_LIMITS.maxArtifacts}`,
      { count: ids.length, limit: HANDOFF_LIMITS.maxArtifacts },
    );
  }
  return ids;
}

function normalizeMessage(raw, index) {
  if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 条消息不是对象`);
  if (raw.role !== 'user' && raw.role !== 'assistant') throw invalid(`第 ${index + 1} 条消息角色不合法`);
  const text = requireString(raw.text, `第 ${index + 1} 条消息正文`);
  const status = raw.status === undefined ? 'ok' : raw.status;
  if (!MESSAGE_STATUSES.includes(status)) throw invalid(`第 ${index + 1} 条消息状态不合法`);
  if (!Array.isArray(raw.attachments)) throw invalid(`第 ${index + 1} 条消息的附件必须是数组`);
  if (raw.attachments.length > HANDOFF_LIMITS.maxAttachmentsPerMessage) {
    throw invalid(`第 ${index + 1} 条消息的附件数量超过 ${HANDOFF_LIMITS.maxAttachmentsPerMessage}`);
  }
  return {
    role: raw.role,
    text,
    agentName: sanitizeLabel(raw.agentName, 200, '助手名称'),
    status,
    attachments: raw.attachments.map(normalizeAttachment),
    artifactIds: normalizeArtifactIdList(raw.artifactIds, `第 ${index + 1} 条消息的产物列表`),
  };
}

function normalizeNode(raw, index) {
  if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 个节点不是对象`);
  if (typeof raw.cardId !== 'string' || !ID_REGEX.test(raw.cardId)) throw invalid(`第 ${index + 1} 个节点标识不合法`);
  if (!Array.isArray(raw.parentIds)) throw invalid(`节点 ${raw.cardId} 的父节点列表必须是数组`);
  const parentIds = [];
  for (const parentId of raw.parentIds) {
    if (typeof parentId !== 'string' || !ID_REGEX.test(parentId)) throw invalid(`节点 ${raw.cardId} 的父节点标识不合法`);
    if (parentId === raw.cardId) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_CYCLE, `节点 ${raw.cardId} 把自己当成父节点`);
    }
    if (!parentIds.includes(parentId)) parentIds.push(parentId);
  }
  const contextMode = raw.contextMode === undefined ? 'include' : raw.contextMode;
  if (contextMode !== 'include' && contextMode !== 'exclude') throw invalid(`节点 ${raw.cardId} 的上下文标记不合法`);
  if (!Array.isArray(raw.messages)) throw invalid(`节点 ${raw.cardId} 的消息必须是数组`);
  const doc = raw.doc === undefined || raw.doc === null ? null : normalizeDoc(raw.doc);
  return {
    cardId: raw.cardId,
    title: sanitizeLabel(raw.title, 200, '节点标题'),
    parentIds,
    contextMode,
    doc,
    messages: raw.messages.map(normalizeMessage),
    artifactIds: normalizeArtifactIdList(raw.artifactIds, `节点 ${raw.cardId} 的产物列表`),
  };
}

function normalizeExclusion(raw, index) {
  if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 个排除项不是对象`);
  if (typeof raw.cardId !== 'string' || !ID_REGEX.test(raw.cardId)) throw invalid(`第 ${index + 1} 个排除项标识不合法`);
  if (!Array.isArray(raw.parentIds)) throw invalid(`第 ${index + 1} 个排除项的父节点列表必须是数组`);
  const parentIds = [];
  for (const parentId of raw.parentIds) {
    if (typeof parentId !== 'string' || !ID_REGEX.test(parentId)) throw invalid(`第 ${index + 1} 个排除项的父节点标识不合法`);
    if (parentId === raw.cardId) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_CYCLE, `排除项 ${raw.cardId} 把自己当成父节点`);
    }
    if (!parentIds.includes(parentId)) parentIds.push(parentId);
  }
  return {
    cardId: raw.cardId,
    title: sanitizeLabel(raw.title, 200, '排除项标题'),
    parentIds,
  };
}

function normalizeReferenceSource(raw, index) {
  if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 条引用来源不是对象`);
  if (typeof raw.cardId !== 'string' || !ID_REGEX.test(raw.cardId)) throw invalid(`第 ${index + 1} 条引用来源标识不合法`);
  if (typeof raw.exists !== 'boolean') throw invalid(`第 ${index + 1} 条引用来源缺少存在标记`);
  if (!raw.exists) {
    if (raw.contextMode !== null) throw invalid(`第 ${index + 1} 条引用来源已不存在，不能声明上下文标记`);
    return { cardId: raw.cardId, exists: false, contextMode: null };
  }
  if (raw.contextMode !== 'include' && raw.contextMode !== 'exclude') {
    throw invalid(`第 ${index + 1} 条引用来源的上下文标记不合法`);
  }
  return { cardId: raw.cardId, exists: true, contextMode: raw.contextMode };
}

function normalizeReference(raw, index, nodeIds, sourceMap) {
  if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 条引用不是对象`);
  if (typeof raw.refId !== 'string' || !ID_REGEX.test(raw.refId)) throw invalid(`第 ${index + 1} 条引用标识不合法`);
  if (typeof raw.sourceCardId !== 'string' || !ID_REGEX.test(raw.sourceCardId)) throw invalid(`第 ${index + 1} 条引用的来源标识不合法`);
  const source = sourceMap.get(raw.sourceCardId);
  if (!source) throw invalid(`第 ${index + 1} 条引用的来源缺少元数据`);
  // 状态与导入标记由来源元数据重算，不采信客户端提交的派生值
  const excludedSource = source.exists && source.contextMode === 'exclude';
  const status = !source.exists ? 'source-deleted' : excludedSource ? 'source-excluded' : 'snapshot';
  const shouldInclude = !excludedSource;
  const text = requireString(raw.text, `第 ${index + 1} 条引用正文`);
  if (!shouldInclude && text !== '') throw invalid(`第 ${index + 1} 条引用属于被排除来源，不能携带正文`);
  if (shouldInclude && text.trim() === '') throw invalid(`第 ${index + 1} 条引用正文为空`);
  if (!Array.isArray(raw.positions) || raw.positions.length === 0) throw invalid(`第 ${index + 1} 条引用缺少引用位置`);
  const positions = [];
  for (const owner of raw.positions) {
    if (typeof owner !== 'string' || !nodeIds.has(owner)) throw invalid(`第 ${index + 1} 条引用的位置不是已纳入节点`);
    if (!positions.includes(owner)) positions.push(owner);
  }
  // 自引用在 DTO 层也要拒绝：builder 拦住不等于服务端拦住
  if (positions.includes(raw.sourceCardId)) {
    throw invalid(`第 ${index + 1} 条引用的来源就是引用位置本身`);
  }
  return {
    refId: raw.refId,
    sourceCardId: raw.sourceCardId,
    sourceTitle: sanitizeLabel(raw.sourceTitle, 200, '引用来源标题'),
    text: shouldInclude ? text : '',
    status,
    included: shouldInclude,
    positions,
  };
}

function normalizeNotice(raw, index) {
  if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 条说明不是对象`);
  if (typeof raw.code !== 'string' || !Object.hasOwn(HANDOFF_NOTICE_CODES, raw.code)) {
    throw invalid(`第 ${index + 1} 条说明的代码不在共享常量里`);
  }
  const message = requireString(raw.message, `第 ${index + 1} 条说明正文`, { max: 500 });
  return { code: raw.code, message };
}

/** 客户端只能声明“丢弃了多少条本地提示”，不能自带正文或任意计数 */
function normalizeOmissions(value) {
  if (value === undefined) return { localNoticeCount: 0 };
  if (!isPlainObject(value)) throw invalid('omissions 必须是对象');
  const count = value.localNoticeCount;
  if (!Number.isSafeInteger(count) || count < 0 || count > HANDOFF_LIMITS.maxOmittedLocalNotices) {
    throw invalid(`omissions.localNoticeCount 必须是 0..${HANDOFF_LIMITS.maxOmittedLocalNotices} 的整数`);
  }
  return { localNoticeCount: count };
}

/**
 * 未发送项只作为预览元数据：不装草稿正文、不装暂存附件内容，
 * 卡片必须在依赖图内，计数有界，空条目直接拒绝。
 */
function normalizeUnsent(value, graphIds) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('unsent 必须是数组');
  if (value.length > HANDOFF_LIMITS.maxNodes) throw invalid('unsent 条目数量超过上限');
  const seen = new Set();
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) throw invalid(`第 ${index + 1} 个未发送项不是对象`);
    if (typeof raw.cardId !== 'string' || !ID_REGEX.test(raw.cardId) || !graphIds.has(raw.cardId)) {
      throw invalid(`第 ${index + 1} 个未发送项的卡片不在依赖范围内`);
    }
    if (seen.has(raw.cardId)) throw invalid(`未发送项的卡片 ${raw.cardId} 重复`);
    seen.add(raw.cardId);
    if (typeof raw.hasDraft !== 'boolean') throw invalid(`第 ${index + 1} 个未发送项缺少草稿标记`);
    const draftChars = raw.draftChars;
    if (!Number.isSafeInteger(draftChars) || draftChars < 0 || draftChars > HANDOFF_LIMITS.maxUnsentDraftChars) {
      throw invalid(`第 ${index + 1} 个未发送项的草稿字符数不合法`);
    }
    if (raw.hasDraft !== (draftChars > 0)) throw invalid(`第 ${index + 1} 个未发送项的草稿标记与字符数不一致`);
    if (!Array.isArray(raw.attachments)) throw invalid(`第 ${index + 1} 个未发送项的附件必须是数组`);
    if (raw.attachments.length > HANDOFF_LIMITS.maxUnsentAttachments) {
      throw invalid(`第 ${index + 1} 个未发送项的附件数量超过 ${HANDOFF_LIMITS.maxUnsentAttachments}`);
    }
    const attachments = raw.attachments.map((item, attIndex) => {
      if (!isPlainObject(item)) throw invalid(`第 ${index + 1} 个未发送项的第 ${attIndex + 1} 个附件不是对象`);
      const name = sanitizeLabel(item.name, 200, '未发送附件名');
      if (!name) throw invalid(`第 ${index + 1} 个未发送项的第 ${attIndex + 1} 个附件缺少名称`);
      if (typeof item.contentTruncated !== 'boolean') throw invalid(`第 ${index + 1} 个未发送项的第 ${attIndex + 1} 个附件缺少裁切标记`);
      return { name, contentTruncated: item.contentTruncated };
    });
    const attachmentsDropped = raw.attachmentsDropped;
    if (!Number.isSafeInteger(attachmentsDropped) || attachmentsDropped < 0
      || attachmentsDropped > HANDOFF_LIMITS.maxStagedAttachmentsDropped) {
      throw invalid(`第 ${index + 1} 个未发送项的丢失附件计数不合法`);
    }
    if (!raw.hasDraft && attachments.length === 0 && attachmentsDropped === 0) {
      throw invalid(`第 ${index + 1} 个未发送项没有实际内容`);
    }
    return { cardId: raw.cardId, hasDraft: raw.hasDraft, draftChars, attachments, attachmentsDropped };
  });
}

function normalizeNextStep(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_NEXT_STEP, '下一步要求必须是字符串');
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.includes('\u0000')) throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_NEXT_STEP, '下一步要求含非法字符');
  if (Array.from(normalized).length > HANDOFF_LIMITS.maxNextStepChars) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_INVALID_NEXT_STEP,
      `下一步要求超过 ${HANDOFF_LIMITS.maxNextStepChars} 字`,
      { chars: Array.from(normalized).length, limit: HANDOFF_LIMITS.maxNextStepChars },
    );
  }
  return normalized;
}

function recomputeStats(context) {
  let messageCount = 0;
  let attachmentCount = 0;
  let docCount = 0;
  for (const node of context.nodes) {
    if (node.doc) docCount++;
    for (const message of node.messages) {
      messageCount++;
      attachmentCount += message.attachments.length;
    }
  }
  const artifacts = new Set();
  for (const node of context.nodes) {
    for (const id of node.artifactIds) artifacts.add(id);
    for (const message of node.messages) for (const id of message.artifactIds) artifacts.add(id);
  }
  return {
    nodeCount: context.nodes.length,
    messageCount,
    docCount,
    attachmentCount,
    referenceCount: context.references.length,
    artifactCount: artifacts.size,
    transcriptBytes: 0,
  };
}

/**
 * 白名单重建 HandoffContext 并重算派生字段。
 *
 * 未知字段直接丢弃，客户端自报的统计、指纹和正文长度都不采信。
 * 只接受结构合法、顺序已拓扑、引用不夹带被排除来源正文的 DTO。
 */
export function validateHandoffContext(value) {
  if (!isPlainObject(value)) throw invalid('交接上下文必须是对象');
  if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION) throw invalid(`只接受 schemaVersion ${HANDOFF_SCHEMA_VERSION}`);
  if (!isPlainObject(value.source)) throw invalid('缺少来源信息');
  const source = {
    canvasId: sanitizeToken(value.source.canvasId, '画布标识'),
    revision: sanitizeRevision(value.source.revision),
    targetCardId: sanitizeToken(value.source.targetCardId, '目标节点标识'),
  };
  if (!ID_REGEX.test(source.targetCardId)) throw invalid('目标节点标识格式不合法');
  const agentId = sanitizeToken(value.agentId, '目标 Agent');
  const nextStep = normalizeNextStep(value.nextStep);
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) throw invalid('交接上下文没有节点');
  if (value.nodes.length > HANDOFF_LIMITS.maxNodes) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_TOO_MANY_NODES,
      `节点数量 ${value.nodes.length} 超过上限 ${HANDOFF_LIMITS.maxNodes}`,
      { count: value.nodes.length, limit: HANDOFF_LIMITS.maxNodes },
    );
  }
  const nodes = value.nodes.map(normalizeNode);
  const nodeIds = new Set();
  for (const node of nodes) {
    if (nodeIds.has(node.cardId)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_DUPLICATE_ID, `节点标识重复：${node.cardId}`);
    }
    nodeIds.add(node.cardId);
  }
  if (!nodeIds.has(source.targetCardId)) throw invalid('目标节点不在节点列表里');
  if (!Array.isArray(value.exclusions)) throw invalid('排除项必须是数组');
  const exclusions = value.exclusions.map(normalizeExclusion);
  const excludedIds = new Set();
  for (const item of exclusions) {
    if (nodeIds.has(item.cardId)) throw invalid(`排除项 ${item.cardId} 同时出现在节点列表里`);
    if (excludedIds.has(item.cardId)) throw invalid(`排除项 ${item.cardId} 重复`);
    excludedIds.add(item.cardId);
  }
  if (excludedIds.has(source.targetCardId)) throw invalid('目标节点不能同时是排除项');

  // 依赖图 = nodes + exclusions；两者合计计入节点上限，不能用大量排除项绕过
  const totalCards = nodes.length + exclusions.length;
  if (totalCards > HANDOFF_LIMITS.maxNodes) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_TOO_MANY_NODES,
      `节点与排除项合计 ${totalCards} 超过上限 ${HANDOFF_LIMITS.maxNodes}`,
      { count: totalCards, limit: HANDOFF_LIMITS.maxNodes },
    );
  }
  const graph = new Map();
  for (const node of nodes) graph.set(node.cardId, { parentIds: node.parentIds, contextMode: node.contextMode });
  for (const item of exclusions) graph.set(item.cardId, { parentIds: item.parentIds, contextMode: 'exclude' });

  // 从目标反向遍历：缺父、环、不可达节点/排除项都拒绝
  const visitState = new Map([[source.targetCardId, 1]]);
  const stack = [{ id: source.targetCardId, cursor: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const parents = graph.get(frame.id).parentIds;
    if (frame.cursor < parents.length) {
      const parentId = parents[frame.cursor++];
      if (!graph.has(parentId)) {
        throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_MISSING_PARENT, `卡片 ${frame.id} 的父节点 ${parentId} 不在上下文里`);
      }
      const parentState = visitState.get(parentId) ?? 0;
      if (parentState === 1) {
        throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_CYCLE, `父依赖成环：${parentId} → ${frame.id}`);
      }
      if (parentState === 2) continue;
      visitState.set(parentId, 1);
      stack.push({ id: parentId, cursor: 0 });
      continue;
    }
    visitState.set(frame.id, 2);
    stack.pop();
  }
  for (const cardId of graph.keys()) {
    if (visitState.get(cardId) !== 2) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_UNREACHABLE_NODE, `卡片 ${cardId} 不在目标节点的依赖路径上`);
    }
  }

  // 包含节点必须保持拓扑顺序；祖先可能隔着被排除的节点，要沿合并图逐层上溯
  const nodeIndex = new Map(nodes.map((node, index) => [node.cardId, index]));
  for (const [index, node] of nodes.entries()) {
    const seen = new Set();
    const pending = [...node.parentIds];
    while (pending.length) {
      const ancestorId = pending.pop();
      if (seen.has(ancestorId)) continue;
      seen.add(ancestorId);
      if (nodeIds.has(ancestorId) && nodeIndex.get(ancestorId) >= index) {
        throw handoffError(
          HANDOFF_ERROR_CODES.HANDOFF_ORDER,
          `节点 ${node.cardId} 的祖先 ${ancestorId} 没有排在它前面（可能成环或不是拓扑序）`,
        );
      }
      for (const parentId of graph.get(ancestorId).parentIds) pending.push(parentId);
    }
  }

  if (!Array.isArray(value.referenceSources)) throw invalid('引用来源元数据必须是数组');
  const referenceSources = [];
  const sourceMap = new Map();
  for (const raw of value.referenceSources) {
    const item = normalizeReferenceSource(raw, referenceSources.length);
    if (sourceMap.has(item.cardId)) throw invalid(`引用来源 ${item.cardId} 的元数据重复`);
    const inGraph = graph.get(item.cardId);
    if (inGraph) {
      if (!item.exists || item.contextMode !== inGraph.contextMode) {
        throw invalid(`引用来源 ${item.cardId} 的元数据与依赖图不一致`);
      }
    }
    sourceMap.set(item.cardId, item);
    referenceSources.push(item);
  }

  if (!Array.isArray(value.references)) throw invalid('引用列表必须是数组');
  const references = [];
  const seenRefs = new Set();
  for (const raw of value.references) {
    const reference = normalizeReference(raw, references.length, nodeIds, sourceMap);
    if (seenRefs.has(reference.refId)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_REFERENCE_CONFLICT, `引用标识重复：${reference.refId}`);
    }
    seenRefs.add(reference.refId);
    references.push(reference);
  }
  const referencedSources = new Set(references.map(reference => reference.sourceCardId));
  for (const item of referenceSources) {
    if (!referencedSources.has(item.cardId)) throw invalid(`引用来源 ${item.cardId} 未被任何引用使用`);
  }
  if (value.notices !== undefined && !Array.isArray(value.notices)) throw invalid('完整性说明必须是数组');
  (value.notices ?? []).forEach(normalizeNotice);
  const omissions = normalizeOmissions(value.omissions);
  const unsent = normalizeUnsent(value.unsent, new Set([...nodeIds, ...excludedIds]));
  const providedArtifacts = normalizeArtifactIdList(value.artifactIds, '产物列表');
  // 顶层 artifactIds = 节点自身位置 + 消息位置的去重合集；
  // node.artifactIds 只表示节点自己身上的产物，不复制消息 ID，
  // 这样重复统计（notice）可以按原始位置计算。
  const derivedArtifacts = [];
  for (const node of nodes) {
    for (const id of node.artifactIds) if (!derivedArtifacts.includes(id)) derivedArtifacts.push(id);
    for (const message of node.messages) {
      for (const id of message.artifactIds) if (!derivedArtifacts.includes(id)) derivedArtifacts.push(id);
    }
  }
  if (derivedArtifacts.length > HANDOFF_LIMITS.maxArtifacts) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_TOO_MANY_ARTIFACTS,
      `产物数量 ${derivedArtifacts.length} 超过上限 ${HANDOFF_LIMITS.maxArtifacts}`,
      { count: derivedArtifacts.length, limit: HANDOFF_LIMITS.maxArtifacts },
    );
  }
  const extraArtifacts = providedArtifacts.filter(id => !derivedArtifacts.includes(id));
  if (extraArtifacts.length) throw invalid('产物列表含节点里不存在的产物标识');

  // 服务端重算有没有真正的业务内容；空壳节点、仅 nextStep、仅被排除引用都不算
  if (!hasHandoffBusinessContent({ nodes, references, artifactIds: derivedArtifacts })) {
    throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_NO_CONTENT, '所选分支没有可导入的已保存内容');
  }

  const context = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    source,
    agentId,
    nextStep,
    nodes,
    references,
    referenceSources,
    artifactIds: derivedArtifacts,
    exclusions,
    omissions,
    unsent,
    notices: buildHandoffNotices({ source, nodes, references, referenceSources, exclusions, omissions, unsent, nextStep }),
    stats: recomputeStats({ nodes, references }),
  };

  // 用私有渲染计量体积，不调用公开格式化器（否则会递归校验）
  const transcript = renderTranscriptBody(context);
  context.stats.transcriptBytes = contextByteLength(transcript);
  const prepareBytes = contextByteLength(JSON.stringify(context));
  if (prepareBytes > HANDOFF_LIMITS.maxPrepareJsonBytes) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_PREPARE_TOO_LARGE,
      `prepare 载荷 ${prepareBytes} 字节超过上限 ${HANDOFF_LIMITS.maxPrepareJsonBytes}`,
      { bytes: prepareBytes, limit: HANDOFF_LIMITS.maxPrepareJsonBytes },
    );
  }
  return context;
}

function renderFileIndex(files, archiveFile) {
  const receipts = [];
  const normalizeReceipt = (raw, index, isArchive) => {
    if (!isPlainObject(raw)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_FILE, `第 ${index + 1} 个文件回执不是对象`);
    }
    if (typeof raw.fileId !== 'string' || !/^[A-Za-z0-9_.:@~+-]{1,200}$/.test(raw.fileId)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_FILE, `第 ${index + 1} 个文件回执缺少宿主 fileId`);
    }
    const name = sanitizeLabel(raw.name, 120, '文件名');
    if (!name) throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_FILE, `第 ${index + 1} 个文件回执缺少文件名`);
    if (typeof raw.mime !== 'string' || !MIME_REGEX.test(raw.mime)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_FILE, `第 ${index + 1} 个文件回执的 mime 不合法`);
    }
    return { fileId: raw.fileId, name, mime: raw.mime, isArchive };
  };
  if (files !== undefined && files !== null) {
    if (!Array.isArray(files)) throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_FILE, '文件回执必须是数组');
    if (files.length > HANDOFF_LIMITS.maxArtifacts) {
      throw handoffError(
        HANDOFF_ERROR_CODES.HANDOFF_TOO_MANY_ARTIFACTS,
        `文件回执数量 ${files.length} 超过上限 ${HANDOFF_LIMITS.maxArtifacts}`,
        { count: files.length, limit: HANDOFF_LIMITS.maxArtifacts },
      );
    }
    files.forEach((raw, index) => receipts.push(normalizeReceipt(raw, index, false)));
  }
  if (archiveFile !== null && archiveFile !== undefined) {
    receipts.push(normalizeReceipt(archiveFile, receipts.length, true));
  }
  if (receipts.length === 0) return '';
  const lines = [
    '## 交付文件索引',
    '',
    '> 以下文件标识来自宿主回执。登记文件不等于正文已经进入模型上下文。',
    '',
  ];
  for (const receipt of receipts) {
    lines.push(`- ${receipt.fileId} · ${receipt.name} · ${receipt.mime}${receipt.isArchive ? ' · 本次交接 Markdown' : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 重新生成交接正文。
 *
 * 公开入口先白名单校验（校验内部用私有渲染计量，不会递归），
 * 再用同一份私有渲染器输出正文；文件索引只使用宿主回执里的 fileId/name/mime。
 */
export function formatHandoffTranscript(context, { files = [], archiveFile = null } = {}) {
  const validated = validateHandoffContext(context);
  const fileSection = renderFileIndex(files, archiveFile);
  const full = renderTranscriptBody(validated, fileSection);
  const totalBytes = contextByteLength(full);
  const fileBytes = fileSection ? contextByteLength(fileSection) : 0;
  const bodyLimit = HANDOFF_LIMITS.maxTranscriptBytes - HANDOFF_LIMITS.fileIndexReserveBytes;
  const bodyBytes = totalBytes - fileBytes;
  if (bodyBytes > bodyLimit) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_TRANSCRIPT_TOO_LARGE,
      `转录正文 ${bodyBytes} 字节超过上限 ${bodyLimit}`,
      { bytes: bodyBytes, limit: bodyLimit },
    );
  }
  if (fileBytes > HANDOFF_LIMITS.fileIndexReserveBytes) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_FILE_INDEX_TOO_LARGE,
      `文件索引 ${fileBytes} 字节超过预留 ${HANDOFF_LIMITS.fileIndexReserveBytes}`,
      { bytes: fileBytes, limit: HANDOFF_LIMITS.fileIndexReserveBytes },
    );
  }
  if (totalBytes > HANDOFF_LIMITS.maxTranscriptBytes) {
    throw handoffError(
      HANDOFF_ERROR_CODES.HANDOFF_TRANSCRIPT_TOO_LARGE,
      `转录正文 ${totalBytes} 字节超过上限 ${HANDOFF_LIMITS.maxTranscriptBytes}`,
      { bytes: totalBytes, limit: HANDOFF_LIMITS.maxTranscriptBytes },
    );
  }
  return full;
}

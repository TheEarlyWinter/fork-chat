/**
 * Store 的记录与回执校验：只做纯数据结构处理，不碰 fs。
 *
 * 从 handoff-store.js 拆出，避免主文件膨胀；这里定义动作状态机与公开白名单，
 * 保证私有 record 文件里不会混入 owner、路径或正文之外的非白名单字段。
 */
import { HANDOFF_STORE_ERROR_CODES, storeError } from './handoff-store-io.js';

export const STATES = new Set(['prepared', 'creating', 'importing', 'ready', 'failed', 'partial', 'unknown']);
export const TERMINAL = new Set(['ready', 'failed', 'partial', 'unknown']);

const TRANSITIONS = Object.freeze({
  prepared: new Set(['creating']),
  creating: new Set(['importing', 'ready', 'failed', 'partial', 'unknown']),
  importing: new Set(['importing', 'ready', 'failed', 'partial', 'unknown']),
});
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]{1,60}\/[A-Za-z0-9!#$&^_.+-]{1,60}$/;
const ARTIFACT_KEYS = new Set(['artifactId', 'name', 'mime', 'bytes', 'sha256']);
const FILE_KEYS = new Set(['fileId', 'name', 'mime', 'kind', 'artifactId']);
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function invalidContext(message) {
  return storeError(HANDOFF_STORE_ERROR_CODES.INVALID_CONTEXT, message);
}

function invalidArtifact(message) {
  return storeError(HANDOFF_STORE_ERROR_CODES.INVALID_ARTIFACT, message);
}

function invalidState(message) {
  return storeError(HANDOFF_STORE_ERROR_CODES.INVALID_STATE, message);
}

export function validateContext(context) {
  if (!isPlainObject(context)) throw invalidContext('交接上下文必须是对象');
  const source = context.source;
  if (!isPlainObject(source) || !text(source.canvasId) || !text(source.revision) || !text(source.targetCardId)) {
    throw invalidContext('交接上下文缺少来源');
  }
  if (!text(context.agentId)) throw invalidContext('交接上下文缺少目标助手');
  const bytes = context.stats?.transcriptBytes;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_METADATA_BYTES) {
    throw invalidContext('交接上下文缺少有效正文字节数');
  }
  if (!Array.isArray(context.artifactIds) || context.artifactIds.length > 16) {
    throw invalidContext('产物标识列表无效');
  }
  const seen = new Set();
  for (const artifactId of context.artifactIds) {
    if (typeof artifactId !== 'string' || !/^[a-f0-9]{32}$/.test(artifactId) || seen.has(artifactId)) {
      throw invalidContext('产物标识重复或无效');
    }
    seen.add(artifactId);
  }
}

export function sanitizeArtifactMetadata(artifactIds, metadata) {
  if (!Array.isArray(metadata) || metadata.length !== artifactIds.length) {
    throw invalidArtifact('产物元数据与产物标识数量不一致');
  }
  const byId = new Map();
  for (const receipt of metadata) {
    if (!isPlainObject(receipt)) throw invalidArtifact('产物元数据必须是对象');
    for (const key of Object.keys(receipt)) {
      if (!ARTIFACT_KEYS.has(key)) throw invalidArtifact('产物元数据包含非公开字段');
    }
    const { artifactId, name, mime, bytes, sha256 } = receipt;
    if (typeof artifactId !== 'string' || !/^[a-f0-9]{32}$/.test(artifactId)) throw invalidArtifact('产物标识无效');
    if (!text(name) || !MIME_PATTERN.test(String(mime)) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw invalidArtifact('产物元数据字段不完整');
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_METADATA_BYTES) throw invalidArtifact('产物字节数无效');
    if (byId.has(artifactId)) throw invalidArtifact('产物元数据重复');
    byId.set(artifactId, { artifactId, name, mime, bytes, sha256 });
  }
  return artifactIds.map(artifactId => {
    const receipt = byId.get(artifactId);
    if (!receipt) throw invalidArtifact('产物元数据没有覆盖全部产物');
    return receipt;
  });
}

export function validateRecord(record, actionId) {
  if (!isPlainObject(record)
    || record.schemaVersion !== 1
    || record.actionId !== actionId
    || !STATES.has(record.state)
    || typeof record.payloadHash !== 'string'
    || !isPlainObject(record.source)
    || !Array.isArray(record.files)) {
    throw storeError(HANDOFF_STORE_ERROR_CODES.STORE_CORRUPT, '动作记录无效');
  }
  return record;
}

export function toAction(record, state = record.state) {
  return {
    actionId: record.actionId,
    state,
    source: {
      canvasId: record.source.canvasId,
      revision: record.source.revision,
      targetCardId: record.source.targetCardId,
    },
    agentId: record.agentId,
    payloadHash: record.payloadHash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    bytes: record.bytes,
    sessionId: record.sessionId,
    files: record.files.map(file => ({ ...file })),
    entryId: record.entryId,
    errorCode: record.errorCode,
    artifactCount: record.artifactCount,
    artifactBytes: record.artifactBytes,
  };
}

export function sanitizeFile(file) {
  if (!isPlainObject(file)) throw invalidState('文件回执无效');
  for (const key of Object.keys(file)) {
    if (!FILE_KEYS.has(key)) throw invalidState('文件回执包含非公开字段');
  }
  if (!text(file.fileId) || !text(file.name) || !MIME_PATTERN.test(String(file.mime))) {
    throw invalidState('文件回执缺少字段');
  }
  if (file.kind !== 'artifact' && file.kind !== 'archive') {
    throw invalidState('文件种类无效');
  }
  if (file.artifactId !== undefined && (typeof file.artifactId !== 'string' || !/^[a-f0-9]{32}$/.test(file.artifactId))) {
    throw invalidState('文件回执的产物标识无效');
  }
  const copy = { fileId: file.fileId, name: file.name, mime: file.mime, kind: file.kind };
  if (file.artifactId !== undefined) copy.artifactId = file.artifactId;
  return copy;
}

export function nextRecord(record, state, receipt, nowIso) {
  if (TERMINAL.has(record.state)) throw invalidState('终态不可覆盖');
  if (!TRANSITIONS[record.state]?.has(state)) {
    throw invalidState(`不允许从 ${record.state} 转到 ${state}`);
  }
  const next = { ...record, files: record.files.map(file => ({ ...file })) };
  if (receipt === undefined || receipt === null) {
    next.state = state;
    next.updatedAt = nowIso;
    return next;
  }
  if (!isPlainObject(receipt)) throw invalidState('回执必须是对象');

  if (receipt.sessionId !== undefined) {
    if (!text(receipt.sessionId)) throw invalidState('会话标识无效');
    if (next.sessionId !== null && next.sessionId !== receipt.sessionId) throw invalidState('会话标识不可替换');
    next.sessionId = receipt.sessionId;
  }
  if (receipt.entryId !== undefined) {
    if (!text(receipt.entryId)) throw invalidState('条目标识无效');
    if (next.entryId !== null && next.entryId !== receipt.entryId) throw invalidState('条目标识不可替换');
    next.entryId = receipt.entryId;
  }
  if (receipt.errorCode !== undefined) {
    if (typeof receipt.errorCode !== 'string' || receipt.errorCode.length === 0 || receipt.errorCode.length > 120) {
      throw invalidState('错误码无效');
    }
    if (next.errorCode !== null && next.errorCode !== receipt.errorCode) throw invalidState('错误码不可替换');
    next.errorCode = receipt.errorCode;
  }
  if (receipt.files !== undefined) {
    if (!Array.isArray(receipt.files) || receipt.files.length > 16) throw invalidState('文件回执列表无效');
    for (const raw of receipt.files) {
      const file = sanitizeFile(raw);
      const existing = next.files.find(item => item.fileId === file.fileId);
      if (!existing) next.files.push(file);
      else if (JSON.stringify(existing) !== JSON.stringify(file)) throw invalidState('同一文件回执不可改写');
    }
  }
  next.state = state;
  next.updatedAt = nowIso;
  return next;
}

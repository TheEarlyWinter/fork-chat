/**
 * Store 的记录与回执校验：只做纯数据结构处理，不碰 fs。
 *
 * 从 handoff-store.js 拆出，避免主文件膨胀；这里定义动作状态机与公开白名单，
 * 保证私有 record 文件里不会混入 owner、路径或正文之外的非白名单字段。
 *
 * 注意：artifactMetadata 只是内部 material descriptor 的五个字段
 * （artifactId/name/mime/bytes/sha256）。完整的公共 receipt 校验
 * （normalizeArtifactMetadata + 重算 hash/字节）属于 Service；Store 不复制第二份
 * 公共 artifact schema，也不宣称这里做了完整公共回执认证。
 */
import { HANDOFF_STORE_ERROR_CODES, storeError } from './handoff-store-io.js';

export const STATES = new Set(['prepared', 'creating', 'importing', 'ready', 'failed', 'partial', 'unknown']);
export const TERMINAL = new Set(['ready', 'failed', 'partial', 'unknown']);
export const MAX_FILES = 17;
export const MAX_ARTIFACTS = 16;

const TRANSITIONS = Object.freeze({
  prepared: new Set(['creating']),
  creating: new Set(['importing', 'failed', 'partial', 'unknown']),
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

function corruptRecord(message) {
  return storeError(HANDOFF_STORE_ERROR_CODES.STORE_CORRUPT, message);
}

function assertRecordTimes(record) {
  for (const field of ['createdAt', 'updatedAt', 'expiresAt']) {
    const value = record[field];
    if (typeof value !== 'string') throw corruptRecord(`动作记录 ${field} 不是字符串`);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
      throw corruptRecord(`动作记录 ${field} 不是规范 ISO 时间`);
    }
  }
  const created = Date.parse(record.createdAt);
  // updatedAt 可以晚于 expiresAt：合法的长确认会跨过 TTL 结束
  if (created > Date.parse(record.updatedAt)) throw corruptRecord('动作记录时间逆序');
  if (Date.parse(record.expiresAt) <= created) throw corruptRecord('动作记录过期时间不晚于创建时间');
}

/** 时钟回拨时不能把健康动作写成时间逆序；只在内存里取较大值 */
export function nextUpdatedAt(record, nowMs) {
  const current = Date.parse(record.updatedAt);
  const next = Number.isFinite(current) ? Math.max(current, nowMs) : nowMs;
  return new Date(next).toISOString();
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
  if (!Array.isArray(context.artifactIds) || context.artifactIds.length > MAX_ARTIFACTS) {
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

function artifactIdsOf(record, fail) {
  if (!Array.isArray(record.artifactIds)
    || record.artifactIds.length > MAX_ARTIFACTS
    || !record.artifactIds.every(id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id))
    || new Set(record.artifactIds).size !== record.artifactIds.length) {
    throw fail('动作的产物集合无效');
  }
  return record.artifactIds;
}

/** 状态与文件集合的真实前置条件；写路径用 INVALID_STATE，读盘路径用 STORE_CORRUPT */
function assertStateInvariants(record, fail = invalidState) {
  const artifactIds = artifactIdsOf(record, fail);
  if (!Array.isArray(record.files) || record.files.length > MAX_FILES) throw fail('文件回执超过上限');
  const seenArtifacts = new Set();
  let archives = 0;
  for (const file of record.files) {
    if (!isPlainObject(file) || !text(file.fileId) || !text(file.name) || !MIME_PATTERN.test(String(file.mime))) {
      throw fail('文件回执字段无效');
    }
    if (file.kind === 'archive') {
      archives += 1;
      if (file.artifactId !== undefined) throw fail('归档文件不能携带产物标识');
      continue;
    }
    if (file.kind !== 'artifact') throw fail('文件种类无效');
    if (typeof file.artifactId !== 'string' || !artifactIds.includes(file.artifactId)) {
      throw fail('产物文件不在本次冻结的产物集合里');
    }
    if (seenArtifacts.has(file.artifactId)) throw fail('同一产物不能对应多个文件');
    seenArtifacts.add(file.artifactId);
  }
  if (archives > 1) throw fail('一次交接只能有一个归档文件');

  if (record.state === 'prepared' || record.state === 'creating') {
    if (record.files.length || record.sessionId !== null || record.entryId !== null) {
      throw fail('未进入导入阶段不应有宿主回执');
    }
  }
  if (record.state === 'importing' && !text(record.sessionId)) throw fail('导入阶段需要已知会话');
  if (record.state === 'ready') {
    if (!text(record.sessionId) || !text(record.entryId)) throw fail('ready 需要会话与条目标识');
    if (archives !== 1) throw fail('ready 需要一个归档文件');
    for (const artifactId of artifactIds) {
      if (!seenArtifacts.has(artifactId)) throw fail('ready 缺少预期产物文件');
    }
  }
  if (record.state === 'failed') {
    if (record.sessionId !== null || record.entryId !== null || record.files.length > 0) {
      throw fail('已有宿主副作用时不能标记为 failed');
    }
  }
  if (record.state === 'partial') {
    if (record.sessionId === null && record.entryId === null && record.files.length === 0) {
      throw fail('partial 需要已知宿主副作用');
    }
  }
}

export function validateRecord(record, actionId) {
  if (!isPlainObject(record)
    || record.schemaVersion !== 1
    || record.actionId !== actionId
    || !STATES.has(record.state)
    || typeof record.payloadHash !== 'string'
    || !isPlainObject(record.source)
    || !Array.isArray(record.files)) {
    throw corruptRecord('动作记录无效');
  }
  assertRecordTimes(record);
  assertStateInvariants(record, corruptRecord);
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
  if (file.kind === 'archive' && file.artifactId !== undefined) {
    throw invalidState('归档文件不能携带产物标识');
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
    assertStateInvariants(next);
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
    if (!Array.isArray(receipt.files) || receipt.files.length > MAX_FILES) throw invalidState('文件回执列表无效');
    const incomingArtifacts = new Set();
    for (const raw of receipt.files) {
      const file = sanitizeFile(raw);
      if (file.kind === 'artifact') {
        if (file.artifactId === undefined || !record.artifactIds.includes(file.artifactId)) {
          throw invalidState('产物文件不在本次冻结的产物集合里');
        }
        if (incomingArtifacts.has(file.artifactId)) throw invalidState('同一产物不能对应多个文件');
        incomingArtifacts.add(file.artifactId);
        const other = next.files.find(item => item.artifactId === file.artifactId && item.fileId !== file.fileId);
        if (other) throw invalidState('同一产物不能对应多个文件');
      }
      const existing = next.files.find(item => item.fileId === file.fileId);
      if (!existing) next.files.push(file);
      else if (JSON.stringify(existing) !== JSON.stringify(file)) throw invalidState('同一文件回执不可改写');
    }
    if (next.files.length > MAX_FILES) throw invalidState('文件回执超过上限');
  }
  next.state = state;
  next.updatedAt = nowIso;
  assertStateInvariants(next);
  return next;
}

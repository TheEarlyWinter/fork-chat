/**
 * storage.global 目录索引（最小版，Sol 设计 2.x）。
 *
 * 只帮助找引用，永不授予文件访问权；后端永远按当前可信 context 计算 owner，
 * 不采信索引里的任何字段。职责边界：不访问文件、不判断授权、不碰画布根文档。
 *
 * 限额：32 分区 / 500 条 / 每条 10 binding / 序列化 512 KiB。
 * 失败语义：所有失败向上抛，可见；不删文件、不清空原值、不覆盖其它存储键。
 */

import { normalizeArtifactRevisionFields } from './artifact-contract.js';

const INDEX_KEY = 'fork-chat.artifacts.index.v1';
const INDEX_LOCK = 'fork-chat-artifact-index-v1';
const MAX_PARTITIONS = 32;
const MAX_ENTRIES = 500;
const MAX_BINDINGS_PER_ENTRY = 10;
const MAX_SERIALIZED_BYTES = 512 * 1024;

const indexError = (code, message) => Object.assign(new Error(message), { code });

function validateRoot(raw) {
  if (raw === undefined || raw === null) {
    return { schemaVersion: 1, revision: 0, updatedAt: '', partitions: {} };
  }
  const looksValid = raw && typeof raw === 'object' && raw.schemaVersion === 1
    && typeof raw.revision === 'number' && Number.isFinite(raw.revision)
    && raw.partitions && typeof raw.partitions === 'object';
  if (!looksValid) throw indexError('ARTIFACT_INDEX_CORRUPT', '目录索引损坏，已保留原值，未做任何修改');
  return structuredClone(raw);
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object') return null;
  const out = {};
  for (const field of ['canvasId', 'cardId', 'requestId']) {
    if (typeof binding[field] === 'string' && binding[field].trim()) out[field] = binding[field].slice(0, 100);
  }
  return Object.keys(out).length ? out : null;
}

function sameBinding(a, b) {
  return (a.canvasId || '') === (b.canvasId || '')
    && (a.cardId || '') === (b.cardId || '')
    && (a.requestId || '') === (b.requestId || '');
}

export function createArtifactIndexStore({ hana, locks, now = () => new Date().toISOString() }) {
  if (!hana?.storage?.global || typeof hana.storage.global.get !== 'function' || typeof hana.storage.global.set !== 'function') {
    throw new TypeError('artifact index store requires hana.storage.global with get/set');
  }
  if (!locks?.request || typeof locks.request !== 'function') {
    throw new TypeError('artifact index store requires Web Locks (locks.request)');
  }
  const storage = hana.storage.global;

  async function write(mutator) {
    // 加锁→重读→校验→深拷贝→改→revision+1→set；锁内失败不改原值
    return locks.request(INDEX_LOCK, 'exclusive', async () => {
      const root = validateRoot(await storage.get(INDEX_KEY));
      const changed = mutator(root);
      if (!changed) return;
      root.updatedAt = now();
      root.revision = Number(root.revision || 0) + 1;
      const serialized = JSON.stringify(root);
      if (serialized.length > MAX_SERIALIZED_BYTES) throw indexError('ARTIFACT_INDEX_LIMIT', '目录索引超过 512 KiB 上限，本次未保存；文件本身未受影响');
      await storage.set(INDEX_KEY, root);
    });
  }

  async function upsert(scopeKey, metadata, binding) {
    if (typeof scopeKey !== 'string' || !/^[0-9a-f]{64}$/.test(scopeKey)) throw indexError('ARTIFACT_INDEX_INVALID', '索引分区键无效');
    if (!metadata?.artifactId || !/^[0-9a-f]{32}$/.test(metadata.artifactId)) throw indexError('ARTIFACT_INDEX_INVALID', '索引条目标识无效');
    const revision = normalizeArtifactRevisionFields(metadata);
    if (!revision) throw indexError('ARTIFACT_INDEX_INVALID', '索引版本信息无效');
    const normalizedBinding = normalizeBinding(binding);
    if (!normalizedBinding) throw indexError('ARTIFACT_INDEX_INVALID', '索引绑定信息无效');
    let outcome = 'skipped';
    await write(root => {
      const partition = root.partitions[scopeKey] || (root.partitions[scopeKey] = { ownerScheme: 'principal-v1', entries: {} });
      if (Object.keys(root.partitions).length > MAX_PARTITIONS) throw indexError('ARTIFACT_INDEX_LIMIT', '索引分区数超限，本次未保存');
      const existing = partition.entries[metadata.artifactId];
      if (existing) {
        const duplicate = existing.bindings.some(b => sameBinding(b, normalizedBinding));
        if (duplicate && existing.sha256 === metadata.sha256 && existing.bytes === metadata.bytes
          && JSON.stringify(normalizeArtifactRevisionFields(existing)) === JSON.stringify(revision)) { outcome = 'idempotent'; return false; }
        if (!duplicate) {
          if (existing.bindings.length >= MAX_BINDINGS_PER_ENTRY) throw indexError('ARTIFACT_INDEX_LIMIT', '单条目绑定数超限，本次未保存');
          existing.bindings.push(normalizedBinding);
        }
        existing.name = metadata.name;
        existing.bytes = metadata.bytes;
        existing.sha256 = metadata.sha256;
        for (const field of ['revisedFrom', 'version', 'revisionRootId', 'revisionSource', 'revisionNotice']) delete existing[field];
        Object.assign(existing, revision);
        existing.lastSeenAt = now();
        outcome = 'merged';
        return true;
      }
      if (Object.values(root.partitions).reduce((n, p) => n + Object.keys(p.entries).length, 0) >= MAX_ENTRIES) {
        throw indexError('ARTIFACT_INDEX_LIMIT', '索引条目总数超限，本次未保存；文件本身未受影响');
      }
      partition.entries[metadata.artifactId] = {
        artifactId: metadata.artifactId,
        name: String(metadata.name || '').slice(0, 200),
        format: metadata.format,
        mime: metadata.mime,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        createdAt: metadata.createdAt || now(),
        bindings: [normalizedBinding],
        origin: metadata.origin === 'imported' ? 'imported' : 'generated',
        lastSeenAt: now(),
        ...revision,
      };
      outcome = 'created';
      return true;
    });
    return outcome;
  }

  async function read(scopeKey) {
    if (typeof scopeKey !== 'string' || !/^[0-9a-f]{64}$/.test(scopeKey)) throw indexError('ARTIFACT_INDEX_INVALID', '索引分区键无效');
    const root = validateRoot(await storage.get(INDEX_KEY));
    const partition = root.partitions[scopeKey];
    return { ownerScheme: 'principal-v1', entries: partition ? structuredClone(partition.entries) : {} };
  }

  async function markSeen(scopeKey, artifactId) {
    await write(root => {
      const entry = root.partitions[scopeKey]?.entries[artifactId];
      if (!entry) return false;
      entry.lastSeenAt = now();
      return true;
    });
  }

  return { read, upsert, markSeen };
}

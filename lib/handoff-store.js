/**
 * 分支交接的持久动作 Store。
 *
 * 负责准备载荷、32 个 slot 的字节预约、不可覆盖的 claim 防重与 TTL 回收。
 * 不调用宿主、不发网络请求；所有文件操作都走注入的 fs，失败一律上抛，不降级成内存成功。
 *
 * 目录（每个 owner 一个 SHA256 分区）：
 *   handoff/<ownerKey>/slots/<0..31>/<actionId>.json
 *   handoff/<ownerKey>/actions/<actionId>/{payload.json,record.json,publish.decision,dispatch.decision}
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  ACTION_ID_PATTERN,
  HANDOFF_STORE_ERROR_CODES,
  acquireSlot,
  competeDecision,
  ensureDir,
  isMissing,
  listDir,
  newNonce,
  ownerKey,
  readDecision,
  readFileChecked,
  readJsonFile,
  readSlotUsage,
  releaseSlot,
  removeEmptyDir,
  removeFile,
  safeJoin,
  sha256Hex,
  storeError,
  syncDir,
  verifySlotOwned,
  writeExclusive,
  writeFileAtomic,
} from './handoff-store-io.js';

import {
  STATES,
  TERMINAL,
  invalidContext,
  nextRecord,
  sanitizeArtifactMetadata,
  toAction,
  validateContext,
  validateRecord,
} from './handoff-store-record.js';

export { HANDOFF_STORE_ERROR_CODES };

export const HANDOFF_STORE_LIMITS = Object.freeze({
  maxActions: 32,
  maxReservedBytes: 16 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
  maxRecordBytes: 64 * 1024,
  maxPayloadBytes: 24 * 1024 * 1024,
});

const MAX_OWNER_CHARS = 2000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateOwner(owner) {
  if (typeof owner !== 'string' || owner.length === 0 || owner.length > MAX_OWNER_CHARS) {
    throw storeError(HANDOFF_STORE_ERROR_CODES.INVALID_OWNER, '缺少有效的动作所有者');
  }
}

function validateActionId(actionId) {
  if (typeof actionId !== 'string' || !ACTION_ID_PATTERN.test(actionId)) {
    throw storeError(HANDOFF_STORE_ERROR_CODES.INVALID_ACTION_ID, '动作标识无效');
  }
}

async function recordPathPresent(fs, dir) {
  try {
    await fs.lstat(dir);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw storeError(HANDOFF_STORE_ERROR_CODES.STORE_IO, '存储目录读取失败');
  }
}

export function createHandoffStore({ dataDir, fs, clock = () => Date.now(), randomId } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('createHandoffStore 需要 dataDir');
  if (!fs || typeof fs.open !== 'function' || typeof fs.mkdir !== 'function') {
    throw new TypeError('createHandoffStore 需要注入式 fs');
  }
  if (typeof clock !== 'function') throw new TypeError('createHandoffStore 需要 clock');

  // 只在本实例内存里保存 claim 写权；新实例不会继承，也不会写盘覆盖
  const localNonces = new Map();

  function pathsFor(owner) {
    const key = ownerKey(owner);
    const base = path.join(dataDir, 'handoff');
    const root = safeJoin(base, key);
    return {
      base,
      root,
      actions: safeJoin(root, 'actions'),
      slots: safeJoin(root, 'slots'),
    };
  }

  async function ensureOwner(owner) {
    const paths = pathsFor(owner);
    await ensureDir(fs, paths.base, { recursive: true });
    await ensureDir(fs, paths.root);
    await ensureDir(fs, paths.actions);
    await ensureDir(fs, paths.slots);
    return paths;
  }

  function makeActionId() {
    if (typeof randomId === 'function') {
      const candidate = randomId();
      if (typeof candidate !== 'string' || !ACTION_ID_PATTERN.test(candidate)) {
        throw storeError(HANDOFF_STORE_ERROR_CODES.INVALID_ACTION_ID, '动作标识生成器返回了无效标识');
      }
      return candidate;
    }
    return `ha_${randomBytes(16).toString('hex')}`;
  }

  async function readPublished(paths, actionId) {
    const dir = safeJoin(paths.actions, actionId);
    const publish = await readDecision(fs, safeJoin(dir, 'publish.decision'));
    if (publish !== 'publish') return null;
    let record;
    try {
      record = await readJsonFile(fs, safeJoin(dir, 'record.json'), HANDOFF_STORE_LIMITS.maxRecordBytes);
    } catch (error) {
      // retire 只删 record/payload，publish decision 作为墓碑保留
      if (isMissing(error)) return null;
      throw error;
    }
    return { dir, record: validateRecord(record, actionId) };
  }

  async function readPayload(dir, record) {
    const bytes = await readFileChecked(fs, safeJoin(dir, 'payload.json'), HANDOFF_STORE_LIMITS.maxPayloadBytes);
    if (sha256Hex(bytes) !== record.payloadHash) {
      throw storeError(HANDOFF_STORE_ERROR_CODES.PAYLOAD_CORRUPT, '动作载荷校验失败');
    }
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw storeError(HANDOFF_STORE_ERROR_CODES.PAYLOAD_CORRUPT, '动作载荷不是有效 JSON');
    }
    if (!isPlainObject(payload) || !isPlainObject(payload.context) || !Array.isArray(payload.artifactMetadata)) {
      throw storeError(HANDOFF_STORE_ERROR_CODES.PAYLOAD_CORRUPT, '动作载荷结构无效');
    }
    return payload;
  }

  async function view(found, actionId, { withPayload = true } = {}) {
    const dispatch = await readDecision(fs, safeJoin(found.dir, 'dispatch.decision'));
    let state = found.record.state;
    if (!TERMINAL.has(state) && dispatch) {
      const own = localNonces.get(actionId);
      let ours = false;
      try {
        const token = JSON.parse(dispatch);
        ours = token?.decision === 'claim' && typeof own === 'string' && token.nonce === own;
      } catch {
        ours = false;
      }
      // 无本地写权的新实例只做只读投影，不改盘
      if (!ours) state = 'unknown';
    }
    const result = { action: toAction(found.record, state), context: null, artifactMetadata: [] };
    if (!withPayload) return result;
    try {
      const payload = await readPayload(found.dir, found.record);
      result.context = payload.context;
      result.artifactMetadata = payload.artifactMetadata;
    } catch (error) {
      if (isMissing(error)) {
        if (TERMINAL.has(found.record.state)) return result;
        throw storeError(HANDOFF_STORE_ERROR_CODES.PAYLOAD_CORRUPT, '动作载荷缺失');
      }
      throw error;
    }
    return result;
  }

  async function viewById(paths, actionId, options) {
    const found = await readPublished(paths, actionId);
    if (!found) return null;
    return view(found, actionId, options);
  }

  async function writeRecord(dir, record) {
    await writeFileAtomic(fs, dir, 'record.json', JSON.stringify(record));
  }

  async function discardUnpublished(dir) {
    let publish = null;
    try {
      publish = await readDecision(fs, safeJoin(dir, 'publish.decision'));
    } catch {
      publish = null;
    }
    if (publish === 'publish') return;
    await removeFile(fs, safeJoin(dir, 'payload.json')).catch(() => {});
    await removeFile(fs, safeJoin(dir, 'record.json')).catch(() => {});
    await removeEmptyDir(fs, dir).catch(() => {});
  }

  /** 只回收过期未发布的预约、过期 prepared、以及明确 ready/failed 的本地载荷 */
  async function sweep(paths, nowMs) {
    const usage = await readSlotUsage(fs, paths.slots);
    for (const item of usage.items) {
      const dir = safeJoin(paths.actions, item.actionId);
      if (!(await recordPathPresent(fs, dir))) {
        if (Date.parse(item.createdAt) + HANDOFF_STORE_LIMITS.ttlMs <= nowMs) {
          await releaseSlot(fs, paths.slots, item.actionId);
        }
        continue;
      }
      const publish = await readDecision(fs, safeJoin(dir, 'publish.decision'));
      if (publish !== null) continue;
      if (Date.parse(item.createdAt) + HANDOFF_STORE_LIMITS.ttlMs > nowMs) continue;
      const { won } = await competeDecision(fs, safeJoin(dir, 'publish.decision'), 'retire');
      if (!won) continue;
      await removeFile(fs, safeJoin(dir, 'payload.json'));
      await removeFile(fs, safeJoin(dir, 'record.json'));
      await releaseSlot(fs, paths.slots, item.actionId);
    }

    for (const entry of await listDir(fs, paths.actions)) {
      if (!entry.isDirectory() || !ACTION_ID_PATTERN.test(entry.name)) continue;
      const actionId = entry.name;
      const dir = safeJoin(paths.actions, actionId);
      const publish = await readDecision(fs, safeJoin(dir, 'publish.decision'));
      if (publish !== 'publish') continue;
      let found;
      try {
        found = await readPublished(paths, actionId);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!found) continue;
      if (found.record.state === 'ready' || found.record.state === 'failed') {
        await removeFile(fs, safeJoin(dir, 'payload.json'));
        await releaseSlot(fs, paths.slots, actionId);
        continue;
      }
      if (found.record.state !== 'prepared') continue;
      if (Date.parse(found.record.expiresAt) > nowMs) continue;
      // claim 与 prepared 过期回收竞争同一个 dispatch decision；claim 胜则不动
      const { won } = await competeDecision(fs, safeJoin(dir, 'dispatch.decision'), 'retire');
      if (!won) continue;
      await removeFile(fs, safeJoin(dir, 'payload.json'));
      await removeFile(fs, safeJoin(dir, 'record.json'));
      await releaseSlot(fs, paths.slots, actionId);
    }
  }

  async function prepare({ owner, context, artifactMetadata = [] } = {}) {
    validateOwner(owner);
    validateContext(context);
    const metadata = sanitizeArtifactMetadata(context.artifactIds, artifactMetadata);
    let payloadText;
    try {
      payloadText = JSON.stringify({ context, artifactMetadata: metadata });
    } catch {
      throw invalidContext('交接上下文无法序列化');
    }
    const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
    if (payloadBytes > HANDOFF_STORE_LIMITS.maxPayloadBytes) {
      throw storeError(HANDOFF_STORE_ERROR_CODES.QUOTA_EXCEEDED, '交接载荷超过上限');
    }
    const payloadHash = sha256Hex(payloadText);
    const paths = await ensureOwner(owner);
    const nowMs = clock();
    const nowIso = new Date(nowMs).toISOString();

    await sweep(paths, nowMs);

    let actionId = null;
    let actionDir = null;
    for (let attempt = 0; attempt < 8 && !actionDir; attempt += 1) {
      const candidate = makeActionId();
      const candidateDir = safeJoin(paths.actions, candidate);
      if (await recordPathPresent(fs, candidateDir)) continue;
      try {
        await fs.mkdir(candidateDir, { mode: 0o700 });
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw storeError(HANDOFF_STORE_ERROR_CODES.STORE_IO, '动作目录创建失败');
      }
      actionId = candidate;
      actionDir = candidateDir;
    }
    if (!actionId) throw storeError(HANDOFF_STORE_ERROR_CODES.STORE_IO, '无法分配动作标识');

    const slot = await acquireSlot(fs, paths.slots, { actionId, payloadBytes, createdAt: nowIso });
    if (!slot) {
      await discardUnpublished(actionDir);
      throw storeError(HANDOFF_STORE_ERROR_CODES.QUOTA_EXCEEDED, '动作数量已达上限，请稍后重试');
    }

    const usage = await readSlotUsage(fs, paths.slots);
    if (usage.totalBytes > HANDOFF_STORE_LIMITS.maxReservedBytes) {
      await releaseSlot(fs, paths.slots, actionId);
      await discardUnpublished(actionDir);
      throw storeError(HANDOFF_STORE_ERROR_CODES.QUOTA_EXCEEDED, '准备数据总量已达上限，请稍后重试');
    }

    const record = {
      schemaVersion: 1,
      actionId,
      state: 'prepared',
      source: {
        canvasId: context.source.canvasId,
        revision: context.source.revision,
        targetCardId: context.source.targetCardId,
      },
      agentId: context.agentId,
      payloadHash,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(nowMs + HANDOFF_STORE_LIMITS.ttlMs).toISOString(),
      bytes: context.stats.transcriptBytes,
      sessionId: null,
      files: [],
      entryId: null,
      errorCode: null,
      artifactCount: metadata.length,
      artifactBytes: metadata.reduce((sum, receipt) => sum + receipt.bytes, 0),
    };

    try {
      await writeExclusive(fs, safeJoin(actionDir, 'payload.json'), payloadText);
      await writeRecord(actionDir, record);
      await syncDir(fs, actionDir);
      if (!(await verifySlotOwned(fs, paths.slots, actionId))) {
        throw storeError(HANDOFF_STORE_ERROR_CODES.DECISION_LOST, 'slot 预约已被回收');
      }
      // publish decision 是最后提交：它赢了才承认这个动作
      const { won } = await competeDecision(fs, safeJoin(actionDir, 'publish.decision'), 'publish');
      if (!won) throw storeError(HANDOFF_STORE_ERROR_CODES.DECISION_LOST, '动作已被回收');
      await syncDir(fs, actionDir);
    } catch (error) {
      let published = false;
      try {
        published = (await readDecision(fs, safeJoin(actionDir, 'publish.decision'))) === 'publish';
      } catch {
        published = false;
      }
      // 已发布的动作即使后续同步失败也不能悄悄释放 slot，交给 TTL 清扫
      if (!published) await releaseSlot(fs, paths.slots, actionId).catch(() => {});
      await discardUnpublished(actionDir).catch(() => {});
      throw error;
    }

    return toAction(record);
  }

  async function get({ owner, actionId } = {}) {
    validateOwner(owner);
    validateActionId(actionId);
    return viewById(pathsFor(owner), actionId);
  }

  async function list({ owner } = {}) {
    validateOwner(owner);
    const paths = pathsFor(owner);
    const usage = await readSlotUsage(fs, paths.slots);
    const actions = [];
    for (const item of usage.items) {
      const viewResult = await viewById(paths, item.actionId, { withPayload: false });
      if (viewResult) actions.push(viewResult.action);
    }
    return actions;
  }

  async function claim({ owner, actionId } = {}) {
    validateOwner(owner);
    validateActionId(actionId);
    const paths = pathsFor(owner);
    const found = await readPublished(paths, actionId);
    if (!found) return { claimed: false, record: null };
    if (found.record.state !== 'prepared') {
      return { claimed: false, record: await view(found, actionId, { withPayload: false }) };
    }
    // 先确认载荷仍在，再抢派发权；损坏的载荷不能被 claim 吞掉
    try {
      await readPayload(found.dir, found.record);
    } catch (error) {
      if (isMissing(error)) {
        throw storeError(HANDOFF_STORE_ERROR_CODES.PAYLOAD_CORRUPT, '动作载荷缺失');
      }
      throw error;
    }

    const nonce = newNonce();
    const claimedAt = new Date(clock()).toISOString();
    const tokenPath = safeJoin(found.dir, 'dispatch.decision');
    const { won } = await competeDecision(
      fs,
      tokenPath,
      JSON.stringify({ decision: 'claim', nonce, claimedAt }),
    );
    if (!won) {
      return { claimed: false, record: await view(found, actionId, { withPayload: false }) };
    }

    const next = { ...found.record, state: 'creating', updatedAt: claimedAt };
    try {
      await writeRecord(found.dir, next);
    } catch (error) {
      // claim 标记保留，旧记录不变；本次调用不获得派发权
      throw storeError(HANDOFF_STORE_ERROR_CODES.STORE_IO, 'claim 状态未能可靠落盘，已阻止派发');
    }
    localNonces.set(actionId, nonce);
    const record = { action: toAction(next), context: null, artifactMetadata: [] };
    const payload = await readPayload(found.dir, next);
    record.context = payload.context;
    record.artifactMetadata = payload.artifactMetadata;
    return { claimed: true, record };
  }

  async function checkpoint({ owner, actionId, state, receipt } = {}) {
    validateOwner(owner);
    validateActionId(actionId);
    if (!STATES.has(state)) throw storeError(HANDOFF_STORE_ERROR_CODES.INVALID_STATE, '目标状态无效');
    const nonce = localNonces.get(actionId);
    if (typeof nonce !== 'string') {
      throw storeError(HANDOFF_STORE_ERROR_CODES.CHECKPOINT_DENIED, '本实例没有该动作的派发权');
    }
    const paths = pathsFor(owner);
    const found = await readPublished(paths, actionId);
    if (!found) throw storeError(HANDOFF_STORE_ERROR_CODES.CHECKPOINT_DENIED, '动作不可写');
    let token;
    try {
      token = JSON.parse(await readDecision(fs, safeJoin(found.dir, 'dispatch.decision')));
    } catch {
      token = null;
    }
    if (token?.decision !== 'claim' || token.nonce !== nonce) {
      throw storeError(HANDOFF_STORE_ERROR_CODES.CHECKPOINT_DENIED, '本实例没有该动作的派发权');
    }

    const next = nextRecord(found.record, state, receipt, new Date(clock()).toISOString());
    try {
      await writeRecord(found.dir, next);
    } catch (error) {
      // 落盘失败立即失去继续派发的本地写权
      localNonces.delete(actionId);
      throw storeError(HANDOFF_STORE_ERROR_CODES.STORE_IO, '动作状态未能可靠落盘，已停止后续副作用');
    }
    // 终态也保留本地写权：后续 checkpoint 会先撞状态校验，稳定返回 INVALID_STATE
    return toAction(next);
  }

  return { prepare, get, list, claim, checkpoint };
}

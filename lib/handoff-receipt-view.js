/**
 * 交接卡片的只读投影：把宿主里已保存的 App custom 消息投影成 {receipt}，
 * 供 /api/handoff/sessions/:sessionId/receipt 使用。
 *
 * 数据来源只有正式的 sdk.sessions.get / sdk.sessions.entries（public home 会话、
 * 当前 leafId 的父链）。正文长期来自宿主消息，不依赖会被回收的动作 payload；
 * 旧消息没有 handoffView 时，只允许当前 owner 自己的动作记录做归属核对。
 *
 * 这里不发宿主写操作、不读会话文件、不返回 owner 指纹或路径，也不缓存整段会话历史。
 */
import { createHash } from 'node:crypto';

import {
  HANDOFF_LIMITS,
  handoffError,
  normalizeHandoffFileReceipt,
} from '../ui/assets/fork-handoff-contract.js';

/** 稳定 owner 指纹：只有服务端按真实 principal 计算并比对，持有它不构成授权 */
export function handoffOwnerScopeKey(owner) {
  return createHash('sha256').update(owner).digest('hex');
}

export const HANDOFF_VIEW_VERSION = 1;
export const HANDOFF_VIEW_CUSTOM_TYPE = 'app:timeline-reverser/branch-handoff';

export const HANDOFF_RECEIPT_CODES = Object.freeze({
  NOT_FOUND: 'HANDOFF_RECEIPT_NOT_FOUND',
  AMBIGUOUS: 'HANDOFF_RECEIPT_AMBIGUOUS',
  UNAVAILABLE: 'HANDOFF_RECEIPT_UNAVAILABLE',
});

const APP_ID = 'timeline-reverser';
const OWNER_APP_IDS = new Set([null, undefined, APP_ID]);
const FILE_KINDS = new Set(['artifact', 'archive']);
const MAX_FILES = HANDOFF_LIMITS.maxArtifacts + 1;
const MAX_OWNER_CHARS = 2000;
const MAX_AGENT_CHARS = 200;
const MAX_SESSION_CHARS = 200;
const ACTION_ID = /^ha_[a-f0-9]{32}$/;
export const HANDOFF_RECEIPT_LIMITS = Object.freeze({
  maxCacheEntries: 32,
  maxCacheBytes: 16 * 1024 * 1024,
});

function receiptError(code, message) {
  return handoffError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : null;
}

function safeFile(raw, index) {
  const receipt = normalizeHandoffFileReceipt(raw, index);
  if (!FILE_KINDS.has(raw?.kind)) {
    throw handoffError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, `第 ${index + 1} 个文件回执的种类无效`);
  }
  // 归档文件没有产物身份；带 artifactId 的归档或不安全产物标识都拒绝
  if (raw.artifactId !== undefined
    && (raw.kind !== 'artifact' || typeof raw.artifactId !== 'string' || !/^[a-f0-9]{32}$/.test(raw.artifactId))) {
    throw handoffError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, `第 ${index + 1} 个文件回执的产物标识无效`);
  }
  return { fileId: receipt.fileId, name: receipt.name, mime: receipt.mime, kind: raw.kind };
}

/**
 * 新消息携带的视图元数据：服务端 owner 指纹 + 助手 + 规范文件回执（原产物与 archive）。
 * 不写正文、不写动作标识、不写路径；宿主只会把它持久化在消息 details 上。
 */
export function createHandoffViewDetails({ owner, agentId, files } = {}) {
  if (typeof owner !== 'string' || !owner || owner.length > MAX_OWNER_CHARS) {
    throw new TypeError('createHandoffViewDetails 需要有效的 owner');
  }
  if (!text(agentId, MAX_AGENT_CHARS)) throw new TypeError('createHandoffViewDetails 需要有效的 agentId');
  if (!Array.isArray(files) || files.length > MAX_FILES) {
    throw new TypeError('createHandoffViewDetails 需要规范文件回执');
  }
  return {
    version: HANDOFF_VIEW_VERSION,
    ownerScopeKey: handoffOwnerScopeKey(owner),
    agentId,
    files: files.map((file, index) => safeFile(file, index)),
  };
}

/** 严格校验新元数据：版本、owner 指纹、助手与文件回执任何一项不符都失败关闭 */
function validateView(raw, ownerScopeKey) {
  if (!isPlainObject(raw)) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接视图元数据无效');
  if (raw.version !== HANDOFF_VIEW_VERSION) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接视图元数据版本不匹配');
  if (typeof raw.ownerScopeKey !== 'string' || raw.ownerScopeKey !== ownerScopeKey) {
    throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接视图元数据不属于当前调用方');
  }
  const agentId = text(raw.agentId, MAX_AGENT_CHARS);
  if (!agentId) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接视图元数据缺少目标助手');
  if (!Array.isArray(raw.files) || raw.files.length > MAX_FILES) {
    throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接视图元数据的文件回执无效');
  }
  const files = raw.files.map((file, index) => safeFile(file, index));
  return { agentId, files };
}

function safeSource(raw) {
  if (!isPlainObject(raw)) return null;
  const canvasId = typeof raw.canvasId === 'string' ? raw.canvasId : null;
  const revision = typeof raw.revision === 'string' ? raw.revision : null;
  const targetCardId = typeof raw.targetCardId === 'string' ? raw.targetCardId : null;
  if (!canvasId || !revision || !targetCardId) return null;
  return { canvasId, revision, targetCardId };
}

function validateSessionId(value) {
  const sessionId = text(value, MAX_SESSION_CHARS);
  if (!sessionId || /[/\\\u0000-\u001f\u007f]/.test(sessionId)) {
    throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话标识无效');
  }
  return sessionId;
}

/** leafId 的父链：循环、缺父链、重复 id 一律失败关闭，不猜分支 */
function activeChain(entries, leafId) {
  const byId = new Map();
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id) {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话条目缺少标识');
    }
    if (byId.has(entry.id)) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话条目标识重复');
    byId.set(entry.id, entry);
  }
  if (leafId === null || leafId === undefined) return [];
  if (typeof leafId !== 'string' || !leafId) {
    throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话分支标识无效');
  }
  const chain = [];
  const seen = new Set();
  let current = leafId;
  while (current !== null && current !== undefined) {
    if (typeof current !== 'string' || !current) {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话父链不完整');
    }
    if (seen.has(current)) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话父链成环');
    const entry = byId.get(current);
    if (!entry) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话父链缺失');
    seen.add(current);
    chain.push(entry);
    current = entry.parentId ?? null;
  }
  return chain.reverse();
}

function transcriptBytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

export function createHandoffReceiptReader({
  sdk,
  store,
  maxCacheEntries = HANDOFF_RECEIPT_LIMITS.maxCacheEntries,
  maxCacheBytes = HANDOFF_RECEIPT_LIMITS.maxCacheBytes,
} = {}) {
  if (!sdk || typeof sdk !== 'object') throw new TypeError('createHandoffReceiptReader 需要宿主 sdk');
  const cache = new Map();
  const inflight = new Map();
  let cacheBytes = 0;
  const entryLimit = Number.isSafeInteger(maxCacheEntries) && maxCacheEntries > 0 ? maxCacheEntries : 0;
  const byteLimit = Number.isSafeInteger(maxCacheBytes) && maxCacheBytes > 0 ? maxCacheBytes : 0;

  function remember(key, receipt) {
    if (!entryLimit || !byteLimit) return;
    const bytes = transcriptBytes(JSON.stringify(receipt));
    if (bytes > byteLimit) return;
    cache.set(key, { receipt, bytes });
    cacheBytes += bytes;
    while (cache.size > entryLimit || cacheBytes > byteLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
  }

  async function sessionOf(sessionId) {
    let result;
    try {
      result = await sdk.sessions.get({ sessionId, scope: 'all' });
    } catch {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '无法读取该会话');
    }
    const session = result?.session;
    // 只认精确的 public home 会话：不把 App 私有会话或别的 App 的会话当交接目标
    if (!isPlainObject(session)
      || session.sessionId !== sessionId
      || session.namespace !== 'home'
      || session.visibility !== 'public'
      || !OWNER_APP_IDS.has(session.ownerPluginId)) {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '该会话不是可读的公开主页会话');
    }
  }

  async function entriesOf(sessionId) {
    let result;
    try {
      result = await sdk.sessions.entries({ sessionId, scope: 'all' });
    } catch {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '无法读取该会话的消息');
    }
    if (!isPlainObject(result) || result.sessionId !== sessionId || !Array.isArray(result.entries)) {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '会话消息回执与请求不符');
    }
    return { entries: result.entries, leafId: result.leafId ?? null };
  }

  async function ownedActions(owner, sessionId, entryId) {
    if (!store || typeof store.list !== 'function') return [];
    let actions;
    try {
      actions = await store.list({ owner });
    } catch {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '无法核对本机的交接记录');
    }
    if (!Array.isArray(actions)) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接记录不可读');
    return actions.filter(action => isPlainObject(action)
      && action.sessionId === sessionId
      && action.entryId === entryId);
  }

  async function legacyReceipt(owner, sessionId, entry, content) {
    const matches = await ownedActions(owner, sessionId, entry.id);
    if (matches.length === 0) return null;
    if (matches.length > 1) throw receiptError(HANDOFF_RECEIPT_CODES.AMBIGUOUS, '该消息对应多条交接记录');
    const action = matches[0];
    if (!Array.isArray(action.files) || action.files.length > MAX_FILES) {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接记录的文件回执无效');
    }
    const agentId = text(action.agentId, MAX_AGENT_CHARS);
    if (!agentId) throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接记录缺少目标助手');
    return {
      sessionId,
      actionId: typeof action.actionId === 'string' && ACTION_ID.test(action.actionId) ? action.actionId : null,
      agentId,
      source: safeSource(action.source),
      transcript: content,
      files: action.files.map((file, index) => safeFile(file, index)),
    };
  }

  async function build(owner, sessionId) {
    await sessionOf(sessionId);
    const { entries, leafId } = await entriesOf(sessionId);
    const chain = activeChain(entries, leafId);
    const candidates = chain.filter(entry => entry.type === 'custom_message'
      && entry.display === true
      && entry.customType === HANDOFF_VIEW_CUSTOM_TYPE);

    const ownerScopeKey = handoffOwnerScopeKey(owner);
    const authorized = [];
    let sawLegacy = false;
    for (const entry of candidates) {
      const content = entry.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接消息缺少正文');
      }
      if (transcriptBytes(content) > HANDOFF_LIMITS.maxTranscriptBytes) {
        throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接正文超过可显示上限');
      }
      const details = entry.details;
      const stamped = isPlainObject(details) ? details.handoffView : undefined;
      if (stamped !== undefined) {
        // 新元数据无效/不属于当前 owner：失败关闭，绝不降级成旧回执
        const view = validateView(stamped, ownerScopeKey);
        authorized.push({
          sessionId,
          actionId: typeof details.actionId === 'string' && ACTION_ID.test(details.actionId) ? details.actionId : null,
          agentId: view.agentId,
          source: safeSource(details.source),
          transcript: content,
          files: view.files,
        });
        continue;
      }
      sawLegacy = true;
      const legacy = await legacyReceipt(owner, sessionId, entry, content);
      if (legacy) authorized.push(legacy);
    }

    if (authorized.length === 0) {
      throw receiptError(
        sawLegacy ? HANDOFF_RECEIPT_CODES.UNAVAILABLE : HANDOFF_RECEIPT_CODES.NOT_FOUND,
        sawLegacy ? '找不到可核对的交接记录' : '该会话没有交接记录',
      );
    }
    if (authorized.length > 1) {
      throw receiptError(HANDOFF_RECEIPT_CODES.AMBIGUOUS, '该会话存在多条可显示的交接记录');
    }
    return authorized[0];
  }

  async function read({ owner, sessionId } = {}) {
    if (typeof owner !== 'string' || !owner || owner.length > MAX_OWNER_CHARS) {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '缺少有效的调用方身份');
    }
    const targetSession = validateSessionId(sessionId);
    if (typeof sdk.sessions?.get !== 'function' || typeof sdk.sessions?.entries !== 'function') {
      throw receiptError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '当前宿主没有提供读取会话所需的接口');
    }
    const key = `${handoffOwnerScopeKey(owner)}/${targetSession}`;
    const cached = cache.get(key);
    if (cached) return cached.receipt;
    const running = inflight.get(key);
    if (running) return running;

    const pending = build(owner, targetSession).then(receipt => {
      remember(key, receipt);
      return receipt;
    }).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }

  return { read };
}

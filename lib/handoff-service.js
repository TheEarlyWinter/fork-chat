/**
 * 分支交接服务：prepare（只落 App 私有动作）与 confirm（唯一一次 notifyOnly 交付）。
 *
 * 不接真实模型/会话启动，不重放已派发动作；claim 之后的故障都通过持久 action 表达，
 * 不把 SDK/FS 原文、details、路径或正文回给调用方。
 */
import realFs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  HANDOFF_LIMITS,
  formatHandoffTranscript,
  normalizeHandoffFileReceipt,
  validateHandoffContext,
} from '../ui/assets/fork-handoff-contract.js';
import { getArtifactOwner } from './artifact-owner.js';
import { createHandoffHost } from './handoff-host.js';
import { createHandoffReceiptReader, createHandoffViewDetails, HANDOFF_RECEIPT_CODES } from './handoff-receipt-view.js';
import { createHandoffStore, HANDOFF_STORE_LIMITS } from './handoff-store.js';
import { createHandoffDelivery } from './handoff-delivery.js';
import {
  CONFIRM_MAX_BODY_BYTES,
  PREPARE_MAX_BODY_BYTES,
  fail,
  httpError,
  readJsonBody,
} from './handoff-http.js';
import {
  readArtifactDescriptor,
  requireActiveAgent,
  verifyCapabilities,
  verifyFrozenSet,
} from './handoff-verify.js';

// 每进程最多两个不同 action 处于确认编排；不承诺跨进程全局并发
const activeConfirmations = new Set();
const MAX_ACTIVE_CONFIRMATIONS = 2;

class CheckpointStop extends Error {}

const SAFE_LIMITS = Object.freeze({
  ...HANDOFF_LIMITS,
  maxActions: HANDOFF_STORE_LIMITS.maxActions,
  maxReservedBytes: HANDOFF_STORE_LIMITS.maxReservedBytes,
  ttlMs: HANDOFF_STORE_LIMITS.ttlMs,
});

/** 正文预算：最终转录正文要为宿主文件索引预留空间（与 formatter 同一公式） */
const TRANSCRIPT_BUDGET_BYTES = HANDOFF_LIMITS.maxTranscriptBytes - HANDOFF_LIMITS.fileIndexReserveBytes;

/**
 * 在任何副作用（能力/Agent/产物/Store/claim/create）之前拦住必然交不出去的正文。
 * 按协议层重算的 stats.transcriptBytes 判定，不采信调用方自报值，也不截断内容。
 */
function assertTranscriptBudget(context) {
  const bytes = context?.stats?.transcriptBytes;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw httpError('HANDOFF_PAYLOAD_CORRUPT', '动作载荷缺少可靠的转录体积', 500);
  }
  if (bytes > TRANSCRIPT_BUDGET_BYTES) {
    throw httpError(
      'HANDOFF_TRANSCRIPT_TOO_LARGE',
      `转录正文 ${bytes} 字节超过上限 ${TRANSCRIPT_BUDGET_BYTES}`,
      413,
    );
  }
  return bytes;
}

function actionIdOf(value) {
  return typeof value === 'string' && /^ha_[a-f0-9]{32}$/.test(value) ? value : null;
}

export function createHandoffService({
  sdk,
  dataDir,
  artifacts,
  host = null,
  store = null,
  delivery = null,
  fs = realFs,
  clock = () => Date.now(),
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createHandoffService 需要 dataDir');
  if (!sdk || !artifacts) throw new TypeError('createHandoffService 需要 sdk 与 artifacts');
  const handoffHost = host ?? createHandoffHost({ sdk });
  const handoffStore = store ?? createHandoffStore({ dataDir, fs, clock });
  const deliveryFiles = delivery ?? createHandoffDelivery({ dataDir, fs });
  const receiptReader = createHandoffReceiptReader({ sdk, store: handoffStore });
  const activeKey = (owner, actionId) => `${createHash('sha256').update(owner).digest('hex')}/${actionId}`;

  async function projection(owner, actionId) {
    let view;
    try {
      view = await handoffStore.get({ owner, actionId });
    } catch {
      throw httpError('HANDOFF_ACTION_UNKNOWN', '动作状态暂时无法读取，请按原 actionId 查询', 409);
    }
    if (!view) throw httpError('HANDOFF_ACTION_UNKNOWN', '动作状态暂时无法读取，请按原 actionId 查询', 409);
    return view.action;
  }

  async function checkpoint(owner, actionId, state, receipt) {
    try {
      return await handoffStore.checkpoint({ owner, actionId, state, receipt });
    } catch {
      // 落盘失败意味着本地写权已失；不得继续任何 host 副作用
      throw new CheckpointStop();
    }
  }

  async function settlePartial(owner, actionId, errorCode) {
    try {
      await handoffStore.checkpoint({ owner, actionId, state: 'partial', receipt: { errorCode } });
    } catch {
      // 已是保守状态或失权；返回值以持久投影为准
    }
    return projection(owner, actionId);
  }

  /**
   * 已调用 host 但拿不到可信回执（超时/断连/回执不合规）：只能记 unknown。
   * 不假定明确失败，也不重试。previous 回执由 Store 保留。
   */
  async function settleUnknown(owner, actionId, errorCode) {
    try {
      await handoffStore.checkpoint({ owner, actionId, state: 'unknown', receipt: { errorCode } });
    } catch {
      // 写失败则保持现状，交由查询保守投影
    }
    return projection(owner, actionId);
  }

  /** isIdle 只是读状态：读失败既不能当空闲，也不能当明确失败 */
  async function idleState(sessionId) {
    try {
      return (await handoffHost.isIdle(sessionId)) ? 'idle' : 'busy';
    } catch {
      return 'unknown';
    }
  }

  async function prepareAction({ owner, body }) {
    let context;
    try {
      context = validateHandoffContext(body);
    } catch (error) {
      throw httpError(error?.code || 'HANDOFF_INVALID_CONTEXT', '交接内容未通过校验', 400);
    }
    // 任何能力/Agent/产物/Store 副作用之前先拦下必然交不出去的正文
    assertTranscriptBudget(context);
    await verifyCapabilities(handoffHost);
    await requireActiveAgent(sdk, context.agentId);

    const descriptors = [];
    let totalBytes = 0;
    for (const artifactId of context.artifactIds) {
      const { descriptor } = await readArtifactDescriptor({ artifacts, owner, artifactId });
      totalBytes += descriptor.bytes;
      if (totalBytes > HANDOFF_LIMITS.maxArtifactsTotalBytes) {
        throw httpError('HANDOFF_INVALID_ARTIFACT', '产物总量超过上限', 413);
      }
      descriptors.push(descriptor);
    }
    verifyFrozenSet(descriptors);

    const action = await handoffStore.prepare({ owner, context, artifactMetadata: descriptors });
    return { ok: true, action };
  }

  async function confirmAction({ owner, actionId }) {
    const key = activeKey(owner, actionId);
    // 先做 owner-scoped 查库：不存在/其它 owner 一律 404，非 prepared 只是查询，都不占名额
    const view = await handoffStore.get({ owner, actionId });
    if (!view) throw httpError('HANDOFF_ACTION_NOT_FOUND', '交接动作不存在或不属于当前调用方', 404);
    if (view.action.state !== 'prepared') return { ok: true, action: view.action };
    // 冻结载荷也必须在 claim/create 之前过同一预算：旧超限记录不能先建会话再失败
    assertTranscriptBudget(view.context);

    // 只有要跑编排的 prepared 动作才登记名额；查库后、登记前再确认 key，
    // 同 action 并发只能有一个进入复核（中间没有 await，检查与登记是同一同步段）
    if (activeConfirmations.has(key)) {
      return { ok: true, action: await projection(owner, actionId) };
    }
    if (activeConfirmations.size >= MAX_ACTIVE_CONFIRMATIONS) {
      throw httpError('HANDOFF_BUSY', '当前有其它交接正在确认，请稍后重试', 409);
    }
    activeConfirmations.add(key);
    try {
      const context = view.context;
      const frozen = view.artifactMetadata;
      verifyFrozenSet(frozen);
      await verifyCapabilities(handoffHost);
      await requireActiveAgent(sdk, context.agentId);
      // 确认前再读真实产物，防止准备后源文件被替换
      for (const descriptor of frozen) {
        await readArtifactDescriptor({ artifacts, owner, artifactId: descriptor.artifactId, frozen: descriptor });
      }

      const claim = await handoffStore.claim({ owner, actionId });
      if (!claim.claimed) {
        return { ok: true, action: await projection(owner, actionId) };
      }
      try {
        return await dispatchAction({ owner, actionId, context, frozen });
      } catch (error) {
        // 任何 checkpoint 失权都集中在这里止步：不再 checkpoint、不再写 host
        if (error instanceof CheckpointStop) return { ok: true, action: await projection(owner, actionId) };
        throw error;
      }
    } finally {
      activeConfirmations.delete(key);
    }
  }

  async function dispatchAction({ owner, actionId, context, frozen }) {
    let sessionId = null;
    let created;
    try {
      created = await handoffHost.create({ agentId: context.agentId });
    } catch (error) {
      const knownSession = typeof error?.sessionId === 'string' && error.sessionId.length > 0
        ? error.sessionId
        : null;
      if (!knownSession) {
        // 已尝试 create 但没有可信回执：只能保守 unknown，不能假设没有副作用
        return { ok: true, action: await settleUnknown(owner, actionId, 'HANDOFF_CREATE_UNKNOWN') };
      }
      sessionId = knownSession;
      await checkpoint(owner, actionId, 'importing', { sessionId });
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_CREATE_INVALID') };
    }

    sessionId = created.sessionId;
    await checkpoint(owner, actionId, 'importing', { sessionId });

    const receipts = [];
    for (const [index, descriptor] of frozen.entries()) {
      let read;
      try {
        read = await readArtifactDescriptor({
          artifacts,
          owner,
          artifactId: descriptor.artifactId,
          frozen: descriptor,
        });
      } catch {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_ARTIFACT_CHANGED') };
      }
      let path;
      try {
        path = await deliveryFiles.writeArtifact({
          owner,
          actionId,
          artifactId: descriptor.artifactId,
          bytes: read.bytes,
        });
      } catch {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_DELIVERY_FAILED') };
      }
      const idle = await idleState(sessionId);
      if (idle === 'unknown') {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_STATE_UNKNOWN') };
      }
      if (idle !== 'idle') {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_BUSY') };
      }

      let rawReceipt;
      try {
        rawReceipt = await handoffHost.stage({
          sessionId,
          path,
          name: descriptor.name,
          mime: descriptor.mime,
        });
      } catch {
        // 调用已发出但回执不可信：既不假定失败也不重试
        return { ok: true, action: await settleUnknown(owner, actionId, 'HANDOFF_STAGE_UNKNOWN') };
      }
      let fileReceipt;
      try {
        fileReceipt = {
          ...normalizeHandoffFileReceipt(rawReceipt, index),
          kind: 'artifact',
          artifactId: descriptor.artifactId,
        };
      } catch {
        // 回执里的 ID 不合法（如私有路径）绝不落盘
        return { ok: true, action: await settleUnknown(owner, actionId, 'HANDOFF_STAGE_UNKNOWN') };
      }
      await checkpoint(owner, actionId, 'importing', { files: [fileReceipt] });
      try {
        await deliveryFiles.remove({ owner, actionId, artifactId: descriptor.artifactId });
      } catch {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_DELIVERY_CLEANUP_FAILED') };
      }
      receipts.push(fileReceipt);
    }

    let archiveText;
    try {
      archiveText = formatHandoffTranscript(context, { files: receipts });
    } catch {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_TRANSCRIPT_FAILED') };
    }

    let archivePath;
    try {
      archivePath = await deliveryFiles.writeArchive({ owner, actionId, text: archiveText });
    } catch {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_DELIVERY_FAILED') };
    }
    const archiveIdle = await idleState(sessionId);
    if (archiveIdle === 'unknown') {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_STATE_UNKNOWN') };
    }
    if (archiveIdle !== 'idle') {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_BUSY') };
    }

    let rawArchive;
    try {
      rawArchive = await handoffHost.stage({
        sessionId,
        path: archivePath,
        name: 'handoff.md',
        mime: 'text/markdown',
      });
    } catch {
      return { ok: true, action: await settleUnknown(owner, actionId, 'HANDOFF_ARCHIVE_UNKNOWN') };
    }
    let archiveReceipt;
    try {
      archiveReceipt = { ...normalizeHandoffFileReceipt(rawArchive, receipts.length), kind: 'archive' };
    } catch {
      return { ok: true, action: await settleUnknown(owner, actionId, 'HANDOFF_ARCHIVE_UNKNOWN') };
    }
    await checkpoint(owner, actionId, 'importing', { files: [archiveReceipt] });
    try {
      await deliveryFiles.remove({ owner, actionId, name: 'context.md' });
    } catch {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_DELIVERY_CLEANUP_FAILED') };
    }

    let finalText;
    try {
      finalText = formatHandoffTranscript(context, { files: receipts, archiveFile: archiveReceipt });
    } catch {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_TRANSCRIPT_FAILED') };
    }
    // custom 之前清空精确交付目录；ready 落盘后不再清理
    try {
      await deliveryFiles.removeDir({ owner, actionId });
    } catch {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_DELIVERY_CLEANUP_FAILED') };
    }
    const customIdle = await idleState(sessionId);
    if (customIdle === 'unknown') {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_STATE_UNKNOWN') };
    }
    if (customIdle !== 'idle') {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_BUSY') };
    }

    let handoffView;
    try {
      // 视图元数据只含 owner 指纹、助手与安全文件回执：让卡片能脱离动作记录重读已保存消息
      handoffView = createHandoffViewDetails({
        owner,
        agentId: context.agentId,
        files: [...receipts, archiveReceipt],
      });
    } catch {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_TRANSCRIPT_FAILED') };
    }

    let custom;
    try {
      custom = await handoffHost.writeContext({
        sessionId,
        content: finalText,
        details: {
          actionId,
          source: context.source,
          handoffView,
        },
      });
    } catch {
      return { ok: true, action: await settleUnknown(owner, actionId, 'HANDOFF_CUSTOM_UNKNOWN') };
    }
    // 先验证 entryId，再落 ready；不能靠 Store INVALID_STATE 回投
    const entryId = custom?.entryId;
    if (typeof entryId !== 'string' || entryId.trim().length === 0 || entryId.length > 200) {
      return { ok: true, action: await settleUnknown(owner, actionId, 'HANDOFF_CUSTOM_UNKNOWN') };
    }
    await checkpoint(owner, actionId, 'ready', { entryId });
    return { ok: true, action: await projection(owner, actionId) };
  }

  function receiptHttpError(error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    if (code === HANDOFF_RECEIPT_CODES.NOT_FOUND) {
      return httpError(code, '该会话没有可显示的交接记录', 404);
    }
    if (code === HANDOFF_RECEIPT_CODES.AMBIGUOUS) {
      return httpError(code, '该会话存在多条可显示的交接记录，无法确定显示哪一条', 409);
    }
    return httpError(HANDOFF_RECEIPT_CODES.UNAVAILABLE, '交接记录暂时不可用', 409);
  }

  function register(app) {
    const wrap = handler => async c => {
      try {
        // 所有路由先验证宿主盖戳的稳定 principal
        const owner = getArtifactOwner(c);
        return await handler(c, owner);
      } catch (error) {
        return fail(c, error);
      }
    };

    app.get('/api/handoff/capabilities', wrap(async (c) => {
      const caps = await handoffHost.capabilities();
      return c.json({ ok: true, ...caps, limits: SAFE_LIMITS });
    }));

    // 只读投影：卡片只凭宿主盖戳的 embeddedSessionId 来查，服务端按稳定 principal 判归属
    app.get('/api/handoff/sessions/:sessionId/receipt', wrap(async (c, owner) => {
      try {
        const receipt = await receiptReader.read({ owner, sessionId: c.req.param('sessionId') });
        return c.json({ ok: true, receipt });
      } catch (error) {
        throw receiptHttpError(error);
      }
    }));

    app.post('/api/handoff/prepare', wrap(async (c, owner) => {
      const body = await readJsonBody(c, PREPARE_MAX_BODY_BYTES);
      const result = await prepareAction({ owner, body });
      return c.json(result);
    }));

    app.post('/api/handoff/confirm', wrap(async (c, owner) => {
      const body = await readJsonBody(c, CONFIRM_MAX_BODY_BYTES);
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
      if (keys.length !== 1 || keys[0] !== 'actionId' || !actionIdOf(body.actionId)) {
        throw httpError('HANDOFF_INVALID_REQUEST', '确认请求只能包含 actionId', 400);
      }
      return c.json(await confirmAction({ owner, actionId: body.actionId }));
    }));

    app.get('/api/handoff/actions/:actionId', wrap(async (c, owner) => {
      const actionId = actionIdOf(c.req.param('actionId'));
      if (!actionId) throw httpError('HANDOFF_INVALID_REQUEST', '动作标识无效', 400);
      const view = await handoffStore.get({ owner, actionId });
      if (!view) throw httpError('HANDOFF_ACTION_NOT_FOUND', '交接动作不存在或不属于当前调用方', 404);
      return c.json({ ok: true, action: view.action });
    }));

    app.get('/api/handoff/actions', wrap(async (c, owner) => {
      const actions = await handoffStore.list({ owner });
      return c.json({ ok: true, actions });
    }));
  }

  return { register, prepareAction, confirmAction };
}

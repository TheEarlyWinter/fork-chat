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
  validateHandoffContext,
} from '../ui/assets/fork-handoff-contract.js';
import { getArtifactOwner } from './artifact-owner.js';
import { createHandoffHost } from './handoff-host.js';
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

  async function prepareAction({ owner, body }) {
    let context;
    try {
      context = validateHandoffContext(body);
    } catch (error) {
      throw httpError(error?.code || 'HANDOFF_INVALID_CONTEXT', '交接内容未通过校验', 400);
    }
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
    const view = await handoffStore.get({ owner, actionId });
    if (!view) throw httpError('HANDOFF_ACTION_NOT_FOUND', '交接动作不存在或不属于当前调用方', 404);
    if (view.action.state !== 'prepared') return { ok: true, action: view.action };

    const context = view.context;
    const frozen = view.artifactMetadata;
    verifyFrozenSet(frozen);
    await verifyCapabilities(handoffHost);
    await requireActiveAgent(sdk, context.agentId);
    // 确认前再读真实产物，防止准备后源文件被替换
    for (const descriptor of frozen) {
      await readArtifactDescriptor({ artifacts, owner, artifactId: descriptor.artifactId, frozen: descriptor });
    }

    const key = activeKey(owner, actionId);
    if (activeConfirmations.has(key)) {
      return { ok: true, action: await projection(owner, actionId) };
    }
    if (activeConfirmations.size >= MAX_ACTIVE_CONFIRMATIONS) {
      throw httpError('HANDOFF_BUSY', '当前有其它交接正在确认，请稍后重试', 409);
    }
    activeConfirmations.add(key);
    try {
      const claim = await handoffStore.claim({ owner, actionId });
      if (!claim.claimed) {
        return { ok: true, action: await projection(owner, actionId) };
      }
      return await dispatchAction({ owner, actionId, context, frozen });
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
        try {
          await handoffStore.checkpoint({ owner, actionId, state: 'unknown', receipt: { errorCode: 'HANDOFF_CREATE_UNKNOWN' } });
        } catch {
          // 写失败则保持现状，交由查询保守投影
        }
        return { ok: true, action: await projection(owner, actionId) };
      }
      sessionId = knownSession;
      await checkpoint(owner, actionId, 'importing', { sessionId });
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_CREATE_INVALID') };
    }

    sessionId = created.sessionId;
    await checkpoint(owner, actionId, 'importing', { sessionId });

    const receipts = [];
    for (const descriptor of frozen) {
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
      if (!(await handoffHost.isIdle(sessionId))) {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_BUSY') };
      }
      let receipt;
      try {
        receipt = await handoffHost.stage({
          sessionId,
          path,
          name: descriptor.name,
          mime: descriptor.mime,
        });
      } catch {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_STAGE_FAILED') };
      }
      const fileReceipt = {
        fileId: receipt.fileId,
        name: receipt.name,
        mime: receipt.mime,
        kind: 'artifact',
        artifactId: descriptor.artifactId,
      };
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

    let archiveReceipt;
    try {
      const path = await deliveryFiles.writeArchive({ owner, actionId, text: archiveText });
      if (!(await handoffHost.isIdle(sessionId))) {
        return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_BUSY') };
      }
      const receipt = await handoffHost.stage({
        sessionId,
        path,
        name: 'handoff.md',
        mime: 'text/markdown',
      });
      archiveReceipt = {
        fileId: receipt.fileId,
        name: receipt.name,
        mime: receipt.mime,
        kind: 'archive',
      };
      await checkpoint(owner, actionId, 'importing', { files: [archiveReceipt] });
    } catch (error) {
      if (error instanceof CheckpointStop) return { ok: true, action: await projection(owner, actionId) };
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_ARCHIVE_FAILED') };
    }
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
    if (!(await handoffHost.isIdle(sessionId))) {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_SESSION_BUSY') };
    }
    let custom;
    try {
      custom = await handoffHost.writeContext({
        sessionId,
        content: finalText,
        details: {
          actionId,
          source: context.source,
        },
      });
    } catch {
      return { ok: true, action: await settlePartial(owner, actionId, 'HANDOFF_CUSTOM_FAILED') };
    }
    try {
      await checkpoint(owner, actionId, 'ready', { entryId: custom.entryId });
    } catch (error) {
      if (error instanceof CheckpointStop) return { ok: true, action: await projection(owner, actionId) };
      throw error;
    }
    return { ok: true, action: await projection(owner, actionId) };
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

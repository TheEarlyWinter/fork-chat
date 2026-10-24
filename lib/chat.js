import { randomUUID } from 'node:crypto';
import { getPrincipalInfo, canCancel } from './chat-auth.js';
import { REQUEST_ID_RE, formatMessages, sanitizeErrorCode, sanitizeErrorMessage, logReceipt, logStreamEnd } from './chat-protocol.js';
import { createChatLedger } from './chat-ledger.js';
import { createChatSession } from './chat-session.js';
import { createChatModelPort, resolveChatBinding } from './chat-model.js';
import { createChatResponse } from './chat-stream.js';
import { CREATE_DOCUMENT_TOOL, createArtifactToolExecutor } from './artifact-tool.js';
import { REVISE_DOCUMENT_TOOL, createDocumentReviseExecutor } from './document-revise.js';
import { createDocumentRewriteSource } from './document-rewrite-model.js';
import { createArtifactService, getArtifactOwner } from './document-artifacts.js';
import { contextRequestLimitError } from '../ui/assets/context-watermark.js';

// Preserve the public imports used by callers and existing regression suites.
export { getPrincipalInfo, canCancel } from './chat-auth.js';
export { redactCredentials, sanitizeErrorCode, sanitizeErrorMessage, extractAssistantText, formatMessages } from './chat-protocol.js';

/** HTTP composition/coordination only. State ownership and wire pumping live behind small ports. */
export function createChatService(sdk, options = {}) {
  const { getAgentFullProfile, timeoutMs = 120000, clock = Date, tombstoneTtlMs = 130000, tombstoneCapacity = 1024, dataDir = null } = options;
  const artifacts = options.artifactService || (dataDir ? createArtifactService({ dataDir }) : null);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('createChatService: timeoutMs must be positive');
  const ledger = createChatLedger({ clock, tombstoneTtlMs, tombstoneCapacity });
  const models = createChatModelPort(() => sdk?.models);
  const end = (request, status, code, diagnostics = {}) => logStreamEnd(sdk?.logger, {
    requestId: request.requestId, cardId: request.cardId, provider: request.provider || '', model: request.model || '',
    durationMs: clock.now() - request.startTime, terminalStatus: status, errorCode: code, ...diagnostics,
  });
  const contextRequired = context => context.json({ ok: false, error: '需要经过有效身份授权的请求', code: 'APP_REQUEST_CONTEXT_REQUIRED', requestId: null }, 403);
  const invalidJson = context => context.json({ ok: false, error: '请求体不是有效 JSON', code: 'INVALID_JSON_BODY', requestId: null }, 400);
  const invalidRequestId = (context, id) => context.json({
    ok: false, error: 'requestId 格式无效（必须符合 [A-Za-z0-9_-]{1,100}）', code: 'INVALID_REQUEST_ID',
    requestId: typeof id === 'string' ? id.slice(0, 100) : null,
  }, 400);
  const conflict = (context, requestId) => context.json({ ok: false, error: '该请求已在处理中', code: 'REQUEST_CONFLICT', requestId }, 409);

  async function handleCancel(context) {
    const principal = getPrincipalInfo(context);
    if (!principal) return contextRequired(context);
    let body;
    try { body = await context.req.json(); } catch { return invalidJson(context); }
    const requestId = body?.requestId;
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return invalidRequestId(context, requestId);
    const session = ledger.get(requestId);
    if (!session || session.hasCompleted) {
      ledger.recordTombstone(principal, requestId);
      return context.json({ ok: true, cancelled: false, pending: true });
    }
    if (!canCancel(session.principal, principal)) return context.json({ ok: false, error: '跨 Surface 或未授权的取消请求', code: 'FORBIDDEN', requestId }, 403);
    ledger.recordTombstone(principal, requestId);
    session.triggerCancel('CLIENT_CANCEL');
    return context.json({ ok: true, cancelled: true });
  }

  async function handleStream(context) {
    const principal = getPrincipalInfo(context);
    if (!principal) return contextRequired(context);
    let body;
    try { body = await context.req.json(); } catch { return invalidJson(context); }
    let requestId = body?.requestId;
    if (requestId !== undefined && requestId !== null && requestId !== '') {
      if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return invalidRequestId(context, requestId);
    } else requestId = randomUUID();
    const cardId = typeof body?.cardId === 'string' ? body.cardId : (context.req?.query ? context.req.query('cardId') : undefined);
    const startTime = clock.now();
    if (ledger.hasTombstone(principal, requestId)) {
      end({ requestId, cardId, startTime }, 'cancelled', 'REQUEST_CANCELLED');
      return context.json({ ok: false, error: '请求已被取消', code: 'REQUEST_CANCELLED', requestId }, 499);
    }
    if (ledger.has(requestId)) return conflict(context, requestId);
    let reasoningEffort;
    if (typeof body?.reasoningEffort === 'string') {
      const value = body.reasoningEffort.trim().toLowerCase();
      if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) reasoningEffort = value;
    }
    if (!Array.isArray(body?.messages) || !body.messages.length) return context.json({ ok: false, error: 'messages 必须是非空数组', code: 'INVALID_MESSAGES', requestId }, 400);
    try {
      const limit = contextRequestLimitError(body.messages);
      if (limit) return context.json({ ok: false, error: limit.message, code: limit.code, requestId }, 413);
    } catch {
      return context.json({ ok: false, error: '消息格式无效，无法计量上下文', code: 'INVALID_MESSAGES', requestId }, 400);
    }

    const session = createChatSession({
      requestId, principal, cardId, startTime, timeoutMs,
      requestSignal: context.req?.raw?.signal || context.req?.signal,
      cancelModel: id => models.cancel(id),
      onFinish: current => ledger.release(requestId, current),
    });
    if (!ledger.reserve(session)) return conflict(context, requestId);
    logReceipt(sdk?.logger, { requestId, cardId });
    if (!session.startMonitoring()) {
      session.complete();
      end(session, 'cancelled', 'REQUEST_ABORTED');
      return context.json({ ok: false, error: '客户端已中断连接', code: 'REQUEST_ABORTED', requestId }, 499);
    }

    let binding;
    try {
      binding = await resolveChatBinding(body, { getAgentFullProfile, signal: session.signal });
      session.setBinding(binding);
    } catch (error) {
      session.complete();
      if (session.signal.aborted) {
        const timedOut = session.isTimedOut, code = timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED';
        end(session, timedOut ? 'error' : 'cancelled', code);
        return context.json({ ok: false, error: timedOut ? '请求超时' : '请求已被取消', code, requestId }, timedOut ? 504 : 499);
      }
      // Agent errors always remain 422; a provider-supplied status must not alter this contract.
      const code = sanitizeErrorCode(error?.code || (body?.agentId ? 'AGENT_PROFILE_UNAVAILABLE' : 'INVALID_MODEL_REF'));
      if (!body?.agentId && (error?.provider || error?.model)) session.setBinding({ provider: error.provider || '', model: error.model || '' });
      end(session, 'error', code);
      return context.json({ ok: false, error: sanitizeErrorMessage(error?.message || error || '助手资料不可用', 400), code, requestId }, body?.agentId ? 422 : 400);
    }

    let messages;
    try { messages = formatMessages(body.messages); }
    catch {
      session.complete();
      return context.json({ ok: false, error: '消息格式无效，无法构造请求', code: 'INVALID_MESSAGES', requestId }, 400);
    }
    // 文件生成属于本画布，不推断或改写任何宿主会话。修订工具共用同一 artifacts/owner。
    const tools = artifacts ? [CREATE_DOCUMENT_TOOL, REVISE_DOCUMENT_TOOL] : null;
    // 每请求一个 rewrite 适配器：复用当前 binding，不带文件工具，不碰外层循环
    const rewriteSource = artifacts ? createDocumentRewriteSource({ models, binding }) : null;
    // 身份拒绝（缺稳定 principalId / 未授权）是不可恢复终态：加内部 fatal 标记后重抛，
    // tool-loop 识别后直接终止，不发失败 tool-result、不进入下一轮模型。
    const executeTool = artifacts ? call => {
      let owner;
      try { owner = getArtifactOwner(context); }
      catch (error) {
        if (error?.code === 'ARTIFACT_STABLE_ID_REQUIRED' || error?.code === 'ARTIFACT_FORBIDDEN') {
          error.abortToolLoop = true;
        }
        throw error;
      }
      const common = { artifacts, owner, cardId, requestId, signal: session.signal };
      return call.name === 'revise_document'
        ? createDocumentReviseExecutor({ ...common, rewriteSource })(call)
        : createArtifactToolExecutor(common)(call);
    } : null;
    try {
      return createChatResponse({ requestId, binding, messages, reasoningEffort, session, models, tools, executeTool,
        onTerminal: (status, code, diagnostics) => end(session, status, code, diagnostics),
      });
    } catch (error) {
      session.complete();
      const code = sanitizeErrorCode(error?.code || 'INTERNAL_ERROR');
      end(session, 'error', code);
      if (code === 'STREAM_BACKPRESSURE') return context.json({ ok: false, code, error: '响应元数据超过安全上限', requestId }, 413);
      throw error;
    }
  }
  return { handleStream, handleCancel, inFlightRequests: ledger.inFlightRequests, tombstones: ledger.tombstones };
}

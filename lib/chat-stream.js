import { extractAssistantText, countAssistantReasoningChars, sanitizeErrorCode, sanitizeErrorMessage } from './chat-protocol.js';

export const MAX_BACKLOG_BYTES = 16 * 1024 * 1024;
export const TERMINAL_RESERVE_BYTES = 4096;

/** NDJSON transport and model-event pump. Depends only on a model port and a per-request lifecycle. */
export function createChatResponse({ requestId, binding, messages, reasoningEffort, session, models, onTerminal }) {
  if (typeof models?.streamEvents !== 'function' || typeof onTerminal !== 'function') throw new TypeError('createChatResponse: streamEvents and onTerminal must be functions');
  if (typeof session?.complete !== 'function' || typeof session?.triggerCancel !== 'function' || !session.signal) throw new TypeError('createChatResponse: a request lifecycle is required');
  const { provider, model, systemPrompt } = binding;
  const encoder = new TextEncoder();
  const startFrame = { type: 'start', requestId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  if (encoder.encode(JSON.stringify(startFrame) + '\n').byteLength > MAX_BACKLOG_BYTES - TERMINAL_RESERVE_BYTES) {
    throw { code: 'STREAM_BACKPRESSURE', message: '响应元数据超过安全上限', status: 413 };
  }

  let terminalEmitted = false, controllerClosed = false;
  let eventCount = 0, textChars = 0, reasoningChars = 0, sawDone = false;
  const eventCounts = Object.create(null);
  const diagnostics = () => ({ eventCount, eventCounts, textChars, reasoningChars, sawDone });

  const stream = new ReadableStream({
    start(controller) {
      let iterator = null, iteratorReleased = false, handleAbort = null, pumpAbort = null;
      const cleanupAbortListeners = () => {
        if (handleAbort) { session.signal.removeEventListener('abort', handleAbort); handleAbort = null; }
        if (pumpAbort) {
          const wakePump = pumpAbort;
          session.signal.removeEventListener('abort', pumpAbort); pumpAbort = null;
          // The terminal listener runs before the pump listener during abort dispatch.
          // Wake it explicitly before removal, even when iterator.next() never settles.
          wakePump();
        }
      };
      const releaseIterator = () => {
        // A synchronous abort inside streamEvents may run before the iterator is assigned.
        if (iteratorReleased || !iterator) return;
        iteratorReleased = true;
        if (typeof iterator.return === 'function') {
          try { void Promise.resolve(iterator.return()).catch(() => {}); } catch {}
        }
      };
      const sendFrame = (frame, terminal = false) => {
        if (controllerClosed) return false;
        const payload = encoder.encode(JSON.stringify(frame) + '\n');
        if (!terminal && payload.byteLength > Math.max(0, controller.desiredSize - TERMINAL_RESERVE_BYTES)) {
          throw { code: 'STREAM_BACKPRESSURE', message: '下游读取过慢或响应帧过大，响应积压超过安全上限' };
        }
        controller.enqueue(payload);
        return true;
      };
      const emitTerminal = (frame, status, code, cancelUpstream = false) => {
        if (terminalEmitted) return;
        terminalEmitted = true;
        cleanupAbortListeners();
        session.complete(cancelUpstream ? code : undefined);
        releaseIterator();
        try {
          sendFrame(frame, true);
          if (!controllerClosed) controller.close();
        } catch (error) { try { controller.error(error); } catch {} }
        controllerClosed = true;
        onTerminal(status, code, diagnostics());
      };

      sendFrame(startFrame);
      handleAbort = () => {
        if (terminalEmitted) return;
        if (session.isTimedOut) emitTerminal(
          { type: 'error', requestId, code: 'REQUEST_TIMEOUT', message: '请求处理超时' }, 'error', 'REQUEST_TIMEOUT',
        );
        else emitTerminal(
          { type: 'cancelled', requestId, code: 'REQUEST_CANCELLED', message: '请求已被取消' }, 'cancelled', 'REQUEST_CANCELLED',
        );
      };
      if (session.signal.aborted) { handleAbort(); return; }
      session.signal.addEventListener('abort', handleAbort, { once: true });

      async function runPump() {
        let hasTextDelta = false, sawModelDoneEvent = false, sawReasoningDelta = false;
        try {
          const input = { requestId, provider, model, messages, systemPrompt, ...(reasoningEffort ? { reasoningEffort } : {}) };
          const iterable = models.streamEvents(input, { signal: session.signal });
          iterator = iterable?.[Symbol.asyncIterator]?.() || null;
          if (!iterator) throw { code: 'MODEL_STREAM_INVALID', message: '模型流未返回有效迭代器' };
          if (terminalEmitted || session.signal.aborted) { releaseIterator(); return; }
          const aborted = new Promise(resolve => {
            pumpAbort = () => resolve({ done: true, aborted: true });
            if (session.signal.aborted) pumpAbort();
            else session.signal.addEventListener('abort', pumpAbort, { once: true });
          });
          while (!terminalEmitted && !session.signal.aborted) {
            const step = await Promise.race([iterator.next(), aborted]);
            if (step.aborted || terminalEmitted || session.signal.aborted || step.done) break;
            const event = step.value;
            if (!event || typeof event !== 'object') continue;
            eventCount += 1;
            const type = typeof event.type === 'string' ? event.type : 'unknown';
            eventCounts[type] = (eventCounts[type] || 0) + 1;
            if (event.requestId !== undefined && event.requestId !== requestId) throw {
              code: 'APP_MODEL_STREAM_IDENTITY', message: 'The model stream changed request identity.',
            };
            if (event.type === 'text-delta' && typeof event.delta === 'string') {
              if (event.delta.length > 0) hasTextDelta = true;
              textChars += event.delta.length;
              sendFrame({ type: 'text-delta', requestId, delta: event.delta });
            } else if (event.type === 'reasoning-delta' && typeof event.delta === 'string') {
              sawReasoningDelta = true; reasoningChars += event.delta.length;
            } else if (event.type === 'done') {
              sawModelDoneEvent = true; sawDone = true;
              if (!sawReasoningDelta) reasoningChars += countAssistantReasoningChars(event.assistant);
              if (!hasTextDelta) {
                const text = extractAssistantText(event.assistant);
                if (text) { hasTextDelta = true; textChars += text.length; sendFrame({ type: 'text-delta', requestId, delta: text }); }
              }
              break;
            } else if (event.type === 'error') throw event;
          }
          if (terminalEmitted || session.signal.aborted) return;
          if (!sawModelDoneEvent) emitTerminal(
            { type: 'error', requestId, code: 'STREAM_INCOMPLETE', message: '模型流异常中断（EOF 未完成）' }, 'error', 'STREAM_INCOMPLETE',
          );
          else if (!hasTextDelta) emitTerminal(
            { type: 'error', requestId, code: 'EMPTY_RESPONSE', message: '模型未返回正文内容' }, 'error', 'EMPTY_RESPONSE',
          );
          else emitTerminal({ type: 'done', requestId }, 'done');
        } catch (error) {
          if (terminalEmitted || session.signal.aborted) return;
          const code = sanitizeErrorCode(error?.code || 'MODEL_STREAM_ERROR');
          const message = sanitizeErrorMessage(error?.message || error || '推理过程异常', 400);
          emitTerminal({ type: 'error', requestId, code, message }, 'error', code, code === 'STREAM_BACKPRESSURE');
        } finally {
          cleanupAbortListeners(); releaseIterator(); session.complete();
        }
      }
      void runPump();
    },
    cancel(reason) {
      controllerClosed = true;
      if (!session.hasCompleted && !session.hasCancelled) session.triggerCancel(String(reason || 'STREAM_CANCEL'));
      session.complete();
    },
  }, { highWaterMark: MAX_BACKLOG_BYTES, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Content-Type-Options': 'nosniff',
  } });
}

import { requestHost, safeDetail } from './host-api.js';

export class ChatError extends Error {
  constructor(code, message) { super(safeDetail(message)); this.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,79}$/.test(code) ? code : 'STREAM_ERROR'; }
}

function aborted(signal) {
  return signal.reason instanceof ChatError ? signal.reason : new ChatError('REQUEST_CANCELLED', '已停止接收，并已请求服务端取消。');
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(aborted(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export async function readChatStream(response, requestId, { signal, onEvent = () => {} } = {}) {
  if (!response.headers.get('Content-Type')?.includes('application/x-ndjson') || !response.body) {
    throw new ChatError('STREAM_PROTOCOL_MISMATCH', '流协议不匹配，请关闭旧页面并重新打开应用。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', started = false, terminal = null, text = '';
  const accept = line => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) throw new ChatError('STREAM_FRAME_TOO_LARGE', '响应帧超过限制');
    let event;
    try { event = JSON.parse(line); } catch { throw new ChatError('STREAM_INVALID_JSON', '响应流不是有效 JSON'); }
    if (!event || event.requestId !== requestId) throw new ChatError('STREAM_REQUEST_MISMATCH', '响应请求标识不匹配');
    if (terminal) throw new ChatError('STREAM_INVALID_ORDER', '终态之后出现了额外响应');
    if (event.type === 'start') {
      if (started || typeof event.provider !== 'string' || typeof event.model !== 'string') throw new ChatError('STREAM_INVALID_ORDER', '响应初始化不完整或重复');
      started = true;
    } else {
      if (!started) throw new ChatError('STREAM_INVALID_ORDER', '响应缺少初始化事件');
      if (event.type === 'text-delta') {
        if (typeof event.delta !== 'string') throw new ChatError('STREAM_INVALID_DELTA', '响应增量格式无效');
        text += event.delta;
      } else if (['done', 'error', 'cancelled'].includes(event.type)) {
        terminal = event;
      } else throw new ChatError('STREAM_UNKNOWN_EVENT', '未知响应事件');
    }
    onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await (signal ? withAbort(reader.read(), signal) : reader.read());
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) { accept(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      if (buffer.length > 1024 * 1024) throw new ChatError('STREAM_FRAME_TOO_LARGE', '响应帧超过限制');
      if (done) { if (buffer.trim()) accept(buffer); break; }
      // A terminal frame is authoritative. Do not keep waiting on a broken peer
      // that forgot to close after emitting it; reject extra bytes in this chunk.
      if (terminal) { if (buffer.trim()) throw new ChatError('STREAM_INVALID_ORDER', '终态之后出现了额外数据'); break; }
    }
    if (!terminal) throw new ChatError('STREAM_INCOMPLETE', '响应流中断，未收到完成确认。');
    if (terminal.type !== 'done') {
      const error = new ChatError(terminal.code || (terminal.type === 'cancelled' ? 'REQUEST_CANCELLED' : 'PROVIDER_ERROR'), terminal.message || '请求未完成');
      error.remoteTerminal = true;
      throw error;
    }
    if (!text.trim()) {
      const error = new ChatError('EMPTY_RESPONSE', '模型未返回正文。');
      error.remoteTerminal = true;
      throw error;
    }
    return { requestId, text };
  } finally {
    // reader.cancel is essential for parser errors and local aborts too.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function runChat(hana, payload, {
  signal, onEvent = () => {}, onWaiting = () => {}, onCancelResult = () => {},
  timeoutMs = 130000, waitingNoticeMs = 10000,
} = {}) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', relay, { once: true });
  if (signal?.aborted) relay();
  let requested = false, cancelSent = false, receivedText = false, remoteTerminal = false;
  const cancelRemote = () => {
    if (!requested || cancelSent || remoteTerminal) return;
    cancelSent = true;
    void requestHost(hana, 'api/chat/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: payload.requestId }), keepalive: true,
    }).then(response => response.json()).then(result => onCancelResult(result?.cancelled === true || result?.pending === true,
      result?.cancelled || result?.pending ? '' : '服务端未发现活动请求'))
      .catch(error => onCancelResult(false, safeDetail(error.message)));
  };
  controller.signal.addEventListener('abort', cancelRemote, { once: true });
  const deadline = setTimeout(() => controller.abort(new ChatError('REQUEST_TIMEOUT', '等待超过时限，已停止接收并请求取消。')), timeoutMs);
  const waiting = setTimeout(() => { if (!receivedText && !controller.signal.aborted) onWaiting(); }, waitingNoticeMs);
  try {
    if (controller.signal.aborted) throw aborted(controller.signal);
    requested = true;
    const fetching = requestHost(hana, 'api/chat/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    // A mock/transport may ignore AbortSignal. Dispose any late body anyway.
    void fetching.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await withAbort(fetching, controller.signal);
    return await readChatStream(response, payload.requestId, {
      signal: controller.signal,
      onEvent(event) {
        if (['done', 'error', 'cancelled'].includes(event.type)) remoteTerminal = true;
        if (event.type === 'text-delta' && event.delta) { receivedText = true; clearTimeout(waiting); }
        onEvent(event);
      },
    });
  } catch (error) {
    if (controller.signal.aborted && !remoteTerminal && !error.status) throw aborted(controller.signal);
    // Parser failures are also terminal locally; request a best-effort stop.
    if (!error.remoteTerminal && !error.status) cancelRemote();
    throw error;
  } finally {
    clearTimeout(deadline); clearTimeout(waiting);
    signal?.removeEventListener('abort', relay);
    controller.signal.removeEventListener('abort', cancelRemote);
  }
}

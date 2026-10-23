/** One request owns its abort state, timer, request listener, and at-most-once model cancellation. */
export function createChatSession({ requestId, principal, cardId, startTime, timeoutMs, requestSignal, cancelModel, onFinish }) {
  if (typeof cancelModel !== 'function' || typeof onFinish !== 'function') throw new TypeError('createChatSession: cancelModel and onFinish must be functions');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('createChatSession: timeoutMs must be positive');
  const controller = new AbortController();
  let completed = false, cancelled = false, timedOut = false, started = false;
  let provider = '', model = '', timer = null, onAbort = null, cancelPromise = null;

  function invokeModelCancel() {
    if (!cancelPromise) cancelPromise = (async () => {
      try { await cancelModel(requestId); } catch { /* best effort; never delay terminal ownership */ }
    })();
    return cancelPromise;
  }
  function abortUpstream(reason) {
    cancelled = true;
    controller.abort(new Error(reason || 'REQUEST_CANCELLED'));
    void invokeModelCancel();
  }
  function cleanup() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (requestSignal && onAbort) { requestSignal.removeEventListener('abort', onAbort); onAbort = null; }
  }
  const session = {
    requestId, principal, cardId, startTime,
    get signal() { return controller.signal; },
    get provider() { return provider; },
    get model() { return model; },
    get hasCompleted() { return completed; },
    get hasCancelled() { return cancelled; },
    get isTimedOut() { return timedOut; },
    setBinding(binding) { provider = binding.provider; model = binding.model; },
    triggerCancel(reason) {
      if (completed || cancelled) return;
      abortUpstream(reason);
    },
    startMonitoring() {
      if (started || completed) return !requestSignal?.aborted;
      started = true;
      if (requestSignal?.aborted) { abortUpstream('CLIENT_ABORT'); return false; }
      timer = setTimeout(() => {
        if (completed) return;
        timedOut = true;
        abortUpstream('REQUEST_TIMEOUT');
      }, timeoutMs);
      if (requestSignal) {
        onAbort = () => { if (!completed) session.triggerCancel('CLIENT_ABORT'); };
        requestSignal.addEventListener('abort', onAbort, { once: true });
      }
      return true;
    },
    complete(cancelUpstreamReason) {
      if (completed) return;
      completed = true;
      if (cancelUpstreamReason) abortUpstream(cancelUpstreamReason);
      cleanup();
      onFinish(session);
    },
    cleanup,
  };
  return session;
}

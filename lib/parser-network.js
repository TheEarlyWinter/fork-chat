export const MINERU_HOSTS = Object.freeze(['mineru.net', 'openxlab.org.cn', 'mineru.oss-cn-shanghai.aliyuncs.com']);

export function assertMineruUrl(raw, label = '请求地址') {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error(`${label}不是合法地址`); }
  if (url.protocol !== 'https:') throw new Error(`${label}必须使用 https`);
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || (url.port && url.port !== '443') ||
      !MINERU_HOSTS.some(allowed => host === allowed || (allowed !== 'mineru.oss-cn-shanghai.aliyuncs.com' && host.endsWith(`.${allowed}`)))) {
    throw new Error(`${label}不在官方白名单`);
  }
  return url;
}

export function parserError(error, secrets = []) {
  let value = String(error?.message || error || '解析失败');
  for (const secret of secrets) if (secret) value = value.split(String(secret)).join('[redacted]');
  return value.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 400);
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('已取消', 'AbortError');
}

export function createCheckedFetch({ fetchImpl = globalThis.fetch } = {}) {
  return async function checkedFetch(input, init = {}) {
    const { timeoutMs, maxResponseBytes = 4 * 1024 * 1024, signal: callerSignal, ...rest } = init;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 250 * 1024 * 1024) throw new Error('响应上限无效');
    const signals = [callerSignal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    let url = assertMineruUrl(input);
    let headers = new Headers(rest.headers);
    for (let hop = 0; hop < 5; hop++) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url.href, { ...rest, headers, signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        void response.body?.cancel().catch(() => {});
        if (!['GET', 'HEAD'].includes(String(rest.method || 'GET').toUpperCase())) throw new Error('上传请求跳转被拒绝，不能重放内容');
        const next = assertMineruUrl(new URL(response.headers.get('location'), url).href, '跳转地址');
        if (next.origin !== url.origin) {
          headers = new Headers(headers);
          for (const key of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(key);
        }
        url = next;
        continue;
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error('响应超过字节上限');
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      let count = 0, finished = false;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => { void reader.cancel(abortReason(signal)).catch(() => {}); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const body = new ReadableStream({
        async pull(controller) {
          try {
            signal?.throwIfAborted();
            const item = await reader.read();
            signal?.throwIfAborted();
            if (item.done) { finished = true; cleanup(); controller.close(); return; }
            count += item.value.byteLength;
            if (count > maxResponseBytes) throw new Error('响应超过实际字节上限');
            controller.enqueue(item.value);
          } catch (error) {
            if (!finished) { finished = true; cleanup(); void reader.cancel(error).catch(() => {}); controller.error(error); }
          }
        },
        cancel(reason) { finished = true; cleanup(); void reader.cancel(reason).catch(() => {}); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    throw new Error('跳转次数过多');
  };
}

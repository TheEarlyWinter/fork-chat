// Only the host SDK may attach App Surface / document credentials. Never fall
// back to a bare fetch, copy tokens, or automatically replay a chat POST.
export function safeDetail(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/((?:appSurfaceSession|appIframeTicket|X-Hana-App-Surface-Session|X-Hana-Document-Binding|authorization|access_token|api[_-]?key|token)["']?\s*[:=]\s*["']?)[^\s&"'<>;,}]+/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 400);
}

export async function requestHost(hana, path, init) {
  if (typeof hana.api?.fetch !== 'function') {
    throw new Error('当前 Hana SDK 不支持已鉴权请求，请更新应用与宿主后重新打开页面。');
  }
  const response = await hana.api.fetch(path, init);
  if (response.ok) return response;

  let detail = '';
  // Never include an HTML error document (or its scripts) in conversation data.
  if (!response.headers.get('Content-Type')?.includes('text/html')) {
    const body = await response.text().catch(() => '');
    try {
      const data = JSON.parse(body);
      const code = typeof data.code === 'string' ? data.code : data.error?.code;
      const message = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
      detail = [code, message].filter(value => typeof value === 'string').join(': ');
    } catch {
      if (!/^\s*</.test(body)) detail = body;
    }
  }
  const hint = response.status === 401 || response.status === 403
    ? '；请求被拒绝，请重新打开应用；若仍失败，保留此错误码排查页面鉴权。'
    : '';
  const error = new Error(`HTTP ${response.status}${detail ? ` — ${safeDetail(detail)}` : ''}${hint}`);
  error.status = response.status;
  throw error;
}

import { documentError } from './document-spec.js';
/** Host-authenticated owner projection; payloads never select an owner or filesystem path. */
export function getArtifactOwner(context) {
  const request = context?.get?.('appRequestContext');
  const principal = request?.principal;
  const id = principal?.principalId || principal?.id || principal?.credentialId;
  if (request?.appId !== 'timeline-reverser' || typeof id !== 'string' || !id.trim()) throw documentError('ARTIFACT_FORBIDDEN', '缺少可信调用方身份', 403);
  return JSON.stringify([request.appId, principal.kind || 'authenticated', id]);
}
async function requestBody(context) {
  const raw = context.req?.raw;
  if (!raw?.body?.getReader) {
    const value = await context.req.json();
    if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw documentError('INVALID_ARTIFACT_REQUEST', '文件请求过大', 413);
    return value;
  }
  const reader = raw.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const step = await reader.read(); if (step.done) break;
      bytes += step.value.byteLength;
      if (bytes > 4096) throw documentError('INVALID_ARTIFACT_REQUEST', '文件请求过大', 413);
      chunks.push(Buffer.from(step.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function registerArtifactRoutes(app, service) {
  const handler = method => async context => {
    try {
      const owner = getArtifactOwner(context);
      const headerLength = Number(context.req?.header?.('content-length'));
      if (headerLength > 4096) throw documentError('INVALID_ARTIFACT_REQUEST', '文件请求过大', 413);
      const body = await requestBody(context);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'artifactId')
        || Buffer.byteLength(JSON.stringify(body)) > 4096) throw documentError('INVALID_ARTIFACT_REQUEST', '只接受文件标识');
      return context.json({ ok: true, ...await service[method]({ owner, artifactId: body.artifactId }) });
    } catch (error) {
      if (error instanceof SyntaxError) error = documentError('INVALID_ARTIFACT_REQUEST', '文件请求不是有效 JSON');
      return context.json({ ok: false, code: error.code || 'ARTIFACT_FAILED', error: error.status ? error.message : '文件操作失败' }, error.status || 500);
    }
  };
  app.post('/api/artifacts/export', handler('exportFile'));
  app.post('/api/artifacts/preview', handler('preview'));
}

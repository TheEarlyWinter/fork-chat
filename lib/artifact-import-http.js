import { documentError } from './document-spec.js';

/**
 * 导入通道的独立 HTTP 适配器（Sol 设计 3.2）。
 *
 * 与 export/preview 的 4096 字节上限分开：导入承载 base64 文件体，
 * 上限为 base64 最大长度加 4096 字节元数据预算。逐请求鉴权、双重有界；
 * 不接受 owner/oldOwner/path/confirmed/artifactId 等客户端字段。
 */

const MAX_BASE64 = Math.ceil(16 * 1024 * 1024 / 3) * 4;
const IMPORT_BODY_BUDGET = MAX_BASE64 + 4096;
const ALLOWED_KEYS = ['filename', 'format', 'contentBase64', 'cardId', 'requestId'];

async function readImportBody(context) {
  const raw = context.req?.raw;
  if (!raw?.body?.getReader) {
    const value = await context.req.json();
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > IMPORT_BODY_BUDGET) throw documentError('INVALID_ARTIFACT_REQUEST', '导入请求过大', 413);
    return value;
  }
  const reader = raw.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      bytes += step.value.byteLength;
      if (bytes > IMPORT_BODY_BUDGET) throw documentError('INVALID_ARTIFACT_REQUEST', '导入请求过大', 413);
      chunks.push(Buffer.from(step.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function registerArtifactImportRoutes(app, service) {
  app.post('/api/artifacts/import', async context => {
    try {
      const owner = context.get?.('appRequestContext') && require_owner(context);
      const headerLength = Number(context.req?.header?.('content-length'));
      if (headerLength > IMPORT_BODY_BUDGET) throw documentError('INVALID_ARTIFACT_REQUEST', '导入请求过大', 413);
      const body = await readImportBody(context);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !ALLOWED_KEYS.includes(key))) {
        throw documentError('INVALID_ARTIFACT_REQUEST', '导入请求只接受文件名、格式与文件内容');
      }
      const { filename, format, contentBase64, cardId, requestId } = body;
      if (typeof filename !== 'string' || typeof format !== 'string' || typeof contentBase64 !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64) || contentBase64.length > MAX_BASE64) {
        throw documentError('INVALID_ARTIFACT_REQUEST', '导入文件名、格式或内容编码无效');
      }
      const bytes = Buffer.from(contentBase64, 'base64');
      const artifact = await service.importFile({
        owner, filename, format, bytes,
        cardId: typeof cardId === 'string' ? cardId : '',
        requestId: typeof requestId === 'string' ? requestId : '',
      });
      return context.json({ ok: true, artifact });
    } catch (error) {
      if (error instanceof SyntaxError) error = documentError('INVALID_ARTIFACT_REQUEST', '导入请求不是有效 JSON');
      return context.json({ ok: false, code: error.code || 'ARTIFACT_FAILED', error: error.status ? error.message : '导入失败' }, error.status || 500);
    }
  });
}

// owner 解析经统一模块；此处仅做导入路由的内联引用，避免循环依赖
import { getArtifactOwner } from './artifact-owner.js';
function require_owner(context) { return getArtifactOwner(context); }

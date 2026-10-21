import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUploadStore, UPLOAD_LIMITS } from './upload-store.js';
import { createParserRuntimeClient } from './parser-runtime-client.js';
import { parseDocument, MAX_PDF_BYTES } from './document-parser.js';
import { parseDocumentSmart } from './parse-router.js';
import { resolveMineruOptions } from './mineru-parse.js';
import { privateDirectory, readCheckedFile } from './file-safety.js';
import { parserError } from './parser-network.js';

export function getDocumentOwner(c) {
  const ctx = c.get?.('appRequestContext');
  const principal = ctx?.principal;
  if (ctx?.appId !== 'timeline-reverser' || !principal || typeof principal !== 'object') throw Object.assign(new Error('缺少可信调用方身份'), { status: 401 });
  const id = principal.principalId || principal.id || principal.credentialId;
  if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('缺少可信调用方身份'), { status: 401 });
  // Only host-authenticated context, never caller-supplied headers or a shared fallback.
  return JSON.stringify([ctx.appId, principal.kind || 'authenticated', id]);
}

async function requestJson(c) {
  const raw = c.req.raw;
  if (!raw?.body?.getReader) {
    const value = await c.req.json();
    if (Buffer.byteLength(JSON.stringify(value)) > 24 * 1024 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 });
    return value;
  }
  const reader = raw.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 24 * 1024 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 });
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function decodeBase64(value, max) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('文件编码无效或超过上限');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) throw new Error('文件编码无效或超过上限');
  return bytes;
}

export function createDocumentService({ sdk, dataDir, getConfig, runtimeClient, parseLocal = parseDocument }) {
  const uploads = createUploadStore({ dataDir, logger: sdk.logger });
  const runtime = runtimeClient || createParserRuntimeClient({ sdk, dataDir });
  const jobs = new Map();
  let reservations = 0;
  const errorResponse = (c, error) => c.json({ ok: false, error: parserError(error), code: error.code || 'DOCUMENT_FAILED' }, error.status || 400);
  const wrap = handler => async c => { try { return await handler(c); } catch (error) { return errorResponse(c, error); } };

  async function resolve(body, owner) {
    if (body.path !== undefined) throw new Error('不接受任意文件路径，请使用上传引用');
    let uploadId = body.uploadId;
    if (!uploadId) {
      const bytes = decodeBase64(body.contentBase64, 16 * 1024 * 1024);
      uploadId = uploads.begin({ owner, filename: body.filename, size: bytes.length, total: Math.ceil(bytes.length / UPLOAD_LIMITS.maxChunkBytes) }).uploadId;
      try {
        for (let i = 0; i * UPLOAD_LIMITS.maxChunkBytes < bytes.length; i++) await uploads.writeChunk({ uploadId, owner, index: i, buffer: bytes.subarray(i * UPLOAD_LIMITS.maxChunkBytes, (i + 1) * UPLOAD_LIMITS.maxChunkBytes) });
      } catch (error) { await uploads.release({ uploadId }).catch(() => {}); throw error; }
    }
    const file = await uploads.resolve({ uploadId, owner, claim: true });
    if (!file) throw new Error('上传不存在、未完成、已占用或不属于调用方');
    return { ...file, uploadId };
  }
  async function parse(file, body, job) {
    const signal = job.controller.signal;
    return parseDocumentSmart({
      filename: file.filename, mode: body.mode || 'auto', getConfig,
      localFn: async () => {
        signal.throwIfAborted();
        if (file.size > MAX_PDF_BYTES) throw Object.assign(new Error('文件超过本地解析大小上限'), { code: 'file_too_big' });
        const root = await privateDirectory(dataDir, 'uploads');
        const bytes = await readCheckedFile(root, file.filePath, MAX_PDF_BYTES);
        const result = await parseLocal({ filename: file.filename, contentBase64: bytes.toString('base64') });
        signal.throwIfAborted();
        return result;
      },
      cloudFn: () => runtime.parse(file, resolveMineruOptions(getConfig), { signal, onProgress(stage) { if (job.status === 'running') job.stage = stage; } }),
    });
  }
  async function start(body, owner) {
    if (reservations >= 4) throw Object.assign(new Error('同时进行的解析任务过多'), { status: 429 });
    reservations++; // reserve before resolving a file or any asynchronous work
    let file;
    try {
      file = await resolve(body, owner);
      const id = randomUUID().replaceAll('-', '');
      const job = { owner, status: 'running', stage: '准备解析', startedAt: Date.now(), controller: new AbortController() };
      jobs.set(id, job);
      const timer = setTimeout(() => job.controller.abort(new DOMException('解析任务超时', 'AbortError')), 16 * 60 * 1000); timer.unref();
      job.finished = (async () => {
        try {
          const result = await parse(file, body, job);
          job.controller.signal.throwIfAborted();
          job.status = 'done'; job.stage = '完成'; job.result = result;
        } catch (error) {
          job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
          job.stage = '失败'; job.error = parserError(error); job.code = job.controller.signal.aborted ? 'REQUEST_CANCELLED' : 'DOCUMENT_FAILED';
        } finally {
          clearTimeout(timer);
          await uploads.release({ uploadId: file.uploadId }).catch(() => {});
          reservations--;
          job.settled = true;
          const expiry = setTimeout(() => jobs.delete(id), 5 * 60 * 1000); expiry.unref();
        }
      })();
      return { id, job };
    } catch (error) {
      reservations--;
      if (file) await uploads.release({ uploadId: file.uploadId }).catch(() => {});
      throw error;
    }
  }
  function register(app) {
    app.post('/api/document/upload', wrap(async c => {
      const owner = getDocumentOwner(c);
      const body = await requestJson(c);
      const buffer = decodeBase64(body.chunk, UPLOAD_LIMITS.maxChunkBytes);
      const uploadId = body.uploadId || uploads.begin({ owner, filename: body.filename, size: body.size ?? body.totalSize, total: body.total }).uploadId;
      const result = await uploads.writeChunk({ uploadId, owner, index: body.index, buffer });
      return c.json({ ok: true, ...result });
    }));
    app.post('/api/document/parse', wrap(async c => {
      const owner = getDocumentOwner(c);
      const { id } = await start(await requestJson(c), owner);
      return c.json({ ok: true, jobId: id, timeoutMs: 17 * 60 * 1000 });
    }));
    app.post('/api/document/extract', wrap(async c => {
      const owner = getDocumentOwner(c);
      const { job } = await start(await requestJson(c), owner);
      await job.finished;
      return job.status === 'done' ? c.json(job.result) : c.json({ ok: false, error: job.error, code: job.code }, 400);
    }));
    app.get('/api/document/parse/:jobId', wrap(c => {
      const owner = getDocumentOwner(c);
      const job = jobs.get(String(c.req.param('jobId')));
      if (!job || job.owner !== owner) return c.json({ ok: false, error: '任务不存在或不属于调用方' }, 404);
      return c.json({ ok: true, status: job.status, stage: job.stage, result: job.status === 'done' ? job.result : undefined, error: job.error, code: job.code, elapsedMs: Date.now() - job.startedAt });
    }));
    app.delete('/api/document/parse/:jobId', wrap(async c => {
      const owner = getDocumentOwner(c);
      const job = jobs.get(String(c.req.param('jobId')));
      if (!job || job.owner !== owner) return c.json({ ok: false, error: '任务不存在或不属于调用方' }, 404);
      if (job.status === 'running') job.controller.abort(new DOMException('已取消', 'AbortError'));
      let timer;
      await Promise.race([job.finished, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); clearTimeout(timer);
      return c.json({ ok: true, status: job.status, settled: job.settled === true });
    }));
  }
  return { register, runtime, uploads };
}

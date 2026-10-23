#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePdfWithMineru, storeMineruCache } from '../lib/mineru-parse.js';
import { privateDirectory, openCheckedFile, readCheckedFile, exclusiveFile, checkedPath } from '../lib/file-safety.js';
import { assertMineruUrl, createCheckedFetch, parserError } from '../lib/parser-network.js';

const MAX_FILE = 200 * 1024 * 1024;
const FILE_ID = /^[a-f0-9]{32}\.[a-z0-9]{1,8}$/;
const JOB_ID = /^[a-f0-9]{32}$/;
const RESULT_FILE = /^[a-f0-9]{32}\.json$/;
const RESULT_TTL_MS = 10 * 60 * 1000;
export const assertSafeUrl = assertMineruUrl;

export async function assertReadableInsideDataDir(target, dataDir = process.env.PARSER_DATA_DIR || process.cwd()) {
  const root = await privateDirectory(dataDir, 'uploads');
  const file = await openCheckedFile(root, path.resolve(target), MAX_FILE);
  try { return { realPath: file.filePath, size: file.size }; } finally { await file.handle.close(); }
}

export async function createParserService({ dataDir, authToken, generation = 'test', fetchImpl, parseFn = parsePdfWithMineru, jobTimeoutMs, cancelWaitMs = 1000 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(authToken || '')) throw new Error('缺少运行时控制凭据');
  const uploadsRoot = await privateDirectory(dataDir, 'uploads');
  const resultsRoot = await privateDirectory(dataDir, 'helper-results');
  const checkedFetch = createCheckedFetch({ fetchImpl });
  const jobs = new Map();
  let active = 0;
  let closing = false;
  let closePromise;
  // 只操作本目录的普通任务结果，绝不递归清空共享目录或跟随链接。
  async function removeResultFile(name) {
    if (!RESULT_FILE.test(name || '')) return false;
    const target = path.join(resultsRoot, name);
    try {
      await checkedPath(path.dirname(resultsRoot), resultsRoot);
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      await fs.unlink(target);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  // 崩溃时 close 不会运行。结果过了原有十分钟有效期才可回收，
  // 新鲜结果可能属于另一个仍在运行的 helper，不能按“重启”全部删掉。
  for (const entry of await fs.readdir(resultsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !RESULT_FILE.test(entry.name)) continue;
    try {
      const stat = await fs.lstat(path.join(resultsRoot, entry.name));
      if (stat.isFile() && Date.now() - stat.mtimeMs > RESULT_TTL_MS) await removeResultFile(entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const authorised = req => {
    const actual = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${authToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const send = (res, status, data) => {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  };
  const publicJob = job => ({ status: job.status, stage: job.stage, error: job.error, code: job.code, settled: job.settled, resultFile: job.status === 'done' ? job.resultFile : undefined, elapsedMs: Date.now() - job.startedAt });
  const cancel = job => {
    if (job.status !== 'running') return;
    job.status = 'cancelled'; job.stage = '已取消'; job.error = '已取消'; job.code = 'REQUEST_CANCELLED';
    job.controller.abort(new DOMException('已取消', 'AbortError'));
    for (const stream of job.streams) stream.destroy(new DOMException('已取消', 'AbortError'));
  };
  async function run(job) {
    let resultFile;
    try {
      const signal = job.controller.signal;
      const hash = createHash('sha256');
      for await (const chunk of job.file.handle.createReadStream({ start: 0, autoClose: false })) {
        signal.throwIfAborted(); hash.update(chunk);
      }
      if (hash.digest('hex') !== job.sha256) throw new Error('上传文件完整性校验失败');
      signal.throwIfAborted();
      const result = await parseFn({
        buffer: null, fileName: job.filename, fileSize: job.file.size, options: job.options, signal,
        fetchFn: (input, init = {}) => checkedFetch(input, { ...init, signal }),
        createBody: async () => {
          signal.throwIfAborted();
          // Never hand the job's checked descriptor to an outbound stream. A
          // fetch implementation is allowed to destroy its request body, and
          // Node closes the underlying FileHandle when that happens even when
          // the stream was created with autoClose:false. Reopening through the
          // already checked upload path gives every attempt its own descriptor,
          // so an OCR retry cannot inherit fd=-1 from the first upload.
          const bodyFile = await openCheckedFile(uploadsRoot, job.file.filePath, MAX_FILE);
          try {
            const originalStat = await job.file.handle.stat();
            const bodyStat = await bodyFile.handle.stat();
            if (originalStat.dev !== bodyStat.dev || originalStat.ino !== bodyStat.ino) {
              throw new Error('上传文件在解析过程中被替换');
            }
            const stream = bodyFile.handle.createReadStream({ start: 0, autoClose: true });
            job.streams.add(stream);
            stream.once('close', () => job.streams.delete(stream));
            return stream;
          } catch (error) {
            await bodyFile.handle.close().catch(() => {});
            throw error;
          }
        },
        onProgress(stage) { if (job.status === 'running') job.stage = String(stage).slice(0, 80); },
      });
      signal.throwIfAborted();
      // parseFn's output is bounded; never put ZIP bytes in an RPC or status response.
      if (result._zip) await storeMineruCache({ dataDir, cacheId: result.cacheId, zipBytes: result._zip });
      signal.throwIfAborted();
      const { _zip, ...payload } = result;
      resultFile = `${job.id}.json`;
      const out = await exclusiveFile(resultsRoot, resultFile);
      try { await out.writeFile(JSON.stringify({ ...payload, engineLabel: 'MinerU 云端' })); } finally { await out.close(); }
      signal.throwIfAborted();
      job.resultFile = resultFile; job.status = 'done'; job.stage = '完成';
    } catch (error) {
      if (job.status === 'running') {
        job.status = 'error'; job.stage = '失败'; job.code = error?.name === 'AbortError' ? 'REQUEST_CANCELLED' : 'PARSE_FAILED';
        job.error = parserError(error, [job.options?.token]);
      }
      if (resultFile) await removeResultFile(resultFile).catch(() => {});
    } finally {
      clearTimeout(job.timer);
      for (const stream of job.streams) stream.destroy();
      await job.file.handle.close().catch(() => {});
      job.options = null; job.file = null; job.streams.clear();
      job.settled = true; job.finishedAt = Date.now(); active--;
      job.expiry = setTimeout(() => {
        jobs.delete(job.id);
        if (job.resultFile) void removeResultFile(job.resultFile).catch(() => {});
      }, RESULT_TTL_MS);
      job.expiry.unref();
    }
  }
  async function body(req) {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new Error('控制请求过大');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  const server = http.createServer(async (req, res) => {
    if (closing) { req.resume(); return send(res, 503, { ok: false, error: '解析助手正在关闭' }); }
    if (!authorised(req)) { req.resume(); return send(res, 401, { ok: false, error: '控制请求未授权' }); }
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, protocol: 2, generation, active });
      if (req.method === 'POST' && url.pathname === '/jobs') {
        const input = await body(req);
        if (!FILE_ID.test(input.fileId || '') || !/^[a-f0-9]{64}$/.test(input.sha256 || '') || input.jobId !== undefined || input.filePath !== undefined) throw new Error('文件引用无效');
        if (typeof input.options?.token !== 'string' || !input.options.token || input.options.token.length > 8192) throw new Error('缺少有效 MinerU 配置');
        const api = assertMineruUrl(input.options.apiBase || 'https://mineru.net/api/v4');
        if (!(api.hostname === 'mineru.net' || api.hostname.endsWith('.mineru.net'))) throw new Error('API 域名无效');
        if (typeof input.filename !== 'string' || !input.filename.toLowerCase().endsWith('.pdf')) throw new Error('云端只支持 PDF');
        // 先算文件名再开文件：path.basename 对非字符串会抛错，
        // 而那一步原本发生在文件已打开、名额已占用之后，异常会把名额永久漏掉。
        const safeFilename = path.basename(input.filename).slice(0, 200);
        const file = await openCheckedFile(uploadsRoot, path.join(uploadsRoot, input.fileId), MAX_FILE);
        if (closing) { await file.handle.close(); return send(res, 503, { ok: false, error: '解析助手正在关闭' }); }
        if (active >= 2) { await file.handle.close(); return send(res, 429, { ok: false, error: '助手正在忙' }); }
        // Reserve after every await, before starting asynchronous work.
        active++;
        const id = randomUUID().replaceAll('-', '');
        const job = { id, file, sha256: input.sha256, filename: safeFilename, options: { ...input.options, apiBase: api.href.replace(/\/$/, '') }, controller: new AbortController(), streams: new Set(), status: 'running', stage: '准备解析', startedAt: Date.now(), settled: false };
        jobs.set(id, job);
        if (jobs.size > 64) for (const [oldId, old] of jobs) if (old.settled && oldId !== id) {
          jobs.delete(oldId); clearTimeout(old.expiry);
          if (old.resultFile) void removeResultFile(old.resultFile).catch(() => {});
          break;
        }
        const duration = jobTimeoutMs ?? Math.min(15 * 60 * 1000, Math.max(30000, ((Number(input.options.timeoutSeconds) || 300) + 120) * 1000));
        job.timer = setTimeout(() => cancel(job), duration); job.timer.unref();
        job.finished = run(job);
        return send(res, 202, { ok: true, jobId: id, timeoutMs: duration });
      }
      const id = url.pathname.startsWith('/jobs/') ? url.pathname.slice(6) : '';
      if (!JOB_ID.test(id) || !jobs.has(id)) return send(res, 404, { ok: false, error: '任务不存在或已过期' });
      const job = jobs.get(id);
      if (req.method === 'GET') return send(res, 200, { ok: true, ...publicJob(job) });
      if (req.method === 'DELETE') {
        cancel(job);
        let timer;
        await Promise.race([job.finished, new Promise(resolve => { timer = setTimeout(resolve, cancelWaitMs); })]);
        clearTimeout(timer);
        return send(res, 200, { ok: true, ...publicJob(job) });
      }
      return send(res, 405, { ok: false });
    } catch (error) { return send(res, 400, { ok: false, error: parserError(error) }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return {
    server, jobs,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const job of jobs.values()) { cancel(job); clearTimeout(job.expiry); }
        // 先停止接收，再断连接；await 之后的提交也受 closing 闸门保护。
        const stopped = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await stopped;
        await Promise.allSettled([...jobs.values()].map(job => job.finished));
        const removals = [];
        for (const job of jobs.values()) {
          clearTimeout(job.expiry);
          if (job.resultFile) removals.push(removeResultFile(job.resultFile));
        }
        const settled = await Promise.allSettled(removals);
        const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, '解析结果清理失败');
      })();
      return closePromise;
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.argv[2]);
  const name = process.argv[3];
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{32}\.json$/.test(name || '')) throw new Error('运行时启动参数无效');
  const dataDir = process.cwd();
  const control = await privateDirectory(dataDir, '.parser-control');
  const config = JSON.parse((await readCheckedFile(control, path.join(control, name), 2048)).toString('utf8'));
  await fs.rm(path.join(control, name));
  const service = await createParserService({ dataDir, authToken: config.token, generation: name.slice(0, 32) });
  service.server.listen(port, '127.0.0.1', () => process.stdout.write('PARSER_READY\n'));
  const shutdown = () => { void service.close().then(() => process.exit(0), () => process.exit(1)); setTimeout(() => process.exit(1), 3000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

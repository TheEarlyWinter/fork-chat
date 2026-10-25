import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createParserService } from '../runtime/parser.mjs';
import { createCheckedFetch, assertMineruUrl } from '../lib/parser-network.js';
import { createParserRuntimeClient } from '../lib/parser-runtime-client.js';
import { createUploadStore } from '../lib/upload-store.js';
import { createDocumentService, getDocumentOwner } from '../lib/document-service.js';

const token = 'a'.repeat(64), fileId = 'b'.repeat(32) + '.pdf';
const options = { token: 'SYNTHETIC_MINERU_KEY', apiBase: 'https://mineru.net/api/v4', modelVersion: 'vlm', language: 'ch', isOcr: true, timeoutSeconds: 30, pollIntervalSeconds: 0 };
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-secure-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t, extra = {}) {
  const dataDir = await temp(t);
  await fs.mkdir(path.join(dataDir, 'uploads'));
  await fs.writeFile(path.join(dataDir, 'uploads', fileId), Buffer.alloc(128, 65));
  const service = await createParserService({ dataDir, authToken: token, ...extra });
  const base = await listen(service.server);
  t.after(() => service.close());
  const call = (route, init = {}) => fetch(base + route, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const submit = async (override = {}) => call('/jobs', { method: 'POST', body: JSON.stringify({ fileId, sha256: createHash('sha256').update(await fs.readFile(path.join(dataDir, 'uploads', fileId))).digest('hex'), filename: 'fixture.pdf', options, ...override }) });
  return { dataDir, service, base, call, submit };
}
function zip(text) {
  const name = Buffer.from('full.md'), raw = Buffer.from(text);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(raw.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(raw.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(c.length + name.length, 12); end.writeUInt32LE(h.length + name.length + raw.length, 16);
  return Buffer.concat([h, name, raw, c, name, end]);
}
async function finished(call, id) {
  for (let i = 0; i < 200; i++) {
    const state = await (await call(`/jobs/${id}`)).json();
    if (state.settled) return state;
    await delay(10);
  }
  throw new Error('local job failed to settle');
}

test('native policy allows official OSS, rejects credentials, suffix attacks and nonstandard ports', () => {
  assert.doesNotThrow(() => assertMineruUrl('https://mineru.oss-cn-shanghai.aliyuncs.com/x'));
  for (const url of ['https://evilmineru.net/x', 'https://mineru.net.evil.invalid', 'https://user:pass@mineru.net', 'https://mineru.net:8443/x', 'http://mineru.net']) assert.throws(() => assertMineruUrl(url));
});

test('actual response counts reject missing and fraudulent content-length', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const checked = createCheckedFetch({ fetchImpl: async () => new Response('ten-bytes!', { headers }) });
    const response = await checked('https://mineru.net/test', { maxResponseBytes: 4 });
    await assert.rejects(() => response.arrayBuffer(), /实际字节上限/);
  }
});

test('redirects strip cross-origin credentials and never replay a PUT body', async () => {
  let calls = 0;
  const checked = createCheckedFetch({ fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn-mineru.openxlab.org.cn/result' } });
    assert.equal(init.headers.has('authorization'), false); assert.equal(init.headers.has('cookie'), false);
    return new Response('ok');
  } });
  assert.equal(await (await checked('https://mineru.net/api', { headers: { Authorization: 'Bearer TEST', Cookie: 'session=TEST' } })).text(), 'ok');
  calls = 0;
  await assert.rejects(() => checked('https://mineru.net/api', { method: 'PUT', body: 'fixture' }), /不能重放/);
  assert.equal(calls, 1);
});

test('helper requires capability on every route and refuses arbitrary paths or job IDs', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/health')).status, 401);
  assert.equal((await f.call('/health', { headers: { Authorization: 'Bearer WRONG' } })).status, 401);
  assert.equal((await f.submit({ filePath: '/etc/passwd' })).status, 400);
  assert.equal((await f.submit({ jobId: '../config' })).status, 400);
  assert.equal((await f.submit({ fileId: '../mineru-settings.json' })).status, 400);
  assert.equal((await f.call('/health')).status, 200);
});

test('helper and upload store reject intermediate directory symlinks', async t => {
  const dir = await temp(t), outside = await temp(t);
  await fs.mkdir(path.join(dir, 'uploads'));
  await fs.writeFile(path.join(outside, 'secret.pdf'), 'synthetic-secret');
  await fs.symlink(outside, path.join(dir, 'uploads', 'nested'));
  const { assertReadableInsideDataDir } = await import('../runtime/parser.mjs');
  await assert.rejects(() => assertReadableInsideDataDir(path.join(dir, 'uploads', 'nested', 'secret.pdf'), dir), /符号链接/);
  const store = createUploadStore({ dataDir: dir });
  const { uploadId } = store.begin({ owner: 'u', filename: 'file.pdf', total: 1 });
  await fs.rename(path.join(dir, 'uploads'), path.join(dir, 'old-uploads'));
  await fs.symlink(outside, path.join(dir, 'uploads'));
  await assert.rejects(() => store.writeChunk({ uploadId, owner: 'u', index: 0, buffer: Buffer.from('data') }), /符号链接/);
});

test('helper rejects changed file contents before contacting any upstream', async t => {
  const f = await fixture(t, { fetchImpl: async () => assert.fail('corrupted file must not leave the helper') });
  const { jobId } = await (await f.submit({ sha256: 'f'.repeat(64) })).json();
  const state = await finished(f.call, jobId);
  assert.equal(state.status, 'error');
  assert.match(state.error, /完整性校验失败/);
});

test('cache rejects linked parents and replaces a linked leaf without writing its target', async t => {
  const { storeMineruCache } = await import('../lib/mineru-parse.js');
  const dir = await temp(t), outside = await temp(t), cacheId = 'a'.repeat(16), data = Buffer.from('synthetic ZIP');
  await fs.symlink(outside, path.join(dir, 'mineru-cache'));
  assert.equal(await storeMineruCache({ dataDir: dir, cacheId, zipBytes: data }), null);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(dir, 'mineru-cache'));
  await fs.mkdir(path.join(dir, 'mineru-cache', cacheId), { recursive: true });
  const protectedFile = path.join(outside, 'protected.txt');
  await fs.writeFile(protectedFile, 'unchanged');
  await fs.symlink(protectedFile, path.join(dir, 'mineru-cache', cacheId, 'result.zip'));
  assert.ok(await storeMineruCache({ dataDir: dir, cacheId, zipBytes: data }));
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readFile(path.join(dir, 'mineru-cache', cacheId, 'result.zip')), data);
});

test('same-index concurrent writes reject one without corrupting accounting', async t => {
  const store = createUploadStore({ dataDir: await temp(t) });
  const { uploadId } = store.begin({ owner: 'u', filename: 'file.pdf', size: 2, total: 2 });
  const results = await Promise.allSettled([0, 0].map(index => store.writeChunk({ uploadId, owner: 'u', index, buffer: Buffer.from('A') })));
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await store.writeChunk({ uploadId, owner: 'u', index: 1, buffer: Buffer.from('B') });
  const file = await store.resolve({ uploadId, owner: 'u' });
  assert.equal((await fs.readFile(file.filePath)).toString(), 'AB');
});

test('untrusted headers never become upload owner and missing context fails closed', () => {
  assert.throws(() => getDocumentOwner({ req: { header: () => 'forged' } }), /可信/);
  const c = { get: () => ({ appId: 'timeline-reverser', principal: { principalId: 'real-owner', kind: 'app' } }), req: { header: () => 'forged' } };
  const owner = getDocumentOwner(c); c.req.header = () => 'different-forgery';
  assert.equal(getDocumentOwner(c), owner);
});

test('cancellation interrupts actual fetch signal and cannot later publish success', async t => {
  let reached, aborted = false;
  const waiting = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, init) => {
    reached();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true });
    });
  } });
  const { jobId } = await (await f.submit()).json();
  await waiting;
  const cancelled = await (await f.call(`/jobs/${jobId}`, { method: 'DELETE' })).json();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.settled, true); assert.equal(aborted, true);
  assert.equal((await finished(f.call, jobId)).status, 'cancelled');
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'helper-results')), []);
});

test('late completion after cancel remains cancelled; deadline aborts; concurrent slots are bounded', async t => {
  const f = await fixture(t, { parseFn: async () => { await delay(80); return { ok: true, text: 'late result' }; }, jobTimeoutMs: 25 });
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.submit()));
  assert.equal(responses.filter(r => r.status === 202).length, 2);
  assert.equal(responses.filter(r => r.status === 429).length, 3);
  for (const response of responses.filter(r => r.status === 202)) {
    const { jobId } = await response.json();
    assert.equal((await finished(f.call, jobId)).status, 'cancelled');
  }
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'helper-results')), []);
});

test('permission refusal cleans capability file, does not fetch or use an alternative runtime', async t => {
  let starts = 0;
  const dataDir = await temp(t);
  const sdk = { runtime: { async start(input) { starts++; assert.equal(input.profile, 'native'); throw Object.assign(new Error('denied'), { code: 'APP_RUNTIME_PERMISSION_DENIED' }); }, async fetch() { assert.fail('must not call network'); } } };
  const client = createParserRuntimeClient({ sdk, dataDir });
  await assert.rejects(() => client.ready(), { code: 'APP_RUNTIME_PERMISSION_DENIED' });
  assert.equal(starts, 1);
  assert.deepEqual(await fs.readdir(path.join(dataDir, '.parser-control')), []);
});

test('26,764,891 bytes traverse real helper HTTP and a local HTTP upstream with identical hash', async t => {
  const source = Buffer.alloc(26_764_891, 0x5a);
  const expectedHash = createHash('sha256').update(source).digest('hex');
  let uploadBytes = 0, actualHash;
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/file-urls/batch')) {
      req.resume(); res.end(JSON.stringify({ code: 0, data: { batch_id: 'local', file_urls: ['https://mineru.oss-cn-shanghai.aliyuncs.com/upload'] } }));
    } else if (req.method === 'PUT') {
      const hash = createHash('sha256');
      for await (const chunk of req) { uploadBytes += chunk.length; hash.update(chunk); }
      actualHash = hash.digest('hex'); res.end('{}');
    } else if (req.url.includes('/extract-results/')) {
      res.end(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://cdn-mineru.openxlab.org.cn/result.zip' }] } }));
    } else if (req.url === '/result.zip') { res.end(zip('这是一个仅用于离线回归的合成解析结果，长度超过二十个汉字。')); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  const upstreamBase = await listen(upstream);
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const f = await fixture(t, { fetchImpl: (url, init) => fetch(upstreamBase + new URL(url).pathname, init) });
  await fs.writeFile(path.join(f.dataDir, 'uploads', fileId), source);
  const { jobId } = await (await f.submit()).json();
  const state = await finished(f.call, jobId);
  assert.equal(state.status, 'done', state.error);
  assert.equal(uploadBytes, source.length); assert.equal(actualHash, expectedHash);
  assert.equal(state.resultFile, jobId + '.json'); assert.equal(state.resultPath, undefined);
  const result = JSON.parse(await fs.readFile(path.join(f.dataDir, 'helper-results', state.resultFile), 'utf8'));
  assert.equal(result.ok, true); assert.equal(result._zip, undefined); assert.ok(result.text.length > 20);
});

function context(body, who = 'alice', params = {}) {
  return { get: () => ({ appId: 'timeline-reverser', principal: { principalId: who, kind: 'app' } }), req: { json: async () => body, param: key => params[key] }, json: (value, status = 200) => Response.json(value, { status }) };
}

test('parent routes reject foreign references and cancellation settles without creating success', async t => {
  const routes = new Map();
  const app = Object.fromEntries(['post', 'get', 'delete'].map(method => [method, (route, fn) => routes.set(method + route, fn)]));
  const config = { mineruEnabled: true, mineruApiToken: 'SYNTHETIC', mineruTimeoutSeconds: 30 };
  const service = createDocumentService({ sdk: {}, dataDir: await temp(t), getConfig: key => config[key], runtimeClient: { async parse(_file, _options, { signal }) { await delay(10000, undefined, { signal }); } } });
  service.register(app);
  const upload = await routes.get('post/api/document/upload')(context({ filename: 'file.pdf', total: 1, size: 3, index: 0, chunk: Buffer.from('PDF').toString('base64') }));
  const { uploadId } = await upload.json();
  assert.equal((await routes.get('post/api/document/parse')(context({ uploadId, mode: 'cloud' }, 'mallory'))).status, 400);
  const { jobId } = await (await routes.get('post/api/document/parse')(context({ uploadId, mode: 'cloud' }))).json();
  assert.equal((await routes.get('get/api/document/parse/:jobId')(context({}, 'mallory', { jobId }))).status, 404);
  const cancel = await (await routes.get('delete/api/document/parse/:jobId')(context({}, 'alice', { jobId }))).json();
  assert.equal(cancel.status, 'cancelled'); assert.equal(cancel.settled, true);
  const result = await (await routes.get('get/api/document/parse/:jobId')(context({}, 'alice', { jobId }))).json();
  assert.equal(result.result, undefined); assert.equal(result.status, 'cancelled');
});

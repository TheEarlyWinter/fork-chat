import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createParserService } from '../runtime/parser.mjs';

const AUTH_TOKEN = 'a'.repeat(64);
const JOB_OPTIONS = {
  token: 'synthetic-mineru-token',
  apiBase: 'https://mineru.net/api/v4',
  timeoutSeconds: 30,
};

function latch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tempDir(t, prefix = 'fork-parser-cleanup-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(service) {
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${service.server.address().port}`;
}

async function writeSyntheticUpload(dataDir, suffix = '.pdf', content = 'synthetic parser input') {
  const fileId = 'b'.repeat(32) + suffix;
  const uploadDir = path.join(dataDir, 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const bytes = Buffer.from(content, 'utf8');
  await fs.writeFile(path.join(uploadDir, fileId), bytes);
  return { fileId, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function submit(base, upload, filename = 'synthetic.pdf') {
  const response = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileId: upload.fileId,
      sha256: upload.sha256,
      filename,
      options: JOB_OPTIONS,
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 202, responseText);
  return JSON.parse(responseText);
}

async function getState(base, jobId) {
  const response = await fetch(`${base}/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function unusedPort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startProductionParser(dataDir, controlName, port) {
  const entry = fileURLToPath(new URL('../runtime/parser.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, String(port), controlName], {
    cwd: dataDir,
    env: { ...process.env, HOME: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('PARSER_READY')) resolve();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!stdout.includes('PARSER_READY')) reject(new Error(`parser entry exited before ready: ${code}/${signal}\n${stderr}`));
    });
  });
  await ready;
  return { child, getOutput: () => ({ stdout, stderr }) };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

test('createParserService: 正常结果可读，close 删除本服务未取走的 done 结果', async (t) => {
  const dataDir = await tempDir(t);
  const upload = await writeSyntheticUpload(dataDir);
  const service = await createParserService({
    dataDir,
    authToken: AUTH_TOKEN,
    parseFn: async ({ fileName, fileSize, signal }) => {
      signal.throwIfAborted();
      return { ok: true, text: `synthetic result for ${fileName} (${fileSize})` };
    },
  });
  t.after(() => service.close().catch(() => {}));
  const base = await listen(service);

  const { jobId } = await submit(base, upload);
  await service.jobs.get(jobId).finished;
  const state = await getState(base, jobId);
  assert.equal(state.status, 'done');
  assert.equal(state.resultFile, `${jobId}.json`);

  const resultPath = path.join(dataDir, 'helper-results', state.resultFile);
  assert.deepEqual(JSON.parse(await fs.readFile(resultPath, 'utf8')), {
    ok: true,
    text: `synthetic result for synthetic.pdf (${upload.bytes.length})`,
    engineLabel: 'MinerU 云端',
  });

  await service.close();
  await assert.rejects(() => fs.stat(resultPath), { code: 'ENOENT' });
});

test('close 幂等，只删除自己的结果，不干扰其它活服务或未知文件', async (t) => {
  const dataDir = await tempDir(t, 'fork-parser-close-');
  const uploadA = await writeSyntheticUpload(dataDir, '.pdf', 'service A input');
  const uploadB = { ...uploadA, fileId: 'c'.repeat(32) + '.pdf' };
  await fs.copyFile(
    path.join(dataDir, 'uploads', uploadA.fileId),
    path.join(dataDir, 'uploads', uploadB.fileId),
  );
  uploadB.sha256 = createHash('sha256').update(uploadB.bytes).digest('hex');

  const serviceA = await createParserService({
    dataDir,
    authToken: AUTH_TOKEN,
    parseFn: async () => ({ ok: true, text: 'result owned by A' }),
  });
  const bStarted = latch();
  const bRelease = latch();
  const serviceB = await createParserService({
    dataDir,
    authToken: AUTH_TOKEN,
    parseFn: async ({ signal }) => {
      bStarted.resolve();
      await bRelease.promise;
      signal.throwIfAborted();
      return { ok: true, text: 'result owned by B' };
    },
  });
  t.after(async () => {
    bRelease.resolve();
    await Promise.allSettled([serviceA.close(), serviceB.close()]);
  });
  const baseA = await listen(serviceA);
  const baseB = await listen(serviceB);

  const a = await submit(baseA, uploadA);
  await serviceA.jobs.get(a.jobId).finished;
  const aResultPath = path.join(dataDir, 'helper-results', `${a.jobId}.json`);

  const b = await submit(baseB, uploadB);
  await bStarted.promise;
  assert.equal((await getState(baseB, b.jobId)).status, 'running');

  const unknownPath = path.join(dataDir, 'helper-results', 'unknown.json');
  await fs.writeFile(unknownPath, 'must remain');

  await serviceA.close();
  await serviceA.close();
  await assert.rejects(() => fs.stat(aResultPath), { code: 'ENOENT' });

  bRelease.resolve();
  await serviceB.jobs.get(b.jobId).finished;
  const bResultPath = path.join(dataDir, 'helper-results', `${b.jobId}.json`);
  assert.equal(JSON.parse(await fs.readFile(bResultPath, 'utf8')).text, 'result owned by B');
  assert.equal(await fs.readFile(unknownPath, 'utf8'), 'must remain');

  await serviceB.close();
  assert.equal(await fs.readFile(unknownPath, 'utf8'), 'must remain');
});

test('close 与 openCheckedFile 的 job 注册窗口交错时不落地 job', async (t) => {
  const dataDir = await tempDir(t, 'fork-parser-close-race-');
  const upload = await writeSyntheticUpload(dataDir, '.pdf', 'close race input');
  const uploadPath = path.join(dataDir, 'uploads', upload.fileId);
  let parseCalls = 0;
  const service = await createParserService({
    dataDir,
    authToken: AUTH_TOKEN,
    parseFn: async ({ signal }) => {
      parseCalls += 1;
      signal.throwIfAborted();
      return { ok: true, text: 'close race result' };
    },
  });
  t.after(() => service.close().catch(() => {}));
  const base = await listen(service);
  const openEntered = latch();
  const releaseOpen = latch();
  const uploadHandleClosed = latch();
  const originalOpen = fs.open;
  const openMock = t.mock.method(fs, 'open', async (target, ...args) => {
    const handle = await originalOpen(target, ...args);
    if (path.resolve(String(target)) !== uploadPath) return handle;
    const originalClose = handle.close.bind(handle);
    handle.close = async (...closeArgs) => {
      uploadHandleClosed.resolve();
      return originalClose(...closeArgs);
    };
    openEntered.resolve();
    await releaseOpen.promise;
    return handle;
  });

  let responseOrError;
  try {
    const posting = fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: upload.fileId,
        sha256: upload.sha256,
        filename: 'close-race.pdf',
        options: JOB_OPTIONS,
      }),
    });
    await openEntered.promise;
    const closing = service.close();
    await closing;
    releaseOpen.resolve();
    responseOrError = await posting.then(
      async (response) => ({ status: response.status, body: await response.text() }),
      (error) => ({ error }),
    );
    await uploadHandleClosed.promise;
  } finally {
    releaseOpen.resolve();
    t.mock.restoreAll();
  }

  if (responseOrError.error) assert.ok(responseOrError.error instanceof Error);
  else assert.ok([400, 503].includes(responseOrError.status), responseOrError.body);
  assert.equal(parseCalls, 0);
  assert.equal(service.jobs.size, 0);
  await uploadHandleClosed.promise;
  const resultNames = await fs.readdir(path.join(dataDir, 'helper-results'));
  assert.deepEqual(resultNames.filter((name) => /^[a-f0-9]{32}\.json$/.test(name)), []);
  assert.equal(openMock.mock.callCount(), 1);
});

test('生产 parser 启动入口清扫超过 10 分钟的匹配普通结果，保留新鲜、非匹配和符号链接', async (t) => {
  const dataDir = await tempDir(t, 'fork-parser-startup-');
  const resultsDir = path.join(dataDir, 'helper-results');
  const controlDir = path.join(dataDir, '.parser-control');
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.mkdir(controlDir, { recursive: true });

  const stale = 'd'.repeat(32) + '.json';
  const fresh = 'e'.repeat(32) + '.json';
  const nonMatch = 'not-a-job-result.json';
  const linked = 'f'.repeat(32) + '.json';
  const outsideDir = await tempDir(t, 'fork-parser-outside-');
  const outsideTarget = path.join(outsideDir, 'outside-result.json');
  await fs.writeFile(path.join(resultsDir, stale), JSON.stringify({ stale: true }));
  await fs.writeFile(path.join(resultsDir, fresh), JSON.stringify({ fresh: true }));
  await fs.writeFile(path.join(resultsDir, nonMatch), JSON.stringify({ nonMatch: true }));
  await fs.writeFile(outsideTarget, 'outside target must survive');
  await fs.symlink(outsideTarget, path.join(resultsDir, linked));

  const old = new Date(Date.now() - 11 * 60 * 1000);
  await fs.utimes(path.join(resultsDir, stale), old, old);
  await fs.utimes(path.join(resultsDir, nonMatch), old, old);

  const controlName = '1'.repeat(32) + '.json';
  await fs.writeFile(path.join(controlDir, controlName), JSON.stringify({ token: AUTH_TOKEN }), { mode: 0o600 });
  const processPort = await unusedPort();
  const running = await startProductionParser(dataDir, controlName, processPort);
  t.after(() => stopChild(running.child).catch(() => {}));

  await assert.rejects(() => fs.stat(path.join(resultsDir, stale)), { code: 'ENOENT' });
  await fs.stat(path.join(resultsDir, fresh));
  await fs.stat(path.join(resultsDir, nonMatch));
  const linkedStat = await fs.lstat(path.join(resultsDir, linked));
  assert.equal(linkedStat.isSymbolicLink(), true);
  assert.equal(await fs.readFile(outsideTarget, 'utf8'), 'outside target must survive');

  await stopChild(running.child);
  assert.equal(running.getOutput().stderr, '');
});

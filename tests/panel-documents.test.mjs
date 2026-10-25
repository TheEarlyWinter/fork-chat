import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentPipeline } from '../ui/assets/panel-documents.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function inactiveError() {
  const error = new Error('画布任务已失效。');
  error.code = 'PANEL_INACTIVE';
  return error;
}

function makeAbortable(inactive) {
  return (promise, signal) => new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason || inactive());
    };

    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    hana: { id: 'hana-test' },
    canMutateCanvas: () => true,
    isDisposed: () => false,
    inactiveError,
    safeDetail: message => `safe:${message}`,
    badgeStats: { textContent: 'idle' },
    requestHost: async (...args) => {
      calls.push(args);
      throw new Error(`unexpected host request: ${args[1]}`);
    },
    waitForParser: async () => {},
    ...overrides,
  };
  if (!overrides.abortable) deps.abortable = makeAbortable(() => deps.inactiveError());
  return { deps, calls };
}

function complexFile(name, bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46])) {
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    name,
    size: raw.byteLength,
    arrayBuffer: async () => raw,
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function makePendingParserHarness() {
  const waiters = [];
  const { deps, calls } = makeDeps({
    requestHost: async (hana, route, init = {}) => {
      calls.push({ hana, route, init });
      if (route === '/api/document/parse' && init.method === 'POST') {
        const { filename } = JSON.parse(init.body);
        const jobId = filename === 'target.pdf' ? 'job-target' : 'job-survivor';
        return { json: async () => ({ ok: true, jobId, timeoutMs: 30000 }) };
      }
      if (init.method === 'DELETE') return { json: async () => ({ ok: true }) };
      throw new Error(`unexpected parser request: ${route}`);
    },
    waitForParser: (_delay, signal) => new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason || inactiveError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiters.push({ resolve, reject });
    }),
  });
  return { pipeline: createDocumentPipeline(deps), waiters, calls };
}

const CHUNK_RAW_BYTES = 6 * 1024 * 1024;
const CHUNK_THRESHOLD = 16 * 1024 * 1024;

function makeChunkedFile(name = 'large.bin') {
  const chunkBytes = [
    Uint8Array.from([0x00, 0x01, 0x02]),
    Uint8Array.from([0x10, 0x11, 0x12, 0x13]),
    Uint8Array.from([0xf0, 0xf1, 0xf2, 0xf3, 0xf4]),
  ];
  const size = CHUNK_THRESHOLD + 1;
  const slices = [];
  return {
    size,
    chunkBytes,
    slices,
    file: {
      name,
      size,
      slice(start, end) {
        const index = slices.length;
        slices.push({ start, end, index });
        const bytes = chunkBytes[index];
        const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return { arrayBuffer: async () => raw };
      },
    },
  };
}

function makeChunkedHarness({ uploadResponses, parserResult }) {
  const calls = [];
  const { deps } = makeDeps({
    requestHost: async (hana, route, init = {}) => {
      const call = { hana, route, init };
      calls.push(call);
      if (route === '/api/document/upload') {
        const body = JSON.parse(init.body);
        const response = uploadResponses[body.index] || { ok: false, error: `缺少第 ${body.index} 块桩响应` };
        return { json: async () => response };
      }
      if (route === '/api/document/parse' && init.method === 'POST') {
        return { json: async () => ({ ok: true, jobId: 'chunk-job', timeoutMs: 30000 }) };
      }
      if (route === '/api/document/parse/chunk-job') {
        return { json: async () => ({ ok: true, status: 'done', result: parserResult }) };
      }
      if (route === '/api/document/client-error') return { json: async () => ({ ok: true }) };
      if (init.method === 'DELETE') return { json: async () => ({ ok: true }) };
      throw new Error(`unexpected host request: ${route}`);
    },
    waitForParser: async () => {},
  });
  return { pipeline: createDocumentPipeline(deps), deps, calls };
}

function makeParserHarness({
  name = 'scenario.pdf',
  size = 88,
  includeArrayBuffer = true,
  startData = {},
  statuses = [],
}) {
  const calls = [];
  const waits = [];
  let statusIndex = 0;
  const receipt = { ok: true, jobId: 'job-scenario', timeoutMs: 30000, ...startData };
  const { deps } = makeDeps({
    requestHost: async (hana, route, init = {}) => {
      const call = { hana, route, init };
      calls.push(call);
      if (route === '/api/document/parse' && init.method === 'POST') {
        return { json: async () => receipt };
      }
      if (route === `/api/document/parse/${encodeURIComponent(receipt.jobId)}`) {
        const status = statuses[statusIndex] || statuses.at(-1) || { ok: true, status: 'pending', stage: 'waiting' };
        statusIndex += 1;
        return { json: async () => status };
      }
      if (route === '/api/document/client-error') return { json: async () => ({ ok: true }) };
      if (init.method === 'DELETE') return { json: async () => ({ ok: true }) };
      throw new Error(`unexpected host request: ${route}`);
    },
    waitForParser: async delay => { waits.push(delay); },
  });
  const file = { name, size };
  if (includeArrayBuffer) {
    const bytes = Uint8Array.from([0x07, 0x08]);
    file.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return { pipeline: createDocumentPipeline(deps), deps, calls, waits, file };
}

test('panel-documents: text extraction returns real text, counts, preview, and metadata', async () => {
  const text = '标题\n第一行\n\n第二行';
  const file = {
    name: 'notes.md',
    size: 42,
    text: async () => text,
  };
  const { deps } = makeDeps();
  const pipeline = createDocumentPipeline(deps);

  const result = await pipeline.extractDocumentFile(file, 'card-doc');

  assert.equal(result.ok, true);
  assert.equal(result.filename, 'notes.md');
  assert.equal(result.extension, '.md');
  assert.equal(result.size, 42);
  assert.equal(result.charCount, text.length);
  assert.equal(result.lineCount, 3);
  assert.equal(result.text, text);
  assert.equal(result.preview, text);
  assert.equal(pipeline.pendingCount, 0);
});

test('panel-documents: text read failures return a safe read-stage error and clean up', async () => {
  const { deps } = makeDeps({ safeDetail: message => `redacted:${message}` });
  const pipeline = createDocumentPipeline(deps);
  const file = {
    name: 'broken.txt',
    size: 12,
    text: async () => { throw new Error('disk detail'); },
  };

  const result = await pipeline.extractDocumentFile(file, 'card-broken');

  assert.deepEqual(result, {
    ok: false,
    filename: 'broken.txt',
    stage: 'read',
    error: 'redacted:disk detail',
  });
  assert.equal(pipeline.pendingCount, 0);
});

test('panel-documents: inactive canvas cancels before reading or registering a task', async () => {
  let readCalled = false;
  const { deps } = makeDeps({ canMutateCanvas: () => false });
  const pipeline = createDocumentPipeline(deps);
  const file = {
    name: 'not-read.md',
    text: async () => {
      readCalled = true;
      return 'must not be read';
    },
  };

  const result = await pipeline.extractDocumentFile(file, 'card-inactive');

  assert.deepEqual(result, {
    ok: false,
    cancelled: true,
    filename: 'not-read.md',
    stage: 'cancelled',
    error: '画布任务已失效。',
  });
  assert.equal(readCalled, false);
  assert.equal(pipeline.pendingCount, 0);
});

test('panel-documents: complex parser success returns parsed text and sends base64 content', async () => {
  const parsedText = 'PDF text\nsecond';
  const raw = Uint8Array.from([0, 1, 2, 250, 251]);
  const calls = [];
  const { deps } = makeDeps({
    requestHost: async (hana, route, init = {}) => {
      calls.push({ hana, route, init });
      if (route === '/api/document/parse' && init.method === 'POST') {
        return { json: async () => ({ ok: true, jobId: 'job-42', timeoutMs: 30000 }) };
      }
      if (route === '/api/document/parse/job-42') {
        return {
          json: async () => ({
            ok: true,
            status: 'done',
            result: {
              ok: true,
              filename: 'report.pdf',
              extension: '.pdf',
              text: parsedText,
              charCount: parsedText.length,
              lineCount: 2,
              preview: 'PDF text',
              engineLabel: 'test-parser',
            },
          }),
        };
      }
      throw new Error(`unexpected host request: ${route}`);
    },
    waitForParser: async () => {},
  });
  const pipeline = createDocumentPipeline(deps);
  const file = complexFile('report.pdf', raw);

  const result = await pipeline.extractDocumentFile(file, 'card-pdf');

  assert.equal(result.ok, true);
  assert.equal(result.filename, 'report.pdf');
  assert.equal(result.extension, '.pdf');
  assert.equal(result.size, file.size);
  assert.equal(result.text, parsedText);
  assert.equal(result.charCount, parsedText.length);
  assert.equal(result.lineCount, 2);
  assert.equal(result.preview, 'PDF text');
  assert.equal(result.engineLabel, 'test-parser');
  assert.equal(deps.badgeStats.textContent, 'idle');
  assert.equal(pipeline.pendingCount, 0);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].hana, deps.hana);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    filename: 'report.pdf',
    contentBase64: Buffer.from(raw).toString('base64'),
  });
  assert.equal(calls[1].route, '/api/document/parse/job-42');
});

test('panel-documents: parser failures return real failure data and report the client error', async () => {
  const calls = [];
  const { deps } = makeDeps({
    requestHost: async (hana, route, init = {}) => {
      calls.push({ hana, route, init });
      if (route === '/api/document/parse') {
        return { json: async () => ({ ok: false, error: '解析服务拒绝' }) };
      }
      if (route === '/api/document/client-error') return { json: async () => ({ ok: true }) };
      throw new Error(`unexpected host request: ${route}`);
    },
  });
  const pipeline = createDocumentPipeline(deps);

  const result = await pipeline.extractDocumentFile(complexFile('broken.pdf'), 'card-parser-failed');

  assert.deepEqual(result, {
    ok: false,
    filename: 'broken.pdf',
    extension: '.pdf',
    size: 4,
    charCount: 0,
    lineCount: 0,
    stage: '未知',
    error: '解析服务拒绝',
  });
  const report = calls.find(call => call.route === '/api/document/client-error');
  assert.ok(report, 'parser failure must be reported to the host');
  assert.deepEqual(JSON.parse(report.init.body), {
    stage: '未知',
    message: '解析服务拒绝 | size=4',
  });
  assert.equal(deps.badgeStats.textContent, 'idle');
  assert.equal(pipeline.pendingCount, 0);
});

test('panel-documents: abortDocumentTasksFor cancels only the target card and preserves the survivor', async () => {
  const { pipeline, waiters, calls } = makePendingParserHarness();
  const targetPromise = pipeline.extractDocumentFile(complexFile('target.pdf'), 'card-target');
  const survivorPromise = pipeline.extractDocumentFile(complexFile('survivor.pdf'), 'card-survivor');

  try {
    await waitUntil(() => waiters.length === 2, 'both parser tasks should reach the waiting state');
    assert.equal(pipeline.pendingCount, 2);

    pipeline.abortDocumentTasksFor('card-target');
    const targetResult = await targetPromise;

    assert.equal(targetResult.ok, false);
    assert.equal(targetResult.cancelled, true);
    assert.equal(targetResult.filename, 'target.pdf');
    assert.equal(pipeline.pendingCount, 1);
    assert.deepEqual(
      calls.filter(call => call.init.method === 'DELETE').map(call => call.route),
      ['/api/document/parse/job-target'],
    );

    let survivorSettled = false;
    survivorPromise.then(() => { survivorSettled = true; });
    await Promise.resolve();
    assert.equal(survivorSettled, false, 'a different card task must remain pending');
  } finally {
    pipeline.abortAll();
    await Promise.allSettled([targetPromise, survivorPromise]);
  }
});

test('panel-documents: abortAll cancels every task and clears pendingCount immediately', async () => {
  const { pipeline, waiters, calls } = makePendingParserHarness();
  const firstPromise = pipeline.extractDocumentFile(complexFile('target.pdf'), 'card-one');
  const secondPromise = pipeline.extractDocumentFile(complexFile('survivor.pdf'), 'card-two');

  try {
    await waitUntil(() => waiters.length === 2, 'both parser tasks should reach the waiting state');
    assert.equal(pipeline.pendingCount, 2);

    pipeline.abortAll();

    assert.equal(pipeline.pendingCount, 0);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.cancelled, true);
    assert.equal(second.cancelled, true);
    assert.deepEqual(
      calls.filter(call => call.init.method === 'DELETE').map(call => call.route).sort(),
      ['/api/document/parse/job-survivor', '/api/document/parse/job-target'].sort(),
    );
  } finally {
    pipeline.abortAll();
    await Promise.allSettled([firstPromise, secondPromise]);
  }
});

test('panel-documents: files over 16 MiB upload every chunk and parse the uploaded document', async () => {
  const fixture = makeChunkedFile('large.bin');
  const text = 'chunked text\nsecond line';
  const { pipeline, deps, calls } = makeChunkedHarness({
    uploadResponses: [
      { ok: true, uploadId: 'upload-1', done: false },
      { ok: true, uploadId: 'upload-1', done: false },
      { ok: true, uploadId: 'upload-1', done: true },
    ],
    parserResult: {
      ok: true,
      filename: 'large.bin',
      extension: '.bin',
      text,
      charCount: text.length,
      lineCount: 2,
      preview: 'chunked text',
      engineLabel: 'chunk-parser',
    },
  });

  const result = await pipeline.extractDocumentFile(fixture.file, 'card-large');

  assert.equal(result.ok, true);
  assert.equal(result.filename, 'large.bin');
  assert.equal(result.extension, '.bin');
  assert.equal(result.size, fixture.size);
  assert.equal(result.text, text);
  assert.equal(result.charCount, text.length);
  assert.equal(result.lineCount, 2);
  assert.equal(result.preview, 'chunked text');
  assert.equal(result.engineLabel, 'chunk-parser');
  assert.equal(deps.badgeStats.textContent, 'idle');
  assert.equal(pipeline.pendingCount, 0);

  const uploadBodies = calls
    .filter(call => call.route === '/api/document/upload')
    .map(call => JSON.parse(call.init.body));
  assert.equal(uploadBodies.length, 3);
  assert.deepEqual(uploadBodies.map(body => body.index), [0, 1, 2]);
  assert.deepEqual(uploadBodies.map(body => body.total), [3, 3, 3]);
  assert.deepEqual(uploadBodies.map(body => body.uploadId), [null, 'upload-1', 'upload-1']);
  assert.deepEqual(
    uploadBodies.map(body => body.chunk),
    fixture.chunkBytes.map(bytes => Buffer.from(bytes).toString('base64')),
  );
  assert.deepEqual(fixture.slices, [
    { start: 0, end: CHUNK_RAW_BYTES, index: 0 },
    { start: CHUNK_RAW_BYTES, end: CHUNK_RAW_BYTES * 2, index: 1 },
    { start: CHUNK_RAW_BYTES * 2, end: CHUNK_RAW_BYTES * 3, index: 2 },
  ]);

  const parseStart = calls.find(call => call.route === '/api/document/parse');
  assert.deepEqual(JSON.parse(parseStart.init.body), { filename: 'large.bin', uploadId: 'upload-1' });
});

test('panel-documents: a failed upload chunk returns its concrete error and never starts parsing', async () => {
  const fixture = makeChunkedFile('chunk-failure.bin');
  const { pipeline, calls } = makeChunkedHarness({
    uploadResponses: [
      { ok: true, uploadId: 'upload-1', done: false },
      { ok: false, error: '第 2 块损坏' },
    ],
    parserResult: null,
  });

  const result = await pipeline.extractDocumentFile(fixture.file, 'card-chunk-failure');

  assert.deepEqual(result, {
    ok: false,
    filename: 'chunk-failure.bin',
    extension: '.bin',
    size: fixture.size,
    charCount: 0,
    lineCount: 0,
    stage: '未知',
    error: '第 2 块损坏',
  });
  assert.deepEqual(
    calls.filter(call => call.route === '/api/document/upload').map(call => JSON.parse(call.init.body).index),
    [0, 1],
  );
  assert.equal(calls.some(call => call.route === '/api/document/parse'), false);
  const report = calls.find(call => call.route === '/api/document/client-error');
  assert.deepEqual(JSON.parse(report.init.body), {
    stage: '未知',
    message: `第 2 块损坏 | size=${fixture.size}`,
  });
  assert.equal(pipeline.pendingCount, 0);
});

test('panel-documents: completed chunks without an uploadId return 分块上传未完成', async () => {
  const fixture = makeChunkedFile('chunk-no-id.bin');
  const { pipeline, calls } = makeChunkedHarness({
    uploadResponses: [
      { ok: true, done: false },
      { ok: true, done: false },
      { ok: true, done: true },
    ],
    parserResult: null,
  });

  const result = await pipeline.extractDocumentFile(fixture.file, 'card-chunk-no-id');

  assert.deepEqual(result, {
    ok: false,
    filename: 'chunk-no-id.bin',
    extension: '.bin',
    size: fixture.size,
    charCount: 0,
    lineCount: 0,
    stage: '未知',
    error: '分块上传未完成',
  });
  assert.equal(calls.filter(call => call.route === '/api/document/upload').length, 3);
  assert.equal(calls.some(call => call.route === '/api/document/parse'), false);
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/document/client-error').init.body), {
    stage: '未知',
    message: `分块上传未完成 | size=${fixture.size}`,
  });
  assert.equal(pipeline.pendingCount, 0);
});

test('panel-documents: complex files without arrayBuffer send empty inline content and still return parsed data', async () => {
  const text = 'server-side text';
  const { pipeline, calls, file } = makeParserHarness({
    name: 'legacy.docx',
    includeArrayBuffer: false,
    statuses: [{
      ok: true,
      status: 'done',
      result: {
        ok: true,
        filename: 'legacy.docx',
        extension: '.docx',
        text,
        charCount: text.length,
        lineCount: 1,
        preview: text,
      },
    }],
  });

  const result = await pipeline.extractDocumentFile(file, 'card-no-array-buffer');

  assert.equal(result.ok, true);
  assert.equal(result.filename, 'legacy.docx');
  assert.equal(result.extension, '.docx');
  assert.equal(result.size, file.size);
  assert.equal(result.text, text);
  assert.equal(result.charCount, text.length);
  assert.equal(result.lineCount, 1);
  assert.equal(result.preview, text);
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/document/parse').init.body), {
    filename: 'legacy.docx',
    contentBase64: '',
  });
  assert.equal(calls.filter(call => call.route.includes('/api/document/parse/')).length, 1);
});

test('panel-documents: pending parser status continues polling and returns the eventual text', async () => {
  const text = 'pending first\ndone later';
  const { pipeline, deps, calls, waits, file } = makeParserHarness({
    statuses: [
      { ok: true, status: 'pending', stage: 'OCR', elapsedMs: 2500 },
      {
        ok: true,
        status: 'done',
        result: {
          ok: true,
          filename: 'scenario.pdf',
          extension: '.pdf',
          text,
          charCount: text.length,
          lineCount: 2,
          preview: 'pending first',
        },
      },
    ],
  });

  const result = await pipeline.extractDocumentFile(file, 'card-pending');

  assert.equal(result.ok, true);
  assert.equal(result.text, text);
  assert.equal(result.charCount, text.length);
  assert.equal(result.lineCount, 2);
  assert.equal(result.preview, 'pending first');
  assert.deepEqual(waits, [1200, 1200]);
  assert.equal(calls.filter(call => call.route === '/api/document/parse/job-scenario').length, 2);
  assert.equal(deps.badgeStats.textContent, 'idle');
});

for (const [terminalStatus, errorMessage] of [
  ['error', '云端解析失败'],
  ['cancelled', '云端任务已取消'],
]) {
  test(`panel-documents: parser ${terminalStatus} status returns a concrete failure`, async () => {
    const { pipeline, calls, waits, file } = makeParserHarness({
      statuses: [{ ok: true, status: terminalStatus, error: errorMessage }],
    });

    const result = await pipeline.extractDocumentFile(file, `card-${terminalStatus}`);

    assert.deepEqual(result, {
      ok: false,
      filename: 'scenario.pdf',
      extension: '.pdf',
      size: 88,
      charCount: 0,
      lineCount: 0,
      stage: '未知',
      error: errorMessage,
    });
    assert.deepEqual(waits, [1200]);
    assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/document/client-error').init.body), {
      stage: '未知',
      message: `${errorMessage} | size=88`,
    });
    assert.deepEqual(
      calls.filter(call => call.init.method === 'DELETE').map(call => call.route),
      ['/api/document/parse/job-scenario'],
    );
  });
}

test('panel-documents: parser deadline returns the timeout error and requests cancellation', async () => {
  const { pipeline, calls, waits, file } = makeParserHarness({
    startData: { jobId: 'job-deadline', timeoutMs: 30000 },
    statuses: [],
  });
  const originalNow = Date.now;
  let nowCall = 0;
  Date.now = () => {
    nowCall += 1;
    return nowCall === 1 ? 0 : 40000;
  };

  let result;
  try {
    result = await pipeline.extractDocumentFile(file, 'card-deadline');
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(result, {
    ok: false,
    filename: 'scenario.pdf',
    extension: '.pdf',
    size: 88,
    charCount: 0,
    lineCount: 0,
    stage: '未知',
    error: '解析超过等待时限，已请求取消',
  });
  assert.deepEqual(waits, []);
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/document/client-error').init.body), {
    stage: '未知',
    message: '解析超过等待时限，已请求取消 | size=88',
  });
  assert.deepEqual(
    calls.filter(call => call.init.method === 'DELETE').map(call => call.route),
    ['/api/document/parse/job-deadline'],
  );
});

test('panel-documents: a done status with data.ok false returns the final parser error', async () => {
  const { pipeline, calls, file } = makeParserHarness({
    statuses: [{
      ok: true,
      status: 'done',
      result: { ok: false, error: '最终结果没有可读文本' },
    }],
  });

  const result = await pipeline.extractDocumentFile(file, 'card-final-failure');

  assert.deepEqual(result, {
    ok: false,
    filename: 'scenario.pdf',
    extension: '.pdf',
    size: 88,
    charCount: 0,
    lineCount: 0,
    stage: '未知',
    error: '最终结果没有可读文本',
  });
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/document/client-error').init.body), {
    stage: '未知',
    message: '最终结果没有可读文本 | size=88',
  });
  assert.deepEqual(
    calls.filter(call => call.init.method === 'DELETE').map(call => call.route),
    ['/api/document/parse/job-scenario'],
  );
});

test('panel-documents: disposal after the start receipt returns a concrete cancellation result', async () => {
  let disposed = false;
  const calls = [];
  const { deps } = makeDeps({
    isDisposed: () => disposed,
    requestHost: async (hana, route, init = {}) => {
      calls.push({ hana, route, init });
      if (route === '/api/document/parse' && init.method === 'POST') {
        disposed = true;
        return { json: async () => ({ ok: true, jobId: 'job-disposed', timeoutMs: 30000 }) };
      }
      if (init.method === 'DELETE') return { json: async () => ({ ok: true }) };
      throw new Error(`unexpected host request: ${route}`);
    },
  });
  const pipeline = createDocumentPipeline(deps);

  const result = await pipeline.extractDocumentFile(complexFile('disposed.pdf'), 'card-disposed');

  assert.deepEqual(result, {
    ok: false,
    cancelled: true,
    filename: 'disposed.pdf',
    stage: 'cancelled',
  });
  assert.deepEqual(
    calls.filter(call => call.init.method === 'DELETE').map(call => call.route),
    ['/api/document/parse/job-disposed'],
  );
  assert.equal(calls.some(call => call.route === '/api/document/client-error'), false);
  assert.equal(pipeline.pendingCount, 0);
});

test('panel-documents: empty abortAll and unknown-card abortDocumentTasksFor are no-ops', () => {
  const pipeline = createDocumentPipeline(makeDeps().deps);

  assert.doesNotThrow(() => pipeline.abortAll());
  assert.doesNotThrow(() => pipeline.abortDocumentTasksFor('missing-card'));
  assert.equal(pipeline.pendingCount, 0);
});

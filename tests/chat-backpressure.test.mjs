import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatService } from '../lib/chat.js';

const MB = 1024 * 1024;

function latch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mockContext(body, reqSignal) {
  const store = new Map([[
    'appRequestContext',
    { appId: 'timeline-reverser', principal: { principalId: 'test-user', credentialId: 'test-surface' } },
  ]]);
  return {
    get: (key) => store.get(key),
    req: {
      json: async () => body,
      raw: { signal: reqSignal },
      signal: reqSignal,
    },
    json: (data, status = 200) => Response.json(data, { status }),
  };
}

async function readFrames(response) {
  const text = await response.text();
  return text.trim() ? text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function withGuard(promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve('guard-timeout'), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('背压超过 16 MiB 时发射 STREAM_BACKPRESSURE，并中止上游而非伪装成 done', async () => {
  const overLimit = latch();
  const lateEventGate = latch();
  const abortSeen = latch();
  const cancelSeen = latch();
  const returnRequested = latch();
  const lifecycleLogs = [];
  const cancelIds = [];
  const chunk = 'x'.repeat(MB);
  let upstreamSignal;
  let signalWasAborted = false;
  let step = 0;

  const sdk = {
    logger: {
      info: (message) => lifecycleLogs.push(message),
      error: (message) => lifecycleLogs.push(message),
    },
    models: {
      streamEvents(input, { signal }) {
        upstreamSignal = signal;
        signal.addEventListener('abort', () => {
          signalWasAborted = signal.aborted;
          abortSeen.resolve();
          // 故意让一个迟到的上游事件落到 abort 之后，验证泵不会继续跑成成功。
          lateEventGate.resolve();
        }, { once: true });
        const iterator = {
          async next() {
            if (step === 0) {
              step += 1;
              return { done: false, value: { type: 'start', requestId: input.requestId } };
            }
            if (step <= 17) {
              step += 1;
              // 预留终态帧后，实际触发点可能早于第 16 个完整 1 MiB 帧；
              // 从第 15 个增量开始放行观察，不把测试绑死在某个帧号。
              if (step >= 16) overLimit.resolve();
              return { done: false, value: { type: 'text-delta', requestId: input.requestId, delta: chunk } };
            }
            if (step === 18) {
              step += 1;
              await lateEventGate.promise;
              return { done: false, value: { type: 'text-delta', requestId: input.requestId, delta: 'late-after-abort' } };
            }
            return { done: true };
          },
          async return() {
            returnRequested.resolve();
            return { done: true };
          },
        };
        return { [Symbol.asyncIterator]: () => iterator };
      },
      cancel(requestId) {
        cancelIds.push(requestId);
        cancelSeen.resolve();
      },
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });
  const response = await service.handleStream(mockContext({
    requestId: 'req-backpressure-latch',
    cardId: 'card-backpressure',
    modelRef: 'synthetic/model',
    messages: [{ role: 'user', content: 'do not read this stream yet' }],
  }));

  // 消费者在超过上限前完全不读；只等模型侧明确 latch，不靠 sleep 猜时序。
  await overLimit.promise;
  let body;
  let terminalOutcome;
  try {
    terminalOutcome = await withGuard(Promise.all([
      abortSeen.promise,
      cancelSeen.promise,
      returnRequested.promise,
    ]).then(() => 'settled'));
  } finally {
    // 当前缺陷会卡在迟到事件上；释放它确保红灯也能干净收束。
    lateEventGate.resolve();
    body = await response.text();
  }

  assert.equal(terminalOutcome, 'settled', '背压终止必须在上游继续产出前完成');
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(signalWasAborted, true);
  assert.deepEqual(cancelIds, ['req-backpressure-latch']);
  assert.equal(service.inFlightRequests.size, 0);

  const frames = body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const terminal = frames.at(-1);
  assert.equal(terminal.type, 'error');
  assert.equal(terminal.code, 'STREAM_BACKPRESSURE');
  assert.equal(frames.filter((frame) => frame.type === 'done').length, 0);
  assert.ok(lifecycleLogs.some((message) => /terminal=error/.test(message) && /errorCode=STREAM_BACKPRESSURE/.test(message)));
  assert.equal(lifecycleLogs.some((message) => /terminal=done/.test(message)), false);
});

test('持续消费时总输出超过 16 MiB 仍可正常完成，但单帧过大必须明确拒绝', async () => {
  const manyChunks = 9;
  const chunk = 'y'.repeat(2 * MB);
  const sdk = {
    models: {
      streamEvents(input) {
        let index = 0;
        const iterator = {
          async next() {
            await Promise.resolve();
            if (index < manyChunks) {
              index += 1;
              return { done: false, value: { type: 'text-delta', requestId: input.requestId, delta: chunk } };
            }
            if (index === manyChunks) {
              index += 1;
              return { done: false, value: { type: 'done', requestId: input.requestId } };
            }
            return { done: true };
          },
          async return() { return { done: true }; },
        };
        return { [Symbol.asyncIterator]: () => iterator };
      },
    },
  };
  const service = createChatService(sdk, { timeoutMs: 5000 });
  const response = await service.handleStream(mockContext({
    requestId: 'req-backpressure-consuming',
    modelRef: 'synthetic/model',
    messages: [{ role: 'user', content: 'consume continuously' }],
  }));
  const frames = await readFrames(response);
  assert.equal(frames.at(-1).type, 'done');
  assert.equal(service.inFlightRequests.size, 0);

  const oversizedService = createChatService({
    models: {
      async *streamEvents(input) {
        yield { type: 'text-delta', requestId: input.requestId, delta: 'z'.repeat(17 * MB) };
        yield { type: 'done', requestId: input.requestId };
      },
    },
  }, { timeoutMs: 5000 });
  const oversizedResponse = await oversizedService.handleStream(mockContext({
    requestId: 'req-backpressure-single-frame',
    modelRef: 'synthetic/model',
    messages: [{ role: 'user', content: 'single oversized frame' }],
  }));
  const oversizedFrames = await readFrames(oversizedResponse);
  const terminal = oversizedFrames.at(-1);
  assert.equal(terminal.type, 'error');
  assert.ok(['STREAM_BACKPRESSURE', 'STREAM_FRAME_TOO_LARGE'].includes(terminal.code));
  assert.equal(oversizedFrames.filter((frame) => frame.type === 'done').length, 0);
  assert.equal(oversizedService.inFlightRequests.size, 0);
});

test('正常小响应仍返回 start、正文与 done', async () => {
  const service = createChatService({
    models: {
      async *streamEvents(input) {
        yield { type: 'text-delta', requestId: input.requestId, delta: 'small response' };
        yield { type: 'done', requestId: input.requestId };
      },
    },
  });
  const frames = await readFrames(await service.handleStream(mockContext({
    requestId: 'req-backpressure-small',
    modelRef: 'synthetic/model',
    messages: [{ role: 'user', content: 'small' }],
  })));
  assert.deepEqual(frames.map((frame) => frame.type), ['start', 'text-delta', 'done']);
  assert.equal(frames[1].delta, 'small response');
  assert.equal(service.inFlightRequests.size, 0);
});

test('超大 start 元数据在建流前拒绝，不调用模型或泄漏请求登记', async () => {
  let modelCalls = 0;
  let cancelCalls = 0;
  const service = createChatService({ models: {
    async *streamEvents() {
      modelCalls += 1;
      yield { type: 'text-delta', delta: 'must not run' };
      yield { type: 'done' };
    },
    cancel() { cancelCalls += 1; },
  } }, { timeoutMs: 1000 });
  const response = await service.handleStream(mockContext({
    requestId: 'req-backpressure-oversized-start',
    modelRef: 'synthetic/' + 'm'.repeat(17 * MB),
    messages: [{ role: 'user', content: 'synthetic' }],
  }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'STREAM_BACKPRESSURE');
  assert.equal(modelCalls, 0);
  assert.equal(cancelCalls, 0);
  assert.equal(service.inFlightRequests.size, 0);
});

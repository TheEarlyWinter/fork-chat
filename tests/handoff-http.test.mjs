import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREPARE_MAX_BODY_BYTES,
  fail,
  httpError,
  readJsonBody,
} from '../lib/handoff-http.js';

// ---------------------------------------------------------------------------
// 夹具：只给 fail() 一个最小 Hono 上下文的 json()，不启动服务
// ---------------------------------------------------------------------------

function jsonContext() {
  const calls = [];
  return {
    calls,
    json(value, status = 200) {
      const result = { status, body: value, headers: {} };
      calls.push(result);
      return result;
    },
  };
}

/** 一个有界 reader 的请求体，用来验证正常流式路径没有被关掉 */
function streamedBody(chunks) {
  let index = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// C-I7：错误响应不能凭任意 HANDOFF_ 前缀 / status / name 透传上游原文
// ---------------------------------------------------------------------------

test('C-I7: an upstream error that borrows a HANDOFF_ prefix never echoes its message or status', async () => {
  const error = new Error('SECRET_SENTINEL /private/path');
  error.code = 'HANDOFF_UPSTREAM';
  error.status = 502;

  const response = fail(jsonContext(), error);
  const text = JSON.stringify(response.body);
  assert.equal(text.includes('SECRET_SENTINEL'), false, '上游 message 不能回传');
  assert.equal(text.includes('/private/path'), false, '路径不能回传');
  assert.equal(response.body.code, 'HANDOFF_INTERNAL', '未知 code 不能原样回传');
  assert.equal(response.status, 500, '未知 status 不能原样回传');
  assert.equal(response.body.error, '请求未执行');
});

test('C-I7: a forged HandoffError with a known code still gets the fixed safe wording', async () => {
  const error = new Error('SECRET_SENTINEL 正文与路径 /private/path');
  error.name = 'HandoffError';
  error.code = 'HANDOFF_HOST_ERROR';

  const response = fail(jsonContext(), error);
  const text = JSON.stringify(response.body);
  assert.equal(text.includes('SECRET_SENTINEL'), false);
  assert.equal(text.includes('/private/path'), false);
  assert.equal(response.body.code, 'HANDOFF_HOST_ERROR');
  assert.equal(response.status, 502);
  assert.equal(typeof response.body.error, 'string');
  assert.notEqual(response.body.error, error.message);
  assert.equal(response.body.error.includes('HANDOFF_'), false);
});

test('C-I7: an unknown code with a forged success status is neither echoed nor returned as success', async () => {
  const error = new Error('SECRET_SENTINEL');
  error.code = 'HANDOFF_MADE_UP_CODE';
  error.status = 200;
  error.details = { path: '/private/path', token: 'SECRET_SENTINEL' };

  const response = fail(jsonContext(), error);
  assert.notEqual(response.status, 200);
  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'HANDOFF_INTERNAL');
  assert.equal(JSON.stringify(response.body).includes('SECRET_SENTINEL'), false);
  assert.equal(Object.hasOwn(response.body, 'details'), false);
});

test('C-I7: local 413/403/404 refusals keep their own code, status and short wording', async () => {
  const cases = [
    ['HANDOFF_INVALID_REQUEST', '请求体超过上限', 413],
    ['HANDOFF_PERMISSION_MISSING', '缺少分支交接所需授权', 403],
    ['HANDOFF_ACTION_NOT_FOUND', '交接动作不存在或不属于当前调用方', 404],
  ];
  for (const [code, message, status] of cases) {
    const response = fail(jsonContext(), httpError(code, message, status));
    assert.equal(response.status, status, code);
    assert.equal(response.body.ok, false, code);
    assert.equal(response.body.code, code, code);
    assert.equal(response.body.error, message, code);
  }
});

// ---------------------------------------------------------------------------
// M1：没有有界 raw stream 时直接拒绝，不先做无界读取
// ---------------------------------------------------------------------------

test('M1: readJsonBody refuses the unbounded arrayBuffer path instead of buffering first', async () => {
  let arrayBufferCalls = 0;
  let jsonCalls = 0;
  const c = {
    req: {
      async arrayBuffer() {
        arrayBufferCalls += 1;
        const bytes = Buffer.from('{"a":1}', 'utf8');
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      async json() {
        jsonCalls += 1;
        return { ok: true };
      },
    },
  };

  await assert.rejects(
    readJsonBody(c, 64),
    error => error?.code === 'HANDOFF_INVALID_REQUEST' && error?.status === 400,
    '没有有界流时必须明确拒绝',
  );
  assert.equal(arrayBufferCalls, 0, '不得先调用无界 arrayBuffer');
  assert.equal(jsonCalls, 0, '不得回退到无界 json');
});

test('M1: readJsonBody refuses an empty request object as an invalid request', async () => {
  await assert.rejects(
    readJsonBody({ req: {} }, 64),
    error => error?.code === 'HANDOFF_INVALID_REQUEST' && error?.status === 400,
  );
});

test('M1: the bounded streaming path still enforces the real byte limit and UTF-8 strictness', async () => {
  const huge = Buffer.from(JSON.stringify({ text: 'x'.repeat(200) }), 'utf8');
  await assert.rejects(
    readJsonBody({ req: { raw: streamedBody([huge]) } }, 64),
    error => error?.code === 'HANDOFF_INVALID_REQUEST' && error?.status === 413,
  );

  await assert.rejects(
    readJsonBody({ req: { raw: streamedBody([Buffer.from([0xff, 0xfe, 0xfd])]) } }, 64),
    error => error?.code === 'HANDOFF_INVALID_REQUEST' && error?.status === 400,
  );

  const parsed = await readJsonBody(
    { req: { raw: streamedBody([Buffer.from('{"a":', 'utf8'), Buffer.from('1}', 'utf8')]) } },
    64,
  );
  assert.deepEqual(parsed, { a: 1 });
  assert.ok(PREPARE_MAX_BODY_BYTES > 64);
});

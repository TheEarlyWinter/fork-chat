import test from "node:test";
import assert from "node:assert/strict";
import {
  createChatService,
  redactCredentials,
  sanitizeErrorCode,
  sanitizeErrorMessage,
  canCancel,
} from "../lib/chat.js";

// 辅助创建模拟 Hono Context
function createMockContext({
  body,
  query = {},
  principal = { principalId: "user-1", credentialId: "surface-1", kind: "app" },
  appId = "fork-chat",
  reqSignal,
} = {}) {
  const store = new Map();
  if (principal !== null) {
    store.set("appRequestContext", {
      appId,
      principal,
    });
  }

  const c = {
    get: (key) => store.get(key),
    set: (key, val) => store.set(key, val),
    req: {
      json: async () => {
        if (body === undefined) throw new Error("Unexpected end of JSON input");
        return body;
      },
      query: (k) => query[k] || "",
      raw: {
        signal: reqSignal,
      },
      signal: reqSignal,
    },
    json: (data, status = 200) => Response.json(data, { status }),
    text: (str, status = 200) => new Response(str, { status }),
  };
  return c;
}

// 辅助读取 NDJSON 帧列表
async function readNdjsonFrames(response) {
  const text = await response.text();
  if (!text.trim()) return [];
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l));
}

// 1. 成功完整流式推理返回 NDJSON，并记录 start 与 end 两端日志
test("createChatService: 成功完整流式推理返回 NDJSON，并记录 start 与 end 两端日志", async () => {
  const cancelCalls = [];
  const logged = [];
  const sdk = {
    logger: {
      info: async (msg) => {
        logged.push(msg);
      },
    },
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        yield { type: "text-delta", requestId: input.requestId, delta: "你好" };
        yield { type: "text-delta", requestId: input.requestId, delta: "，世界！" };
        yield { type: "done", requestId: input.requestId };
      },
      cancel: async (id) => cancelCalls.push(id),
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });
  const c = createMockContext({
    body: {
      requestId: "req-success-1",
      cardId: "card-123",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "hello world prompt" }],
      systemPrompt: "secret system prompt",
    },
  });

  const res = await service.handleStream(c);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/x-ndjson; charset=utf-8");

  const frames = await readNdjsonFrames(res);
  assert.equal(frames.length, 4);
  assert.deepEqual(frames[0], {
    type: "start",
    requestId: "req-success-1",
    provider: "openai",
    model: "gpt-4o",
  });
  assert.deepEqual(frames[1], {
    type: "text-delta",
    requestId: "req-success-1",
    delta: "你好",
  });
  assert.deepEqual(frames[2], {
    type: "text-delta",
    requestId: "req-success-1",
    delta: "，世界！",
  });
  assert.deepEqual(frames[3], {
    type: "done",
    requestId: "req-success-1",
  });

  assert.equal(cancelCalls.length, 0);
  assert.equal(service.inFlightRequests.size, 0);

  // 验证两端日志：第 1 条为 receipt，第 2 条为 terminal end
  assert.equal(logged.length, 2);
  assert.match(logged[0], /\[chat-stream\] receipt requestId=req-success-1 cardId=card-123/);
  assert.match(logged[1], /\[chat-stream\] requestId=req-success-1 cardId=card-123 provider=openai model=gpt-4o/);
  assert.match(logged[1], /terminal=done/);

  // 严格脱敏：绝不记录 user message 或 systemPrompt
  assert.doesNotMatch(logged[0], /hello world/);
  assert.doesNotMatch(logged[1], /hello world/);
  assert.doesNotMatch(logged[0], /secret system prompt/);
  assert.doesNotMatch(logged[1], /secret system prompt/);
});

test('Codex requests do not force a reasoning effort or rewrite the start metadata', async () => {
  const calls = [];
  const sdk = { models: { async *streamEvents(input) {
    calls.push(input);
    yield { type: 'text-delta', delta: 'answer' };
    yield { type: 'done', stopReason: 'stop' };
  } } };
  const service = createChatService(sdk, { getAgentFullProfile: async () => ({
    id: 'luna-tester', provider: 'openai-codex', model: 'gpt-5.6-luna', systemPrompt: 'identity',
  }) });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId: 'req-codex-compat', agentId: 'luna-tester', modelRef: 'ignored/other', messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'openai-codex');
  assert.equal(calls[0].model, 'gpt-5.6-luna');
  assert.equal(Object.hasOwn(calls[0], 'reasoningEffort'), false);
  assert.equal(Object.hasOwn(frames[0], 'reasoningEffort'), false);
  assert.equal(frames.at(-1).type, 'done');
});

test('Gemini requests retain their prior options and successful logs do not invent an error code', async () => {
  const calls = [], logs = [];
  const service = createChatService({ logger: { info(message) { logs.push(message); } }, models: {
    async *streamEvents(input) { calls.push(input); yield { type: 'text-delta', delta: 'answer' }; yield { type: 'done' }; },
  } });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId: 'req-gemini-unchanged', modelRef: 'gemini/gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], 'reasoningEffort'), false);
  assert.equal(Object.hasOwn(frames[0], 'reasoningEffort'), false);
  assert.equal(frames.at(-1).type, 'done');
  assert.match(logs.at(-1), /terminal=done/);
  assert.doesNotMatch(logs.at(-1), /errorCode=/);
});

test('valid reasoningEffort is validated and forwarded to streamEvents and start frame', async () => {
  const calls = [];
  const service = createChatService({ models: {
    async *streamEvents(input) { calls.push(input); yield { type: 'text-delta', delta: 'answer' }; yield { type: 'done' }; },
  } });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId: 'req-reasoning-high', modelRef: 'openai-codex/gpt-5.6-luna', reasoningEffort: 'high', messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, 'high');
  assert.equal(frames[0].reasoningEffort, 'high');
  assert.equal(frames.at(-1).type, 'done');
});

test('invalid or unsupported reasoningEffort fails safe and is omitted from streamEvents', async () => {
  const calls = [];
  const service = createChatService({ models: {
    async *streamEvents(input) { calls.push(input); yield { type: 'text-delta', delta: 'answer' }; yield { type: 'done' }; },
  } });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId: 'req-reasoning-invalid', modelRef: 'openai-codex/gpt-5.6-luna', reasoningEffort: 'SUPER_MEGA_TURBO', messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], 'reasoningEffort'), false);
  assert.equal(Object.hasOwn(frames[0], 'reasoningEffort'), false);
  assert.equal(frames.at(-1).type, 'done');
});

test('done assistant text is forwarded when the model emits no text delta', async () => {
  const logs = [];
  const requestId = 'req-done-assistant-text';
  const service = createChatService({
    logger: { info(message) { logs.push(message); } },
    models: { async *streamEvents() {
      yield {
        type: 'done',
        requestId,
        stopReason: 'stop',
        assistant: {
          role: 'assistant',
          content: [
            { type: 'reasoning', reasoning: 'hidden reasoning' },
            { type: 'text', text: 'canonical output' },
          ],
        },
      };
    } },
  });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId,
    modelRef: 'openai-codex/gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.deepEqual(frames.map((frame) => frame.type), ['start', 'text-delta', 'done']);
  assert.equal(frames[1].delta, 'canonical output');
  assert.match(logs.at(-1), /eventCount=1/);
  assert.match(logs.at(-1), /eventTypes=done:1/);
  assert.match(logs.at(-1), /textChars=16/);
  assert.match(logs.at(-1), /reasoningChars=16/);
  assert.match(logs.at(-1), /sawDone=true/);
});

test('final assistant reasoning is counted even after visible text deltas', async () => {
  const logs = [];
  const requestId = 'req-final-reasoning-count';
  const service = createChatService({
    logger: { info(message) { logs.push(message); } },
    models: { async *streamEvents() {
      yield { type: 'text-delta', requestId, delta: 'ok' };
      yield {
        type: 'done',
        requestId,
        stopReason: 'stop',
        assistant: { role: 'assistant', content: [{ type: 'reasoning', reasoning: 'final reasoning' }] },
      };
    } },
  });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId,
    modelRef: 'openai-codex/gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.equal(frames.at(-1).type, 'done');
  assert.match(logs.at(-1), /textChars=2/);
  assert.match(logs.at(-1), /reasoningChars=15/);
  assert.match(logs.at(-1), /sawDone=true/);
});

test('model events with a different request identity fail closed without a success terminal', async () => {
  const service = createChatService({ models: { async *streamEvents() {
    yield { type: 'start', requestId: 'other-request' };
    yield { type: 'text-delta', requestId: 'other-request', delta: 'wrong answer' };
    yield { type: 'done', requestId: 'other-request', stopReason: 'stop' };
  } } });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId: 'req-identity-check',
    modelRef: 'openai-codex/gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.equal(frames.at(-1).type, 'error');
  assert.equal(frames.at(-1).code, 'APP_MODEL_STREAM_IDENTITY');
  assert.equal(frames.filter((frame) => frame.type === 'done').length, 0);
});

test('remaining Codex terminal errors stay failures despite visible output and never retry', async () => {
  let calls = 0;
  const service = createChatService({ models: { async *streamEvents(input) {
    calls++;
    assert.equal(input.provider, 'openai-codex');
    assert.equal(input.model, 'gpt-5.6-luna');
    assert.equal(Object.hasOwn(input, 'reasoningEffort'), false);
    yield { type: 'text-delta', delta: 'apparently complete answer' };
    throw { code: 'APP_MODEL_PROVIDER_ERROR', message: 'The model provider could not complete the request.' };
  } } });
  const frames = await readNdjsonFrames(await service.handleStream(createMockContext({ body: {
    requestId: 'req-codex-still-fails', modelRef: 'openai-codex/gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }],
  } })));
  assert.equal(calls, 1);
  assert.equal(frames.at(-1).type, 'error');
  assert.equal(frames.at(-1).code, 'APP_MODEL_PROVIDER_ERROR');
  assert.equal(frames.filter(frame => frame.type === 'done').length, 0);
});

// 2. 部分 token 后抛出 error 时发射脱敏 error 终态帧且不再吐 done
test("createChatService: 部分 token 后抛出 error 时发射脱敏 error 终态帧且不再吐 done", async () => {
  const logged = [];
  const sdk = {
    logger: { info: (msg) => logged.push(msg) },
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        yield { type: "text-delta", requestId: input.requestId, delta: "前半句" };
        throw { code: "PROVIDER_RATE_LIMIT", message: "Exceeded rate limit for Bearer secret-token-xyz" };
      },
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });
  const c = createMockContext({
    body: {
      requestId: "req-error-1",
      modelRef: "anthropic/claude-3-5-sonnet",
      messages: [{ role: "user", content: "test" }],
    },
  });

  const res = await service.handleStream(c);
  const frames = await readNdjsonFrames(res);

  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "text-delta");
  assert.equal(frames[1].delta, "前半句");

  assert.equal(frames[2].type, "error");
  assert.equal(frames[2].requestId, "req-error-1");
  assert.equal(frames[2].code, "PROVIDER_RATE_LIMIT");
  // 必须脱敏敏感凭据
  assert.doesNotMatch(frames[2].message, /secret-token-xyz/);
  assert.match(frames[2].message, /\[REDACTED\]/);

  // 终态帧恰好一个
  const terminals = frames.filter((f) => f.type === "done" || f.type === "error" || f.type === "cancelled");
  assert.equal(terminals.length, 1);
  assert.equal(service.inFlightRequests.size, 0);
});

// 3. 异常 EOF（流无 done 直接中断）转化为 STREAM_INCOMPLETE 终态
test("createChatService: 异常 EOF（流无 done 直接中断）转化为 STREAM_INCOMPLETE 终态", async () => {
  const sdk = {
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        yield { type: "text-delta", requestId: input.requestId, delta: "未写完的一段话" };
        // 没有发出 done 直接结束
        return;
      },
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });
  const c = createMockContext({
    body: {
      requestId: "req-eof-1",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "continue" }],
    },
  });

  const res = await service.handleStream(c);
  const frames = await readNdjsonFrames(res);

  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "text-delta");
  assert.equal(frames[2].type, "error");
  assert.equal(frames[2].code, "STREAM_INCOMPLETE");
  assert.equal(frames[2].requestId, "req-eof-1");
  assert.equal(service.inFlightRequests.size, 0);
});

// 4. 仅收到 reasoning 无正文但最终 done 时返回 EMPTY_RESPONSE
test("createChatService: 仅收到 reasoning 无正文但最终 done 时返回 EMPTY_RESPONSE", async () => {
  const sdk = {
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        // 只有 reasoning-delta，没有 text-delta
        yield { type: "reasoning-delta", requestId: input.requestId, delta: "Thinking..." };
        yield { type: "done", requestId: input.requestId };
      },
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });
  const c = createMockContext({
    body: {
      requestId: "req-empty-1",
      modelRef: "openai/o1-mini",
      messages: [{ role: "user", content: "think" }],
    },
  });

  const res = await service.handleStream(c);
  const frames = await readNdjsonFrames(res);

  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "error");
  assert.equal(frames[1].code, "EMPTY_RESPONSE");
  assert.equal(frames[1].requestId, "req-empty-1");
});

// 5. 服务端总超时注入触发 REQUEST_TIMEOUT 并调用 models.cancel 且仅一次
test("createChatService: 服务端总超时注入触发 REQUEST_TIMEOUT 并调用 models.cancel 且仅一次", async () => {
  const cancelCalls = [];
  let modelStreamAborted = false;

  const sdk = {
    models: {
      async *streamEvents(input, { signal }) {
        yield { type: "start", requestId: input.requestId };
        signal.addEventListener("abort", () => {
          modelStreamAborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        yield { type: "text-delta", requestId: input.requestId, delta: "太迟了" };
        yield { type: "done", requestId: input.requestId };
      },
      cancel: async (id) => cancelCalls.push(id),
    },
  };

  const service = createChatService(sdk, { timeoutMs: 40 });
  const c = createMockContext({
    body: {
      requestId: "req-timeout-1",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "slow" }],
    },
  });

  const res = await service.handleStream(c);
  const frames = await readNdjsonFrames(res);

  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "error");
  assert.equal(frames[1].code, "REQUEST_TIMEOUT");
  assert.equal(frames[1].requestId, "req-timeout-1");

  assert.equal(modelStreamAborted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0], "req-timeout-1");
  assert.equal(service.inFlightRequests.size, 0);
});

// 6. POST /api/chat/cancel 同一 surface 正常取消与幂等处理
test("createChatService: POST /api/chat/cancel 同一 surface 正常取消与幂等处理", async () => {
  const cancelCalls = [];
  let iteratorSignalAborted = false;

  const sdk = {
    models: {
      async *streamEvents(input, { signal }) {
        yield { type: "start", requestId: input.requestId };
        yield { type: "text-delta", requestId: input.requestId, delta: "正在输出..." };
        signal.addEventListener("abort", () => {
          iteratorSignalAborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        yield { type: "done", requestId: input.requestId };
      },
      cancel: async (id) => cancelCalls.push(id),
    },
  };

  const service = createChatService(sdk, { timeoutMs: 10000 });
  const streamCtx = createMockContext({
    body: {
      requestId: "req-cancel-1",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "cancel me" }],
    },
    principal: { principalId: "user-1", credentialId: "surface-1", kind: "app" },
  });

  const streamPromise = service.handleStream(streamCtx);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(service.inFlightRequests.has("req-cancel-1"), true);

  // 从相同 surface 发起 cancel
  const cancelCtx1 = createMockContext({
    body: { requestId: "req-cancel-1" },
    principal: { principalId: "user-1", credentialId: "surface-1", kind: "app" },
  });

  const cancelRes1 = await service.handleCancel(cancelCtx1);
  assert.equal(cancelRes1.status, 200);
  const cancelJson1 = await cancelRes1.json();
  assert.deepEqual(cancelJson1, { ok: true, cancelled: true });

  const res = await streamPromise;
  const frames = await readNdjsonFrames(res);

  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "text-delta");
  assert.equal(frames[2].type, "cancelled");
  assert.equal(frames[2].code, "REQUEST_CANCELLED");
  assert.equal(frames[2].requestId, "req-cancel-1");

  assert.equal(iteratorSignalAborted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0], "req-cancel-1");
  assert.equal(service.inFlightRequests.size, 0);

  // 重复取消同一已终态的请求：返回 cancelled: false, pending: true 墓碑
  const cancelCtx2 = createMockContext({
    body: { requestId: "req-cancel-1" },
    principal: { principalId: "user-1", credentialId: "surface-1", kind: "app" },
  });
  const cancelRes2 = await service.handleCancel(cancelCtx2);
  const cancelJson2 = await cancelRes2.json();
  assert.deepEqual(cancelJson2, { ok: true, cancelled: false, pending: true });
  assert.equal(cancelCalls.length, 1);
});

// 7. 取消不存在的 requestId 登记墓碑并返回 ok: true, cancelled: false, pending: true
test("createChatService: 取消不存在的 requestId 返回 ok: true, cancelled: false, pending: true", async () => {
  const sdk = { models: { cancel: async () => {} } };
  const service = createChatService(sdk);
  const cancelCtx = createMockContext({
    body: { requestId: "req-nonexistent" },
    principal: { principalId: "user-1", credentialId: "surface-1" },
  });

  const res = await service.handleCancel(cancelCtx);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { ok: true, cancelled: false, pending: true });
});

// 8. 权限与隔离规则 (canCancel) 严密性校验（跨 surface、跨 app、不同 owner、无 cred 回退）
test("createChatService: 权限与隔离规则 (canCancel) 严密性校验", async () => {
  // 同 credentialId 允许取消
  assert.equal(canCancel(
    { principalId: "u1", credentialId: "c1", appId: "app-1" },
    { principalId: "u2", credentialId: "c1", appId: "app-1" }
  ), true);

  // 不同 credentialId（跨 surface）禁止取消，即使是不同或相同 owner
  assert.equal(canCancel(
    { principalId: "u1", credentialId: "c1", appId: "app-1", kind: "app" },
    { principalId: "u1", credentialId: "c2", appId: "app-1", kind: "owner" }
  ), false);

  // 跨 appId 禁止取消
  assert.equal(canCancel(
    { principalId: "u1", credentialId: "c1", appId: "app-1" },
    { principalId: "u1", credentialId: "c1", appId: "app-2" }
  ), false);

  // 发起方无 credentialId 时，比对 principalId（相同允许，不同拒绝）
  assert.equal(canCancel(
    { principalId: "u1", credentialId: null, appId: "app-1" },
    { principalId: "u1", credentialId: null, appId: "app-1" }
  ), true);
  assert.equal(canCancel(
    { principalId: "u1", credentialId: null, appId: "app-1" },
    { principalId: "u2", credentialId: null, appId: "app-1" }
  ), false);

  // 跨 surface 取消返回 HTTP 403
  const sdk = {
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield { type: "done", requestId: input.requestId };
      },
      cancel: async () => {},
    },
  };
  const service = createChatService(sdk);
  const streamCtx = createMockContext({
    body: { requestId: "req-sec-1", modelRef: "openai/gpt-4o", messages: [{ role: "user", content: "x" }] },
    principal: { credentialId: "surf-1", principalId: "u1", appId: "my-app" },
  });
  const streamP = service.handleStream(streamCtx);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const badCancelCtx = createMockContext({
    body: { requestId: "req-sec-1" },
    principal: { credentialId: "surf-2", principalId: "u1", appId: "my-app" }, // 不同 credentialId
  });
  const cancelRes = await service.handleCancel(badCancelCtx);
  assert.equal(cancelRes.status, 403);
  const cancelJson = await cancelRes.json();
  assert.equal(cancelJson.code, "FORBIDDEN");

  const res = await streamP;
  await readNdjsonFrames(res);
});

// 9. 缺少合法 principal 身份时 fail closed 返回 403
test("createChatService: 缺少合法 principal 身份时 fail closed 返回 403", async () => {
  const service = createChatService({});
  const unauthStreamCtx = createMockContext({
    body: { requestId: "req-unauth", modelRef: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
    principal: null,
  });
  const streamRes = await service.handleStream(unauthStreamCtx);
  assert.equal(streamRes.status, 403);
  const streamJson = await streamRes.json();
  assert.equal(streamJson.code, "APP_REQUEST_CONTEXT_REQUIRED");

  const unauthCancelCtx = createMockContext({
    body: { requestId: "req-unauth" },
    principal: null,
  });
  const cancelRes = await service.handleCancel(unauthCancelCtx);
  assert.equal(cancelRes.status, 403);
});

// 10. 客户端断流（ReadableStream cancel）触发 sdk.models.cancel
test("createChatService: 客户端断流（ReadableStream cancel）触发 sdk.models.cancel", async () => {
  const cancelCalls = [];
  const sdk = {
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        yield { type: "text-delta", requestId: input.requestId, delta: "第1个块" };
        await new Promise((resolve) => setTimeout(resolve, 500));
        yield { type: "done", requestId: input.requestId };
      },
      cancel: async (id) => cancelCalls.push(id),
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });
  const c = createMockContext({
    body: {
      requestId: "req-disconnect-1",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  const res = await service.handleStream(c);
  const reader = res.body.getReader();
  const chunk1 = await reader.read();
  assert.equal(chunk1.done, false);

  // 客户端主动断流
  await reader.cancel("User closed tab");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0], "req-disconnect-1");
  assert.equal(service.inFlightRequests.size, 0);
});

// 11. 同一 requestId 运行中并发请求返回 409 Conflict
test("createChatService: 同一 requestId 运行中并发请求返回 409 Conflict", async () => {
  const sdk = {
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield { type: "done", requestId: input.requestId };
      },
      cancel: async () => {},
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });
  const c1 = createMockContext({
    body: {
      requestId: "req-conflict-dup",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "first" }],
    },
  });
  const c2 = createMockContext({
    body: {
      requestId: "req-conflict-dup",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "second" }],
    },
  });

  const streamPromise = service.handleStream(c1);
  const conflictRes = await service.handleStream(c2);

  assert.equal(conflictRes.status, 409);
  const json = await conflictRes.json();
  assert.equal(json.ok, false);
  assert.equal(json.code, "REQUEST_CONFLICT");
  assert.equal(json.requestId, "req-conflict-dup");

  const res1 = await streamPromise;
  await readNdjsonFrames(res1);
  assert.equal(service.inFlightRequests.size, 0);
});

// 12. 参数校验与前置错误返回对应 requestId 与状态码
test("createChatService: 参数校验与前置错误返回对应 requestId 与状态码", async () => {
  const service = createChatService({});

  // 1. 无效 requestId 格式（含非法符号）
  const badIdCtx = createMockContext({
    body: { requestId: "bad id with spaces @!!", messages: [{ role: "user", content: "x" }] },
  });
  const resBadId = await service.handleStream(badIdCtx);
  assert.equal(resBadId.status, 400);
  const jsonBadId = await resBadId.json();
  assert.equal(jsonBadId.code, "INVALID_REQUEST_ID");
  assert.equal(jsonBadId.requestId, "bad id with spaces @!!");

  // 2. 空 messages
  const emptyMsgCtx = createMockContext({
    body: { requestId: "req-valid-1", messages: [] },
  });
  const resEmptyMsg = await service.handleStream(emptyMsgCtx);
  assert.equal(resEmptyMsg.status, 400);
  const jsonEmptyMsg = await resEmptyMsg.json();
  assert.equal(jsonEmptyMsg.code, "INVALID_MESSAGES");
  assert.equal(jsonEmptyMsg.requestId, "req-valid-1");

  // 3. 无效 modelRef
  const badModelCtx = createMockContext({
    body: { requestId: "req-valid-2", messages: [{ role: "user", content: "hi" }], modelRef: "invalid-without-slash" },
  });
  const resBadModel = await service.handleStream(badModelCtx);
  assert.equal(resBadModel.status, 400);
  const jsonBadModel = await resBadModel.json();
  assert.equal(jsonBadModel.code, "INVALID_MODEL_REF");
  assert.equal(jsonBadModel.requestId, "req-valid-2");
});

// 13. 助手资料不存在或无模型配置返回 422 且带 requestId 并记录脱敏终态日志
test("createChatService: 助手资料不存在或无模型配置返回 422 且带 requestId 并记录脱敏终态日志", async () => {
  const logged = [];
  const service = createChatService({
    logger: { info: (msg) => logged.push(msg) },
  }, {
    getAgentFullProfile: async (agentId) => {
      if (agentId === "unknown-agent") throw new Error("宿主未返回目标助手资料 with token=secret-profile-tok");
      if (agentId === "nomodel-agent") return { id: agentId, name: "NoModel" };
      return null;
    },
  });

  const ctxUnknown = createMockContext({
    body: { requestId: "req-agent-422-1", agentId: "unknown-agent", messages: [{ role: "user", content: "hi" }] },
  });
  const resUnknown = await service.handleStream(ctxUnknown);
  assert.equal(resUnknown.status, 422);
  const jsonUnknown = await resUnknown.json();
  assert.equal(jsonUnknown.code, "AGENT_PROFILE_UNAVAILABLE");
  assert.equal(jsonUnknown.requestId, "req-agent-422-1");
  assert.doesNotMatch(jsonUnknown.error, /secret-profile-tok/);

  const ctxNoModel = createMockContext({
    body: { requestId: "req-agent-422-2", agentId: "nomodel-agent", messages: [{ role: "user", content: "hi" }] },
  });
  const resNoModel = await service.handleStream(ctxNoModel);
  assert.equal(resNoModel.status, 422);
  const jsonNoModel = await resNoModel.json();
  assert.equal(jsonNoModel.code, "AGENT_MODEL_UNCONFIGURED");
  assert.equal(jsonNoModel.requestId, "req-agent-422-2");

  assert.equal(service.inFlightRequests.size, 0);
  const termLogs = logged.filter((l) => l.includes("terminal=error"));
  assert.equal(termLogs.length, 2);
  assert.doesNotMatch(termLogs[0], /secret-profile-tok/);
});

// 14. 在 Profile 读取阶段发生超时或取消时能够及时阻断并记录终态日志
test("createChatService: 在 Profile 读取阶段发生超时或取消时能够及时阻断并记录终态日志", async () => {
  const logged = [];
  const service = createChatService({
    logger: { info: (msg) => logged.push(msg) },
  }, {
    timeoutMs: 30,
    getAgentFullProfile: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { id: "slow", provider: "openai", model: "gpt-4o" };
    },
  });

  // 超时测试
  const ctx = createMockContext({
    body: { requestId: "req-profile-timeout", agentId: "slow", messages: [{ role: "user", content: "hi" }] },
  });

  const res = await service.handleStream(ctx);
  assert.equal(res.status, 504);
  const json = await res.json();
  assert.equal(json.code, "REQUEST_TIMEOUT");
  assert.equal(json.requestId, "req-profile-timeout");
  assert.equal(service.inFlightRequests.size, 0);

  const timeoutLog = logged.find((l) => l.includes("requestId=req-profile-timeout") && l.includes("terminal=error"));
  assert.ok(timeoutLog);
  assert.match(timeoutLog, /errorCode=REQUEST_TIMEOUT/);

  // 读取阶段 cancel 测试
  const cancelCtx = createMockContext({
    body: { requestId: "req-profile-cancel", agentId: "slow", messages: [{ role: "user", content: "hi" }] },
  });
  const streamPromise = service.handleStream(cancelCtx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.handleCancel(createMockContext({ body: { requestId: "req-profile-cancel" } }));
  const cancelRes = await streamPromise;
  assert.equal(cancelRes.status, 499);
  const cancelJson = await cancelRes.json();
  assert.equal(cancelJson.code, "REQUEST_CANCELLED");
  assert.equal(cancelJson.requestId, "req-profile-cancel");
});

// 15. 终态后同名 requestId 复用，旧 pump 的延迟 cleanup 不得误删新请求
test("createChatService: 终态后同名 requestId 复用，旧 pump 的延迟 cleanup 不得误删新请求", async () => {
  let oldSession;
  let newSession;
  let delayOldCleanup;

  const sdk = {
    models: {
      async *streamEvents(input) {
        if (!oldSession) {
          oldSession = service.inFlightRequests.get(input.requestId);
          yield { type: "start", requestId: input.requestId };
          yield { type: "text-delta", requestId: input.requestId, delta: "第1轮数据" };
          yield { type: "done", requestId: input.requestId };
        } else {
          newSession = service.inFlightRequests.get(input.requestId);
          if (delayOldCleanup) {
            delayOldCleanup();
          }
          yield { type: "start", requestId: input.requestId };
          yield { type: "text-delta", requestId: input.requestId, delta: "第2轮数据" };
          yield { type: "done", requestId: input.requestId };
        }
      },
      cancel: async () => {},
    },
  };

  const service = createChatService(sdk, { timeoutMs: 5000 });

  const c1 = createMockContext({
    body: {
      requestId: "req-safe-reuse",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "first" }],
    },
  });

  const res1 = await service.handleStream(c1);
  await readNdjsonFrames(res1);
  assert.ok(oldSession);
  assert.equal(service.inFlightRequests.size, 0);

  delayOldCleanup = () => {
    oldSession.cleanup();
  };

  const c2 = createMockContext({
    body: {
      requestId: "req-safe-reuse",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "second" }],
    },
  });

  const res2 = await service.handleStream(c2);
  const frames2 = await readNdjsonFrames(res2);
  assert.ok(newSession);
  assert.notEqual(newSession, oldSession);
  assert.equal(frames2.some((f) => f.delta === "第2轮数据"), true);
  assert.equal(frames2[frames2.length - 1].type, "done");
  assert.equal(service.inFlightRequests.size, 0);
});

// 16. iterator.next() 挂起且 SDK cancel 永不 resolve 时，小预算超时(15ms)即时发射终态并释放 map
test("createChatService: iterator.next() 挂起且 SDK cancel 永不 resolve 时，小预算超时(15ms)即时发射终态并释放 map", async () => {
  let cancelCalled = false;

  const sdk = {
    logger: {
      info: () => Promise.reject(new Error("logger failure test")),
    },
    models: {
      streamEvents: () => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise(() => {});
            },
          };
        },
      }),
      cancel: () => {
        cancelCalled = true;
        return new Promise(() => {});
      },
    },
  };

  const service = createChatService(sdk, { timeoutMs: 15 });
  const c = createMockContext({
    body: {
      requestId: "req-hung-iterator",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "hang" }],
    },
  });

  const startT = Date.now();
  const res = await service.handleStream(c);
  const frames = await readNdjsonFrames(res);
  const duration = Date.now() - startT;

  assert.ok(duration < 200, `duration was ${duration}ms, expected under 200ms`);

  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "error");
  assert.equal(frames[1].code, "REQUEST_TIMEOUT");
  assert.equal(frames[1].requestId, "req-hung-iterator");

  assert.equal(service.inFlightRequests.size, 0);
  assert.equal(cancelCalled, true);
});

// 17. iterator 挂起且 cancel 挂起时，POST /api/chat/cancel 即时返回且终态正常产出
test("createChatService: iterator 挂起且 cancel 挂起时，POST /api/chat/cancel 即时返回且终态正常产出", async () => {
  const sdk = {
    models: {
      streamEvents: () => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise(() => {});
            },
          };
        },
      }),
      cancel: () => new Promise(() => {}),
    },
  };

  const service = createChatService(sdk, { timeoutMs: 10000 });
  const streamCtx = createMockContext({
    body: {
      requestId: "req-cancel-hung",
      modelRef: "openai/gpt-4o",
      messages: [{ role: "user", content: "cancel test" }],
    },
    principal: { principalId: "u-1", credentialId: "c-1" },
  });

  const streamPromise = service.handleStream(streamCtx);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const cancelCtx = createMockContext({
    body: { requestId: "req-cancel-hung" },
    principal: { principalId: "u-1", credentialId: "c-1" },
  });

  const cancelStart = Date.now();
  const cancelRes = await service.handleCancel(cancelCtx);
  const cancelDuration = Date.now() - cancelStart;

  assert.ok(cancelDuration < 50, `cancelDuration was ${cancelDuration}ms, expected under 50ms`);
  assert.equal(cancelRes.status, 200);
  const cancelJson = await cancelRes.json();
  assert.deepEqual(cancelJson, { ok: true, cancelled: true });

  const res = await streamPromise;
  const frames = await readNdjsonFrames(res);

  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "cancelled");
  assert.equal(frames[1].code, "REQUEST_CANCELLED");
  assert.equal(frames[1].requestId, "req-cancel-hung");
  assert.equal(service.inFlightRequests.size, 0);
});

// 18. 预取消墓碑 (cancel-before-stream) 阻断 handleStream 且不触发 profile/model
test("createChatService: 预取消墓碑 (cancel-before-stream) 阻断 handleStream 且不触发 profile/model", async () => {
  let profileCalled = false;
  let modelCalled = false;

  const sdk = {
    models: {
      async *streamEvents() {
        modelCalled = true;
        yield { type: "done" };
      },
    },
  };

  const service = createChatService(sdk, {
    getAgentFullProfile: async () => {
      profileCalled = true;
      return { id: "agent-1", provider: "openai", model: "gpt-4o" };
    },
  });

  const userPrincipal = { principalId: "user-1", credentialId: "surf-1" };

  const cancelCtx = createMockContext({
    body: { requestId: "req-pre-cancel" },
    principal: userPrincipal,
  });
  const cancelRes = await service.handleCancel(cancelCtx);
  assert.equal(cancelRes.status, 200);
  const cancelJson = await cancelRes.json();
  assert.deepEqual(cancelJson, { ok: true, cancelled: false, pending: true });

  const streamCtx = createMockContext({
    body: { requestId: "req-pre-cancel", agentId: "agent-1", messages: [{ role: "user", content: "hi" }] },
    principal: userPrincipal,
  });
  const streamRes = await service.handleStream(streamCtx);
  assert.equal(streamRes.status, 499);
  const streamJson = await streamRes.json();
  assert.equal(streamJson.code, "REQUEST_CANCELLED");
  assert.equal(streamJson.requestId, "req-pre-cancel");

  assert.equal(profileCalled, false);
  assert.equal(modelCalled, false);
  assert.equal(service.inFlightRequests.size, 0);
});

// 19. 预取消墓碑对不同 principal 严格隔离，不阻断其他用户的后续请求
test("createChatService: 预取消墓碑对不同 principal 严格隔离，不阻断其他用户的后续请求", async () => {
  let modelCalls = 0;
  const sdk = {
    models: {
      async *streamEvents(input) {
        modelCalls++;
        yield { type: "start", requestId: input.requestId };
        yield { type: "text-delta", requestId: input.requestId, delta: "content" };
        yield { type: "done", requestId: input.requestId };
      },
    },
  };

  const service = createChatService(sdk);

  const cancelCtxA = createMockContext({
    body: { requestId: "req-shared-id" },
    principal: { principalId: "user-A", credentialId: "surf-A" },
  });
  const cancelRes = await service.handleCancel(cancelCtxA);
  assert.equal((await cancelRes.json()).pending, true);

  const streamCtxB = createMockContext({
    body: { requestId: "req-shared-id", modelRef: "openai/gpt-4o", messages: [{ role: "user", content: "go" }] },
    principal: { principalId: "user-B", credentialId: "surf-B" },
  });
  const streamResB = await service.handleStream(streamCtxB);
  assert.equal(streamResB.status, 200);
  const framesB = await readNdjsonFrames(streamResB);
  assert.equal(framesB[0].type, "start");
  assert.equal(framesB[framesB.length - 1].type, "done");
  assert.equal(modelCalls, 1);
});

// 20. 墓碑 TTL 过期与容量有界 (bounded 1024) 淘汰机制
test("createChatService: 墓碑 TTL 过期与容量有界 (bounded 1024) 淘汰机制", async () => {
  const sdk = {
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        yield { type: "done", requestId: input.requestId };
      },
    },
  };

  let fakeNow = 1000;
  const clock = { now: () => fakeNow };
  const service = createChatService(sdk, {
    clock,
    tombstoneTtlMs: 50,
    tombstoneCapacity: 3,
  });

  const princ = { principalId: "u1", credentialId: "c1" };
  await service.handleCancel(createMockContext({ body: { requestId: "req-ttl" }, principal: princ }));
  assert.equal(service.tombstones.size, 1);

  const streamRes1 = await service.handleStream(createMockContext({
    body: { requestId: "req-ttl", modelRef: "a/b", messages: [{ role: "user", content: "x" }] },
    principal: princ,
  }));
  assert.equal(streamRes1.status, 499);

  fakeNow += 60;
  const streamRes2 = await service.handleStream(createMockContext({
    body: { requestId: "req-ttl", modelRef: "a/b", messages: [{ role: "user", content: "x" }] },
    principal: princ,
  }));
  assert.equal(streamRes2.status, 200);
  await readNdjsonFrames(streamRes2);

  await service.handleCancel(createMockContext({ body: { requestId: "req-cap-1" }, principal: princ }));
  await service.handleCancel(createMockContext({ body: { requestId: "req-cap-2" }, principal: princ }));
  await service.handleCancel(createMockContext({ body: { requestId: "req-cap-3" }, principal: princ }));
  assert.equal(service.tombstones.size, 3);

  await service.handleCancel(createMockContext({ body: { requestId: "req-cap-4" }, principal: princ }));
  assert.equal(service.tombstones.size, 3);

  const streamResCap1 = await service.handleStream(createMockContext({
    body: { requestId: "req-cap-1", modelRef: "a/b", messages: [{ role: "user", content: "x" }] },
    principal: princ,
  }));
  assert.equal(streamResCap1.status, 200);
  await readNdjsonFrames(streamResCap1);

  const streamResCap4 = await service.handleStream(createMockContext({
    body: { requestId: "req-cap-4", modelRef: "a/b", messages: [{ role: "user", content: "x" }] },
    principal: princ,
  }));
  assert.equal(streamResCap4.status, 499);
});

// 21. iterator.return() 在正常 done 与 error 时均被 best-effort 释放且不 await
test("createChatService: iterator.return() 在正常 done 与 error 时均被 best-effort 释放且不 await", async () => {
  let normalReturnCalled = 0;
  let errorReturnCalled = 0;

  const normalSdk = {
    models: {
      streamEvents: (input) => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next() {
              step++;
              if (step === 1) return { done: false, value: { type: "start", requestId: input.requestId } };
              if (step === 2) return { done: false, value: { type: "text-delta", requestId: input.requestId, delta: "hi" } };
              if (step === 3) return { done: false, value: { type: "done", requestId: input.requestId } };
              return { done: true };
            },
            async return() {
              normalReturnCalled++;
              return { done: true };
            },
          };
        },
      }),
    },
  };

  const normalService = createChatService(normalSdk);
  const normalRes = await normalService.handleStream(createMockContext({
    body: { requestId: "req-return-normal", modelRef: "a/b", messages: [{ role: "user", content: "x" }] },
  }));
  await readNdjsonFrames(normalRes);
  assert.equal(normalReturnCalled, 1);

  const errorSdk = {
    models: {
      streamEvents: (input) => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next() {
              step++;
              if (step === 1) return { done: false, value: { type: "start", requestId: input.requestId } };
              throw new Error("provider stream error");
            },
            async return() {
              errorReturnCalled++;
              return new Promise(() => {});
            },
          };
        },
      }),
    },
  };

  const errorService = createChatService(errorSdk);
  const errorRes = await errorService.handleStream(createMockContext({
    body: { requestId: "req-return-error", modelRef: "a/b", messages: [{ role: "user", content: "x" }] },
  }));
  const errorFrames = await readNdjsonFrames(errorRes);
  assert.equal(errorFrames[1].type, "error");
  assert.equal(errorReturnCalled, 1);
});

// 22. 凭据全方位脱敏与严格 errorCode 白名单校验
test("createChatService: 凭据全方位脱敏与严格 errorCode 白名单校验", async () => {
  const textWithSecrets = "error connecting password=super_secret_123 and api_key=ak_998877 and token=xyz_jwt_token and Authorization: Bearer abc.def.ghi";
  const redacted = redactCredentials(textWithSecrets);
  assert.doesNotMatch(redacted, /super_secret_123/);
  assert.doesNotMatch(redacted, /ak_998877/);
  assert.doesNotMatch(redacted, /xyz_jwt_token/);
  assert.doesNotMatch(redacted, /abc\.def\.ghi/);
  assert.match(redacted, /\[REDACTED\]/);

  const jsonWithSecrets = '{"token": "tok_secret_5566", "password": "pwd_secret_7788", "api_key": "key_secret_9900"}';
  const redactedJson = redactCredentials(jsonWithSecrets);
  assert.doesNotMatch(redactedJson, /tok_secret_5566/);
  assert.doesNotMatch(redactedJson, /pwd_secret_7788/);
  assert.doesNotMatch(redactedJson, /key_secret_9900/);

  assert.equal(sanitizeErrorCode("PROVIDER_ERROR"), "PROVIDER_ERROR");
  assert.equal(sanitizeErrorCode("models:rate-limit_1"), "models:rate-limit_1");
  assert.equal(sanitizeErrorCode("123_INVALID_START"), "INTERNAL_ERROR");
  assert.equal(sanitizeErrorCode("ERROR WITH SPACES"), "INTERNAL_ERROR");
  assert.equal(sanitizeErrorCode("secret-token=abc12345"), "INTERNAL_ERROR");
  assert.equal(sanitizeErrorCode(""), "INTERNAL_ERROR");

  const longMsg = "A".repeat(500);
  assert.equal(sanitizeErrorMessage(longMsg, 400).length, 400);

  const logged = [];
  const sdk = {
    logger: { info: (msg) => logged.push(msg) },
    models: {
      async *streamEvents(input) {
        yield { type: "start", requestId: input.requestId };
        throw { code: "ILLEGAL CODE WITH api_key=secret-in-code", message: "Failed password=secret-in-msg" };
      },
    },
  };
  const service = createChatService(sdk);
  const res = await service.handleStream(createMockContext({
    body: { requestId: "req-clean-test", modelRef: "a/b", messages: [{ role: "user", content: "x" }] },
  }));
  const frames = await readNdjsonFrames(res);
  assert.equal(frames[1].type, "error");
  assert.equal(frames[1].code, "INTERNAL_ERROR");
  assert.doesNotMatch(frames[1].message, /secret-in-msg/);

  const endLog = logged.find((l) => l.includes("terminal=error"));
  assert.ok(endLog);
  assert.match(endLog, /errorCode=INTERNAL_ERROR/);
  assert.doesNotMatch(endLog, /secret-in-code/);
  assert.doesNotMatch(endLog, /secret-in-msg/);
});

test('下游完全不读时，流式响应会自己收住，不会把整段内容攒在内存里', async () => {
  // 30 段 1 MB 的 delta，客户端一个字节都不读。
  // 没有背压的话这 30 MB 会全部堆在流的队列里。
  const chunk = 'x'.repeat(1024 * 1024);
  const sdk = {
    logger: { info: async () => {} },
    models: {
      async *streamEvents(input) {
        yield { type: 'start', requestId: input.requestId };
        for (let i = 0; i < 60; i += 1) {
          yield { type: 'text-delta', requestId: input.requestId, delta: chunk };
        }
        yield { type: 'done', requestId: input.requestId };
      },
      cancel: async () => {},
    },
  };
  const service = createChatService(sdk, { timeoutMs: 5000 });
  const res = await service.handleStream(createMockContext({
    body: {
      requestId: 'req-backpressure-1',
      cardId: 'card-bp',
      modelRef: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    },
  }));
  assert.equal(res.status, 200);
  // 故意不消费，等生产端把上限撞到
  await new Promise(resolve => setTimeout(resolve, 300));
  const text = await res.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  // 60 MB 的输入，上限 16 MB。没有背压就是 60 MB 全发完。
  assert.ok(bytes < 24 * 1024 * 1024, `积压必须被截断，实际 ${bytes} 字节`);
  const frames = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(frames.length < 26, `不该把 60 段全发完，实际 ${frames.length} 帧`);
});

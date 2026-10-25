import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrincipalInfo, canCancel } from '../lib/chat-auth.js';
import {
  REQUEST_ID_RE,
  redactCredentials,
  sanitizeErrorCode,
  sanitizeErrorMessage,
  extractAssistantText,
  countAssistantReasoningChars,
  formatMessages,
  logReceipt,
  logStreamEnd,
} from '../lib/chat-protocol.js';
import { createChatLedger } from '../lib/chat-ledger.js';
import { createChatModelPort, resolveChatBinding } from '../lib/chat-model.js';
import { createChatSession } from '../lib/chat-session.js';
import { createChatResponse } from '../lib/chat-stream.js';

const LIB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib');

function context(value) {
  return { get(key) { assert.equal(key, 'appRequestContext'); return value; } };
}

function principal(overrides = {}) {
  return { principalId: 'user-1', credentialId: 'surface-1', kind: 'app', appId: 'app-1', ...overrides };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeSignal {
  constructor() { this.aborted = false; this.listeners = new Set(); }
  addEventListener(type, listener) { if (type === 'abort') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'abort') this.listeners.delete(listener); }
  abort(reason = new Error('aborted')) {
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) listener();
  }
}

test('chat-auth: principal projection fails closed and cancellation is scoped by app/surface identity', () => {
  assert.deepEqual(getPrincipalInfo(context({
    appId: ' context-app ',
    principal: { id: ' user-1 ', credentialId: ' surface-1 ', kind: ' app ' },
  })), { principalId: 'user-1', credentialId: 'surface-1', kind: 'app', appId: 'context-app' });
  assert.deepEqual(getPrincipalInfo(context({ principal: { principalId: 'p-1' } })), {
    principalId: 'p-1', credentialId: null, kind: null, appId: null,
  });
  assert.equal(getPrincipalInfo(context({ principal: { id: '  ', credentialId: ' ' } })), null);
  assert.equal(getPrincipalInfo({ get: () => null }), null);

  const stream = principal();
  assert.equal(canCancel(stream, principal()), true);
  assert.equal(canCancel(stream, principal({ credentialId: 'surface-2' })), false);
  assert.equal(canCancel(stream, principal({ appId: 'app-2' })), false);
  assert.equal(canCancel(stream, principal({ credentialId: null })), false,
    '发起方有 credentialId 时不能降级到 principalId');
  assert.equal(canCancel(principal({ credentialId: null }), principal({ principalId: 'other-user', credentialId: 'surface-1' })), false);
  assert.equal(canCancel(principal({ credentialId: null }), principal({ credentialId: 'surface-1' })), true,
    '发起方没有 credentialId 时按相同 principalId 兼容取消');
  assert.equal(canCancel(null, stream), false);
});

test('chat-protocol: wire projection preserves message shapes while diagnostics redact and bound untrusted data', async () => {
  assert.equal(REQUEST_ID_RE.test('req_A-1'), true);
  assert.equal(REQUEST_ID_RE.test('x'.repeat(101)), false);
  const secretText = 'Authorization: Bearer abc.def password=top-secret api_key="k-9900" X-Hana-Test: ticket';
  const redacted = redactCredentials(secretText);
  assert.doesNotMatch(redacted, /abc\.def|top-secret|k-9900|ticket/);
  assert.match(redacted, /REDACTED/);
  assert.equal(sanitizeErrorCode(' provider:rate-limit_1 '), 'provider:rate-limit_1');
  assert.equal(sanitizeErrorCode('not safe code!'), 'INTERNAL_ERROR');
  assert.equal(sanitizeErrorMessage(' line\npassword=secret\t', 100), 'line password=[REDACTED]');

  const assistant = { content: [
    { type: 'reasoning', reasoning: '思考' },
    { type: 'text', text: '答' },
    { type: 'text', text: '案' },
    { type: 'toolCall', name: 'hidden' },
  ] };
  assert.equal(extractAssistantText(assistant), '答案');
  assert.equal(countAssistantReasoningChars(assistant), 2);
  const toolResult = { role: 'toolResult', toolCallId: 't1', content: 'opaque' };
  const messages = formatMessages([
    null,
    { role: 'assistant', content: assistant.content },
    toolResult,
    { text: 'question' },
  ]);
  assert.deepEqual(messages[0], { role: 'user', content: '' });
  assert.deepEqual(messages[1], { role: 'assistant', content: assistant.content });
  assert.equal(messages[2], toolResult, 'toolResult 必须保持宿主协议对象身份/字段');
  assert.deepEqual(messages[3], { role: 'user', content: 'question' });

  const logs = [];
  const logger = { info(message) { logs.push(message); return Promise.resolve(); } };
  logReceipt(logger, { requestId: 'req-1', cardId: 'card-1' });
  logStreamEnd(logger, {
    requestId: 'req-1', cardId: 'card-1', provider: 'openai', model: 'model', durationMs: 12,
    terminalStatus: 'error', eventCount: 2, eventTypes: { done: 1, 'text-delta': 1 },
    textChars: 3, reasoningChars: 2, sawDone: false, errorCode: 'password=secret',
  });
  await Promise.resolve();
  assert.equal(logs.length, 2);
  assert.match(logs[0], /requestId=req-1 cardId=card-1/);
  assert.doesNotMatch(logs[1], /secret/);
  assert.doesNotThrow(() => logReceipt({ info() { throw new Error('logger down'); } }, { requestId: 'x' }));
});

test('chat-ledger: release is object-identity safe and diagnostics maps remain the ledger-owned objects', () => {
  const ledger = createChatLedger();
  assert.ok(ledger.inFlightRequests instanceof Map);
  assert.ok(ledger.tombstones instanceof Map);
  const original = { requestId: 'same-id' };
  const replacement = { requestId: 'same-id' };
  assert.equal(ledger.reserve(original), true);
  assert.equal(ledger.reserve(replacement), false);
  assert.equal(ledger.get('same-id'), original);
  ledger.release('same-id', replacement);
  assert.equal(ledger.get('same-id'), original, '旧对象未完成时，替身不得清掉同 ID 请求');
  assert.equal(ledger.has('same-id'), true);
  ledger.release('same-id', original);
  assert.equal(ledger.has('same-id'), false);
  assert.equal(ledger.reserve(replacement), true);
  assert.equal(ledger.inFlightRequests.get('same-id'), replacement);
});

test('chat-ledger: tombstones are principal-scoped, expire by clock, and stay capacity bounded', () => {
  let now = 1000;
  const ledger = createChatLedger({ clock: { now: () => now }, tombstoneTtlMs: 50, tombstoneCapacity: 2 });
  const a = principal({ principalId: 'a', credentialId: 'ca' });
  const b = principal({ principalId: 'b', credentialId: 'cb' });
  const aOtherSurface = principal({ principalId: 'a', credentialId: 'ca-2' });
  ledger.recordTombstone(a, 'same');
  assert.equal(ledger.hasTombstone(a, 'same'), true);
  assert.equal(ledger.hasTombstone(aOtherSurface, 'same'), false);
  assert.equal(ledger.hasTombstone(principal({ appId: 'app-2', credentialId: 'ca' }), 'same'), false);

  ledger.recordTombstone(b, 'b-1');
  assert.equal(ledger.tombstones.size, 2);
  ledger.recordTombstone(a, 'a-2');
  assert.equal(ledger.tombstones.size, 2);
  assert.equal(ledger.hasTombstone(a, 'same'), false, '容量淘汰最老墓碑');
  assert.equal(ledger.hasTombstone(a, 'a-2'), true);
  now += 51;
  assert.equal(ledger.hasTombstone(a, 'a-2'), false, '过期墓碑必须被清理');
  assert.equal(ledger.tombstones.size, 0);

  ledger.recordTombstone(a, 'refresh');
  now += 20;
  ledger.recordTombstone(a, 'refresh');
  now += 31;
  assert.equal(ledger.hasTombstone(a, 'refresh'), true, '重复记录应刷新 TTL，而不是留下旧过期时间');
});

test('chat-model: model SDK receiver identity is preserved and missing stream capability fails closed', async () => {
  const calls = [];
  const models = {
    prefix: 'receiver:',
    streamEvents(input, options) { calls.push({ thisValue: this, input, options }); return this.prefix + input; },
    cancel(requestId) { calls.push({ thisValue: this, requestId }); return this.prefix + requestId; },
  };
  const port = createChatModelPort(models);
  assert.equal(port.streamEvents('payload', { signal: 'signal' }), 'receiver:payload');
  assert.equal(port.cancel('req-1'), 'receiver:req-1');
  assert.equal(calls[0].thisValue, models);
  assert.equal(calls[1].thisValue, models);
  assert.throws(() => createChatModelPort({}).streamEvents({}), error => error.code === 'MODELS_NOT_AVAILABLE');
});

test('chat-model: profile binding removes abort listeners on resolve and abort, and validates binding', async () => {
  const signal = new FakeSignal();
  const profile = await resolveChatBinding(
    { agentId: 'agent-1' },
    { signal, getAgentFullProfile: async id => ({ id, provider: ' openai ', model: ' gpt-x ', systemPrompt: '私有身份' }) },
  );
  assert.equal(signal.listeners.size, 0);
  assert.equal(profile.provider, 'openai');
  assert.equal(profile.model, 'gpt-x');
  assert.match(profile.systemPrompt, /私有身份/);
  assert.match(profile.systemPrompt, /完全沉浸/);

  const pending = deferred();
  const abortSignal = new FakeSignal();
  const binding = resolveChatBinding({ agentId: 'agent-2' }, {
    signal: abortSignal,
    getAgentFullProfile: () => pending.promise,
  });
  await Promise.resolve();
  assert.equal(abortSignal.listeners.size, 1);
  abortSignal.abort(new Error('cancel profile'));
  await assert.rejects(binding, /cancel profile/);
  assert.equal(abortSignal.listeners.size, 0);
  pending.resolve({ provider: 'late', model: 'late' });

  assert.deepEqual(await resolveChatBinding({ modelRef: ' provider / model ' }, {
    signal: new FakeSignal(), getAgentFullProfile: () => null,
  }), { provider: 'provider', model: 'model', systemPrompt: '你是专业、敏锐、逻辑严密的智能分析助手。回答要条理清晰、直击核心、不讲套话废话。' });
  await assert.rejects(resolveChatBinding({ modelRef: 'invalid' }, { signal: new FakeSignal() }), error => error.code === 'INVALID_MODEL_REF');
  await assert.rejects(resolveChatBinding({ agentId: 'bad' }, {
    signal: new FakeSignal(), getAgentFullProfile: async () => ({ provider: 'p', model: '' }),
  }), error => error.code === 'AGENT_MODEL_UNCONFIGURED');
});

test('chat-model: model getter is resolved at call time and each SDK method keeps its receiver', () => {
  let reads = 0;
  const first = { tag: 'first', streamEvents(input) { return `${this.tag}:${input}`; }, cancel(id) { return `${this.tag}:${id}`; } };
  const second = { tag: 'second', streamEvents(input) { return `${this.tag}:${input}`; }, cancel(id) { return `${this.tag}:${id}`; } };
  let current = first;
  const port = createChatModelPort(() => { reads++; return current; });
  assert.equal(reads, 0, '构造阶段不得读取晚绑定 models getter');
  assert.equal(port.streamEvents('a'), 'first:a');
  current = second;
  assert.equal(port.streamEvents('b'), 'second:b');
  assert.equal(port.cancel('c'), 'second:c');
  assert.equal(reads, 3);
});

test('chat-session: old completed object cannot release a replacement with the same requestId', () => {
  const ledger = createChatLedger();
  let finished = 0;
  const oldSession = createChatSession({
    requestId: 'reuse', principal: principal(), timeoutMs: 1000, startTime: 0,
    cancelModel: async () => {}, onFinish: session => { finished++; ledger.release(session.requestId, session); },
  });
  const replacement = { requestId: 'reuse' };
  ledger.reserve(oldSession);
  ledger.inFlightRequests.delete('reuse');
  ledger.reserve(replacement);
  oldSession.complete();
  assert.equal(finished, 1);
  assert.equal(ledger.get('reuse'), replacement);
});

test('chat-stream: synchronous abort inside streamEvents still releases the returned iterator exactly once', async () => {
  let iteratorReturns = 0;
  let cancelCalls = 0;
  let terminalCalls = 0;
  const session = createChatSession({
    requestId: 'sync-abort', principal: principal(), timeoutMs: 1000, startTime: 0,
    cancelModel: async () => { cancelCalls++; }, onFinish() {},
  });
  session.startMonitoring();
  const iterator = {
    next: async () => ({ done: true }),
    return: async () => { iteratorReturns++; return { done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
  const response = createChatResponse({
    requestId: 'sync-abort', binding: { provider: 'p', model: 'm', systemPrompt: 's' }, messages: [], session,
    models: { streamEvents() { session.triggerCancel('SYNC_CANCEL'); return iterator; } },
    onTerminal() { terminalCalls++; },
  });
  const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(frames.map(frame => frame.type), ['start', 'cancelled']);
  assert.equal(iteratorReturns, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(terminalCalls, 1);
});

test('chat-stream: abort wakes a permanently pending iterator.next before removing the pump listener', async () => {
  let nextCalls = 0;
  let iteratorReturns = 0;
  let terminalCalls = 0;
  let activeSession;
  const iterator = {
    next: () => { nextCalls++; return new Promise(() => {}); },
    return: async () => { iteratorReturns++; return { done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
  activeSession = createChatSession({
    requestId: 'hung-next', principal: principal(), timeoutMs: 1000, startTime: 0,
    cancelModel: async () => {}, onFinish() {},
  });
  activeSession.startMonitoring();
  const response = createChatResponse({
    requestId: 'hung-next', binding: { provider: 'p', model: 'm', systemPrompt: 's' }, messages: [], session: activeSession,
    models: { streamEvents() { return iterator; } }, onTerminal() { terminalCalls++; },
  });
  const reader = response.body.getReader();
  const start = await reader.read();
  assert.match(new TextDecoder().decode(start.value), /"type":"start"/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextCalls, 1);
  activeSession.triggerCancel('HANG_CANCEL');
  const terminalRead = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('iterator pump stayed hung')), 100)),
  ]);
  assert.match(new TextDecoder().decode(terminalRead.value), /"type":"cancelled"/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(iteratorReturns, 1);
  assert.equal(terminalCalls, 1);
});

test('chat-session: request abort, timeout, completion and cleanup own cancellation exactly once', async () => {
  const requestSignal = new FakeSignal();
  const cancelCalls = [];
  const finished = [];
  const session = createChatSession({
    requestId: 'req-session', principal: principal(), cardId: 'card-1', startTime: 0,
    timeoutMs: 10, requestSignal,
    cancelModel: async id => { cancelCalls.push(id); },
    onFinish: value => finished.push(value),
  });
  assert.equal(session.startMonitoring(), true);
  assert.equal(requestSignal.listeners.size, 1);
  requestSignal.abort(new Error('client gone'));
  session.triggerCancel('duplicate cancel');
  await Promise.resolve();
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0], 'req-session');
  assert.equal(session.hasCancelled, true);
  session.complete();
  session.complete();
  assert.equal(finished.length, 1);
  assert.equal(requestSignal.listeners.size, 0);

  let timedOut;
  const timeoutSession = createChatSession({
    requestId: 'req-timeout', principal: principal(), startTime: 0, timeoutMs: 1,
    cancelModel: async () => { timedOut = true; }, onFinish() {},
  });
  timeoutSession.startMonitoring();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(timeoutSession.isTimedOut, true);
  assert.equal(timedOut, true);
  timeoutSession.complete();
});

function localImports(text) {
  return [...text.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?['"](\.\/[^'"]+)['"]/g)].map(match => match[1]);
}

function hasCycle(graph, start) {
  const visiting = new Set(), visited = new Set();
  function visit(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) if (visit(next)) return true;
    visiting.delete(node); visited.add(node); return false;
  }
  return visit(start);
}

test('chat architecture: service delegates auth/protocol/ledger/model responsibilities instead of reimplementing them', async () => {
  const service = await readFile(path.join(LIB_DIR, 'chat.js'), 'utf8');
  const forbidden = [
    ['principal projection', /function\s+getPrincipalInfo\b|export\s+function\s+getPrincipalInfo\b/],
    ['protocol formatter', /function\s+formatMessages\b|export\s+function\s+formatMessages\b/],
    ['credential redaction', /function\s+redactCredentials\b|export\s+function\s+redactCredentials\b/],
    ['direct SDK stream call', /(?:sdk|models)\??\.models\??\.streamEvents\s*\(/],
    ['direct SDK cancel call', /(?:sdk|models)\??\.models\??\.cancel\s*\(/],
    ['direct NDJSON pump', /new\s+ReadableStream\s*\(/],
    ['direct in-flight map', /const\s+inFlightRequests\s*=\s*new\s+Map\s*\(/],
    ['direct tombstone map', /const\s+tombstones\s*=\s*new\s+Map\s*\(/],
  ];
  const violations = forbidden.filter(([, pattern]) => pattern.test(service)).map(([name]) => name);
  assert.deepEqual(violations, [], `chat.js 仍直接实现拆分职责：${violations.join(', ')}`);
  for (const module of ['./chat-auth.js', './chat-protocol.js', './chat-ledger.js', './chat-model.js']) {
    assert.match(service, new RegExp(`from\\s+['"]${module.replace('.', '\\.')}['"]`), `chat.js 未接入 ${module}`);
  }
});

test('chat architecture: chat module import graph has no static cycle', async () => {
  const files = (await readdir(LIB_DIR)).filter(file => /^chat.*\.js$/.test(file));
  const graph = new Map();
  for (const file of files) {
    const text = await readFile(path.join(LIB_DIR, file), 'utf8');
    graph.set(file, localImports(text).map(specifier => path.basename(specifier)));
  }
  for (const file of files) assert.equal(hasCycle(graph, file), false, `chat 模块依赖环从 ${file} 开始`);
});

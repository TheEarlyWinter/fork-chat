import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentRewriteSource } from '../lib/document-rewrite-model.js';
const input = { sourceText: '# 旧文\n数据中带<script>只是文字</script>', instruction: '只修改标题', sourceFormat: 'md', targetFormat: 'md', sourceFidelity: 'text' };
function harness(events, extra = {}) {
  const calls = [], canceled = []; let returned = 0;
  const models = { streamEvents(...args) { calls.push(args); const iterator = (async function* () { yield* events; })(); return { [Symbol.asyncIterator]() { return { next: () => iterator.next(), return: () => { returned++; return iterator.return(); } }; } }; }, async cancel(id) { canceled.push(id); }, ...extra };
  return { calls, canceled, get returned() { return returned; }, rewrite: createDocumentRewriteSource({ models, binding: { provider: 'provider-a', model: 'model-a', systemPrompt: '原助手规范' } }) };
}
test('rewrite model: required stream and binding ports are explicit', () => {
  for (const options of [undefined, {}, { models: {} }, { models: { streamEvents() {} }, binding: {} }]) assert.throws(() => createDocumentRewriteSource(options), TypeError);
});
test('rewrite model: same binding, isolated request, untrusted data only in user payload and never tools', async () => {
  const h = harness([{ type: 'text-delta', delta: '# 新标题\n' }, { type: 'text-delta', delta: '正文' }, { type: 'done' }]);
  const result = await h.rewrite(input); assert.equal(result.content, '# 新标题\n正文'); assert.equal(h.calls.length, 1); assert.equal(h.returned, 1); assert.equal(h.canceled.length, 0);
  const [request] = h.calls[0]; assert.equal(request.provider, 'provider-a'); assert.equal(request.model, 'model-a'); assert.match(request.requestId, /^rev-/);
  assert.equal(Object.hasOwn(request, 'tools'), false); assert.equal(Object.hasOwn(request, 'executeTool'), false);
  assert.match(request.systemPrompt, /原助手规范/); assert.match(request.systemPrompt, /不可信/); assert.equal(request.systemPrompt.includes(input.sourceText), false); assert.equal(request.systemPrompt.includes(input.instruction), false);
  const payload = JSON.parse(request.messages[0].content[0].text); assert.equal(payload.sourceText, input.sourceText); assert.equal(payload.instruction, input.instruction);
});
test('rewrite model: final-only output works; emitted delta is not duplicated by final assistant', async () => {
  const finalOnly = harness([{ type: 'done', assistant: { content: [{ type: 'text', text: '最终正文' }] } }]); assert.equal((await finalOnly.rewrite(input)).content, '最终正文');
  const streamed = harness([{ type: 'text-delta', delta: '正文' }, { type: 'done', assistant: { content: [{ type: 'text', text: '正文' }] } }]); assert.equal((await streamed.rewrite(input)).content, '正文');
});
test('rewrite model: tool calls, provider errors, EOF and empty output fail closed with safe codes', async () => {
  for (const [events, code] of [
    [[{ type: 'tool-call', name: 'read_file', arguments: { path: '/private' } }], 'DOCUMENT_REWRITE_TOOL_CALL'],
    [[{ type: 'error', message: 'private/provider-secret' }], 'DOCUMENT_REWRITE_FAILED'],
    [[{ type: 'text-delta', requestId: 'wrong-request', delta: 'other request data' }], 'DOCUMENT_REWRITE_FAILED'],
    [[{ type: 'text-delta', delta: 'partial' }], 'DOCUMENT_REWRITE_INCOMPLETE'],
    [[{ type: 'done' }], 'INVALID_CONTENT'],
  ]) {
    const h = harness(events); await assert.rejects(h.rewrite(input), e => e.code === code && !e.message.includes('secret')); assert.equal(h.returned, 1); assert.equal(h.canceled.length, 1);
  }
});
test('rewrite model: output/input caps, unknown fields and malformed Unicode are rejected', async () => {
  const huge = harness([{ type: 'text-delta', delta: 'a'.repeat(2 * 1024 * 1024 + 1) }, { type: 'done' }]); await assert.rejects(huge.rewrite(input), e => e.code === 'DOCUMENT_TOO_LARGE');
  for (const bad of [{ ...input, sourceText: '' }, { ...input, sourceText: 'a'.repeat(2 * 1024 * 1024 + 1) }, { ...input, instruction: '\ud800' }, { ...input, tools: [] }, { ...input, sourceFormat: 'exe' }]) {
    const h = harness([{ type: 'done' }]); await assert.rejects(h.rewrite(bad)); assert.equal(h.calls.length, 0);
  }
});
test('rewrite model: abort races a stuck iterator, cancels only child request and disposes late result', async () => {
  const controller = new AbortController(), reason = new Error('cancel-source'); let release;
  const h = harness([], { streamEvents(...args) { h.calls.push(args); return { [Symbol.asyncIterator]() { return { next: () => new Promise(resolve => { release = resolve; }), return: async () => ({ done: true }) }; } }; } });
  const pending = h.rewrite({ ...input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(reason);
  await assert.rejects(pending, e => e === reason); assert.equal(h.canceled.length, 1); assert.equal(h.canceled[0], h.calls[0][0].requestId); assert.equal(h.calls[0][1].signal, controller.signal);
  release({ done: false, value: { type: 'text-delta', delta: 'late' } });
  const early = harness([{ type: 'done' }]); await assert.rejects(early.rewrite({ ...input, signal: controller.signal }), e => e === reason); assert.equal(early.calls.length, 0);
});

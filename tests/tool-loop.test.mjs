import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../lib/tool-loop.js';

const TOOLS = [{ name: 'deliver_document', description: 'x', parameters: { type: 'object', properties: {} } }];

function fakeModels(rounds) {
  let calls = 0;
  return {
    get calls() { return calls; },
    streamEvents() {
      const round = rounds[calls] ?? rounds[rounds.length - 1];
      calls += 1;
      return (async function* () {
        for (const event of round) yield event;
      })();
    },
  };
}

async function collect(iterable) {
  const seen = [];
  for await (const event of iterable) seen.push(event);
  return seen;
}

test('without tool calls it passes events through and stops after one round', async () => {
  const models = fakeModels([[
    { type: 'text-delta', delta: '直接回答' },
    { type: 'done', stopReason: 'stop', assistant: { role: 'assistant', content: [{ type: 'text', text: '直接回答' }] } },
  ]]);
  const events = await collect(runToolLoop({
    models, input: { messages: [{ role: 'user', content: 'hi' }] }, tools: TOOLS,
    executeTool: async () => ({ delivered: true }), signal: new AbortController().signal,
  }));
  assert.deepEqual(events.map(e => e.type), ['text-delta', 'done']);
  assert.equal(models.calls, 1);
});

test('a tool call is executed, reported, and fed back for a second round', async () => {
  const models = fakeModels([
    [
      { type: 'text-delta', delta: '写好了' },
      { type: 'tool-call', id: 't1', name: 'deliver_document', arguments: { filename: 'a.md', content: 'x' } },
      { type: 'done', stopReason: 'toolUse', assistant: { role: 'assistant', content: [{ type: 'text', text: '写好了' }] } },
    ],
    [
      { type: 'text-delta', delta: '文件给你了' },
      { type: 'done', stopReason: 'stop', assistant: { role: 'assistant', content: [{ type: 'text', text: '文件给你了' }] } },
    ],
  ]);
  const executed = [];
  const events = await collect(runToolLoop({
    models, input: { messages: [{ role: 'user', content: '要个文件' }] }, tools: TOOLS,
    executeTool: async call => { executed.push(call); return { delivered: true, name: 'a.md', bytes: 1 }; },
    signal: new AbortController().signal,
  }));
  assert.deepEqual(events.map(e => `${e.type}${e.type === 'tool-result' ? ':' + e.ok : ''}`),
    ['text-delta', 'tool-call', 'tool-result:true', 'text-delta', 'done']);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'deliver_document');
  assert.equal(models.calls, 2);
});

test('a throwing tool is reported as isError and the loop continues', async () => {
  const models = fakeModels([
    [
      { type: 'tool-call', id: 't1', name: 'deliver_document', arguments: {} },
      { type: 'done', stopReason: 'toolUse', assistant: { role: 'assistant', content: [] } },
    ],
    [
      { type: 'text-delta', delta: '那你直接看正文吧' },
      { type: 'done', stopReason: 'stop', assistant: { role: 'assistant', content: [{ type: 'text', text: '那你直接看正文吧' }] } },
    ],
  ]);
  let captured = null;
  const events = await collect(runToolLoop({
    models, input: { messages: [{ role: 'user', content: '要文件' }] }, tools: TOOLS,
    executeTool: async () => {
      const error = new Error('文件太大');
      error.code = 'INVALID_CONTENT';
      throw error;
    },
    signal: new AbortController().signal,
    tools2: undefined,
  }));
  const result = events.find(e => e.type === 'tool-result');
  assert.equal(result.ok, false);
  assert.equal(result.result.code, 'INVALID_CONTENT');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(models.calls, 2);
  captured = result;
  assert.equal(captured.result.message, '文件太大');
});

test('exceeding maxRounds reports TOOL_LOOP_LIMIT instead of looping forever', async () => {
  const endless = () => ([
    { type: 'tool-call', id: 'x', name: 'deliver_document', arguments: {} },
    { type: 'done', stopReason: 'toolUse', assistant: { role: 'assistant', content: [] } },
  ]);
  const models = { streamEvents: () => (async function* () { yield* endless(); })() };
  const events = await collect(runToolLoop({
    models, input: { messages: [{ role: 'user', content: 'hi' }] }, tools: TOOLS,
    executeTool: async () => ({ ok: true }), signal: new AbortController().signal, maxRounds: 2,
  }));
  const last = events.at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.code, 'TOOL_LOOP_LIMIT');
});

test('an aborted signal stops the loop without emitting anything further', async () => {
  const controller = new AbortController();
  const models = {
    streamEvents() {
      return (async function* () {
        yield { type: 'text-delta', delta: 'a' };
        controller.abort();
        yield { type: 'text-delta', delta: 'b' };
      })();
    },
  };
  const events = await collect(runToolLoop({
    models, input: { messages: [{ role: 'user', content: 'hi' }] }, tools: TOOLS,
    executeTool: async () => ({}), signal: controller.signal,
  }));
  assert.ok(events.every(e => e.type !== 'done'));
  assert.equal(events.length, 1);
});

test('a missing iterator is reported instead of hanging', async () => {
  const models = { streamEvents: () => null };
  const events = await collect(runToolLoop({
    models, input: { messages: [] }, tools: TOOLS,
    executeTool: async () => ({}), signal: new AbortController().signal,
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'MODEL_STREAM_INVALID');
});

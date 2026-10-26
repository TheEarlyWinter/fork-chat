// Optional offline comparison against the actual paper-reader source checkout.
// No host entry, credentials, storage, or live model calls are used.
// node tests/helpers/reader-parity-probe.mjs /path/to/hana-paper-reader/app
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatService } from '../../lib/chat.js';
import { readAppModelStream } from '../../sdk/app-contract/model-stream.js';
if (!process.argv[2]) throw new Error('Supply the paper-reader App source directory.');
const { streamText } = await import(pathToFileURL(resolve(process.argv[2], 'server/domain/model-agent.js')));
const expected = { ordinary: 'ok', 'terminal-text-only': 'ok', 'wrong-identity': 'error', 'provider-error-after-text': 'error' };
function fakeModels(scenario) {
  let calls = 0;
  const models = {
    async stream(input) {
      calls++;
      const requestId = scenario === 'wrong-identity' ? 'wrong-request' : input.requestId;
      const events = [{ type: 'start', requestId }];
      if (scenario !== 'terminal-text-only') events.push({ type: 'text-delta', requestId, delta: 'canonical output' });
      events.push(scenario === 'provider-error-after-text'
        ? { type: 'error', requestId, code: 'APP_MODEL_PROVIDER_ERROR', message: 'The model provider could not complete the request.' }
        : { type: 'done', requestId, stopReason: 'stop', assistant: { role: 'assistant', content: [{ type: 'text', text: 'canonical output' }] } });
      return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    },
    async *streamEvents(input, options) { yield* readAppModelStream(await models.stream(input), options); },
    async cancel() {},
    get calls() { return calls; },
  };
  return models;
}
async function reader(scenario) {
  const models = fakeModels(scenario);
  try {
    const result = await streamText({ models, selection: { provider: 'openai-codex', id: 'gpt-5.6-luna' }, messages: [{ role: 'user', content: 'offline fixture' }], runtime: { modelTimeoutMs: 5000 } });
    return { status: 'ok', text: result.text, calls: models.calls };
  } catch (error) { return { status: 'error', code: error.code, calls: models.calls }; }
}
async function fork(scenario) {
  const models = fakeModels(scenario);
  const service = createChatService({ models }, { timeoutMs: 5000 });
  const body = { requestId: 'offline-parity', modelRef: 'openai-codex/gpt-5.6-luna', messages: [{ role: 'user', content: 'offline fixture' }] };
  const context = {
    get(key) { return key === 'appRequestContext' ? { appId: 'fork-chat', principal: { principalId: 'offline', credentialId: 'offline-surface' } } : undefined; },
    req: { async json() { return body; }, raw: {} },
    json(data, status = 200) { return Response.json(data, { status }); },
  };
  const response = await service.handleStream(context);
  const frames = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const terminal = frames.at(-1);
  return { status: terminal.type === 'done' ? 'ok' : 'error', code: terminal.code, calls: models.calls };
}
let failed = 0;
for (const [scenario, status] of Object.entries(expected)) {
  const reference = await reader(scenario), app = await fork(scenario);
  console.log(JSON.stringify({ scenario, reference, fork: app }));
  try {
    assert.equal(reference.status, status, 'reference result');
    assert.equal(app.status, status, 'fork result');
    assert.equal(reference.calls, 1);
    assert.equal(app.calls, 1);
  } catch (error) { failed++; console.error(`MISMATCH: ${scenario}: ${error.message}`); }
}
if (failed) process.exitCode = 1;
else console.log('PASS: both implementations agree on all four offline terminal scenarios; provider errors remain errors.');

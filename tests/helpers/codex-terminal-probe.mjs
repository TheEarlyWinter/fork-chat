// Optional, offline diagnostic for Hana 1.1.35. Never executes the server entry,
// requests inference, accesses credentials, or changes the installed host.
// Usage: node tests/helpers/codex-terminal-probe.mjs /path/to/hanako-server
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
if (!process.argv[2]) throw new Error('Supply the Hana 1.1.35 server directory.');
const server = resolve(process.argv[2]);
const { processResponsesStream } = await import(pathToFileURL(`${server}/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`));
const bundle = await readFile(`${server}/bundle/index.js`, 'utf8');
const start = bundle.indexOf('function yrr(t)');
const end = bundle.indexOf('function wrr(t)', start);
const helperStart = bundle.indexOf('function lE(t)');
const helperEnd = bundle.indexOf('const TLe =', helperStart);
assert.ok(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart, 'Unsupported host build: no matching pure terminal converter.');
const convert = vm.runInNewContext(`${bundle.slice(helperStart, helperEnd)}\n${bundle.slice(start, end)}\nyrr`);
async function replay(summary) {
  const reason = { type: 'reasoning', id: 'rs-offline', summary: summary ? [{ type: 'summary_text', text: summary }] : [], encrypted_content: 'opaque-offline-signature' };
  const message = { type: 'message', id: 'msg-offline', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'OFFLINE_OK' }] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: reason },
    { type: 'response.output_item.done', output_index: 0, item: reason },
    { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [] } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'OFFLINE_OK' },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: { status: 'completed', output: [reason, message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  const output = { role: 'assistant', content: [], stopReason: 'pending', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const pushed = [];
  async function* source() { yield* events; }
  await processResponsesStream(source(), output, { push(event) { pushed.push(event.type); } }, { id: 'offline', provider: 'openai-codex', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(output.stopReason, 'stop');
  assert.equal(output.content.find(item => item.type === 'text').text, 'OFFLINE_OK');
  return { output, canonical: convert(output), pushed };
}
const empty = await replay('');
assert.equal(empty.canonical, null);
assert.ok(empty.pushed.includes('text_delta'));
console.log('REPRODUCED: completed provider response with encrypted-only reasoning is rejected by the host terminal converter.');
const summary = await replay('Offline reasoning summary');
assert.equal(summary.canonical.role, 'assistant');
console.log('CONTROL: the same completed response with a visible reasoning summary is accepted.');
console.log('Offline reproduction only; this does not prove the live request had the same terminal content or that summary:auto always supplies a summary.');

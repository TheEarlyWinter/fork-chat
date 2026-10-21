import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatStream, runChat, ChatError } from '../ui/assets/chat-client.js';

const id = 'req-test';
const start = { type: 'start', requestId: id, provider: 'host', model: 'selected' };
const delta = text => ({ type: 'text-delta', requestId: id, delta: text });
const done = { type: 'done', requestId: id };
function response(events) {
  return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('NDJSON supports split UTF-8, split frames, CRLF and embedded newlines', async () => {
  const bytes = new TextEncoder().encode([start, delta('中文\n正文'), done].map(event => JSON.stringify(event)).join('\r\n'));
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset)); } });
  const result = await readChatStream(new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }), id);
  assert.equal(result.text, '中文\n正文');
});

test('partial text plus provider error is not successful content', async () => {
  let text = '';
  await assert.rejects(readChatStream(response([start, delta('partial'), { type: 'error', requestId: id, code: 'PROVIDER_ERROR', message: 'failed token=secret' }]), id, {
    onEvent(event) { if (event.type === 'text-delta') text += event.delta; },
  }), error => error.code === 'PROVIDER_ERROR' && !error.message.includes('secret'));
  assert.equal(text, 'partial');
});

for (const [name, events, code] of [
  ['EOF without terminal', [start, delta('partial')], 'STREAM_INCOMPLETE'],
  ['request mismatch', [start, { ...done, requestId: 'other' }], 'STREAM_REQUEST_MISMATCH'],
  ['delta before start', [delta('x'), done], 'STREAM_INVALID_ORDER'],
  ['duplicate terminal', [start, delta('x'), done, done], 'STREAM_INVALID_ORDER'],
  ['empty done', [start, done], 'EMPTY_RESPONSE'],
  ['cancelled', [start, { type: 'cancelled', requestId: id, code: 'REQUEST_CANCELLED', message: 'cancelled' }], 'REQUEST_CANCELLED'],
]) {
  test(name, async () => assert.rejects(readChatStream(response(events), id), error => error.code === code));
}

test('raw-text old snapshot response is rejected explicitly', async () => {
  await assert.rejects(readChatStream(new Response('old text'), id), error => error.code === 'STREAM_PROTOCOL_MISMATCH');
});

test('malformed NDJSON cancels the reader', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('not json\n')); }, cancel() { cancelled++; } });
  await assert.rejects(readChatStream(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }), id), error => error.code === 'STREAM_INVALID_JSON');
  assert.equal(cancelled, 1);
});

test('10-second notice equivalent is visible while fetch has no response', async () => {
  let notice = 0;
  const hana = { api: { fetch(path) {
    if (path.endsWith('/cancel')) return Promise.resolve(Response.json({ cancelled: true }));
    return new Promise(() => {});
  } } };
  await assert.rejects(runChat(hana, { requestId: id }, { waitingNoticeMs: 2, timeoutMs: 20, onWaiting() { notice++; } }), error => error.code === 'REQUEST_TIMEOUT');
  assert.equal(notice, 1);
});

test('abort stops a transport that ignores AbortSignal and sends only one cancellation', async () => {
  const calls = [];
  const hana = { api: { async fetch(path, init) {
    calls.push([path, init]);
    if (path.endsWith('/cancel')) return Response.json({ cancelled: true });
    return new Promise(() => {});
  } } };
  const controller = new AbortController();
  const pending = runChat(hana, { requestId: id }, { signal: controller.signal });
  controller.abort(new ChatError('REQUEST_CANCELLED', 'user'));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'REQUEST_CANCELLED');
  assert.equal(calls.filter(([path]) => path.endsWith('/cancel')).length, 1);
  assert.equal(calls[1][1].keepalive, true);
});

test('timeout terminates a stalled body even when the upstream ignores AbortSignal', async () => {
  let bodyCancelled = 0; const routes = [];
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(start) + '\n')); }, cancel() { bodyCancelled++; } });
  const hana = { api: { async fetch(route) {
    routes.push(route);
    return route.endsWith('/cancel') ? Response.json({ cancelled: true }) : new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
  } } };
  await assert.rejects(runChat(hana, { requestId: id }, { timeoutMs: 10 }), error => error.code === 'REQUEST_TIMEOUT');
  assert.equal(bodyCancelled, 1);
  assert.equal(routes.filter(route => route.endsWith('/cancel')).length, 1);
});

test('pre-aborted sends no stream or cancellation request', async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  await assert.rejects(runChat({ api: { async fetch() { called = true; } } }, { requestId: id }, { signal: controller.signal }), error => error.code === 'REQUEST_CANCELLED');
  assert.equal(called, false);
});

test('remote empty done never sends another cancel', async () => {
  const calls = [];
  const hana = { api: { async fetch(route) { calls.push(route); return response([start, done]); } } };
  await assert.rejects(runChat(hana, { requestId: id }), error => error.code === 'EMPTY_RESPONSE');
  assert.deepEqual(calls, ['api/chat/stream']);
});

test('remote done wins over abort in the terminal callback without an extra cancel', async () => {
  const calls = []; const controller = new AbortController();
  const hana = { api: { async fetch(route) { calls.push(route); return response([start, delta('ok'), done]); } } };
  const result = await runChat(hana, { requestId: id }, { signal: controller.signal, onEvent(event) { if (event.type === 'done') controller.abort(); } });
  assert.equal(result.text, 'ok');
  assert.deepEqual(calls, ['api/chat/stream']);
});

test('remote error wins over a simultaneous abort and is not cancelled again', async () => {
  const calls = []; const controller = new AbortController();
  const hana = { api: { async fetch(route) { calls.push(route); return response([start, { type: 'error', requestId: id, code: 'PROVIDER_ERROR', message: 'upstream' }]); } } };
  await assert.rejects(runChat(hana, { requestId: id }, { signal: controller.signal, onEvent(event) { if (event.type === 'error') controller.abort(); } }), error => error.code === 'PROVIDER_ERROR');
  assert.deepEqual(calls, ['api/chat/stream']);
});

test('cancel denial retains a safe diagnostic after local finalization', async () => {
  const controller = new AbortController(); let cancelResult;
  const hana = { api: { fetch(route) {
    return route.endsWith('/cancel') ? Promise.resolve(Response.json({ code: 'FORBIDDEN', error: 'token=private-secret' }, { status: 403 })) : new Promise(() => {});
  } } };
  const pending = runChat(hana, { requestId: id }, { signal: controller.signal, onCancelResult(confirmed, detail) { cancelResult = { confirmed, detail }; } });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'REQUEST_CANCELLED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelResult.confirmed, false);
  assert.match(cancelResult.detail, /FORBIDDEN/);
  assert.doesNotMatch(cancelResult.detail, /private-secret/);
});

test('preflight HTTP rejection keeps its status and makes no cancellation call', async () => {
  const routes = [];
  const hana = { api: { async fetch(route) { routes.push(route); return Response.json({ code: 'FORBIDDEN', error: 'denied' }, { status: 403 }); } } };
  await assert.rejects(runChat(hana, { requestId: id }), error => error.status === 403 && error.message.includes('FORBIDDEN'));
  assert.deepEqual(routes, ['api/chat/stream']);
});

test('pre-cancellation acknowledgement counts as accepted cancellation', async () => {
  const controller = new AbortController(); let confirmed;
  const hana = { api: { fetch(route) {
    return route.endsWith('/cancel') ? Promise.resolve(Response.json({ ok: true, cancelled: false, pending: true })) : new Promise(() => {});
  } } };
  const pending = runChat(hana, { requestId: id }, { signal: controller.signal, onCancelResult(value) { confirmed = value; } });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'REQUEST_CANCELLED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, true);
});

test('success clears timers, does not cancel remotely or show waiting notice', async () => {
  const calls = []; let waiting = 0;
  const hana = { api: { async fetch(path) { calls.push(path); return response([start, delta('ok'), done]); } } };
  assert.equal((await runChat(hana, { requestId: id }, { waitingNoticeMs: 10, timeoutMs: 20, onWaiting() { waiting++; } })).text, 'ok');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, ['api/chat/stream']);
  assert.equal(waiting, 0);
});

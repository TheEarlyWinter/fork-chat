import test from 'node:test';
import assert from 'node:assert/strict';
import { requestHost } from '../ui/assets/host-api.js';

test('uses only the authenticated SDK transport and preserves the request', async () => {
  const init = { method: 'POST', body: '{"messages":[]}' };
  const response = new Response('你好');
  const calls = [];
  const hana = { api: { fetch: async (...args) => { calls.push(args); return response; } } };
  assert.equal(await requestHost(hana, 'api/chat/stream', init), response);
  assert.deepEqual(calls, [['api/chat/stream', init]]);
});

test('fails closed when authenticated transport is unavailable', async () => {
  let bareFetchUsed = false;
  await assert.rejects(requestHost({ api: { url() { bareFetchUsed = true; } } }, 'api/agents'), /SDK/);
  assert.equal(bareFetchUsed, false);
});

test('403 exposes the host error code and message instead of only the status', async () => {
  const hana = { api: { fetch: async () => new Response(JSON.stringify({ code: 'APP_SURFACE_FORBIDDEN', error: 'Document binding required' }), { status: 403, headers: { 'Content-Type': 'application/json' } }) } };
  await assert.rejects(requestHost(hana, 'api/agents'), error => {
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /APP_SURFACE_FORBIDDEN/);
    assert.match(error.message, /Document binding required/);
    return true;
  });
});

test('never retries a denied POST and redacts surface credentials from errors', async () => {
  let calls = 0;
  const hana = { api: { fetch: async () => {
    calls++;
    return new Response('invalid appSurfaceSession=secret-session&appIframeTicket=secret-ticket X-Hana-Document-Binding: secret-binding Authorization: Bearer secret-bearer', { status: 403 });
  } } };
  await assert.rejects(requestHost(hana, 'api/chat/stream', { method: 'POST' }), error => {
    assert.doesNotMatch(error.message, /secret-/);
    return true;
  });
  assert.equal(calls, 1);
});

test('HTML error responses are not copied into chat', async () => {
  const hana = { api: { fetch: async () => new Response('<html><script>private</script></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }) } };
  await assert.rejects(requestHost(hana, 'api/agents'), error => {
    assert.match(error.message, /HTTP 502/);
    assert.doesNotMatch(error.message, /<html>|private/);
    return true;
  });
});

test('nested host errors preserve codes and redact quoted credentials', async () => {
  const hana = { api: { fetch: async () => Response.json({ error: { code: 'DENIED', message: 'invalid "appSurfaceSession":"private-session"' } }, { status: 403 }) } };
  await assert.rejects(requestHost(hana, 'api/agents'), error => {
    assert.match(error.message, /DENIED/);
    assert.doesNotMatch(error.message, /private-session/);
    return true;
  });
});

test('SDK fetch retains its receiver identity', async () => {
  const api = { async fetch() { assert.equal(this, api); return new Response('ok'); } };
  assert.equal(await (await requestHost({ api }, 'api/agents')).text(), 'ok');
});

test('transport failure propagates without a second request', async () => {
  const failure = new Error('Network unavailable');
  const hana = { api: { fetch: async () => { throw failure; } } };
  await assert.rejects(requestHost(hana, 'api/agents'), error => error === failure);
});

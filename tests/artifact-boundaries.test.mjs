import test from 'node:test';
import assert from 'node:assert/strict';
import { registerArtifactRoutes } from '../lib/artifact-http.js';
import { normalizeDocumentInput } from '../lib/document-spec.js';

for (const [label, body, expected] of [
  ['malformed JSON', '{', 400],
  ['stream exceeds byte budget without content-length', JSON.stringify({ artifactId: 'a'.repeat(5000) }), 413],
  ['array', '[]', 400],
  ['caller supplied owner', JSON.stringify({ artifactId: 'a'.repeat(32), owner: 'forged' }), 400],
]) test(`artifact boundary: ${label}`, async () => {
  const routes = new Map(); let calls = 0;
  registerArtifactRoutes({ post: (route, handler) => routes.set(route, handler), get: (route, handler) => routes.set(route, handler) }, { async exportFile() { calls++; return {}; } });
  const raw = new Request('http://app/api/artifacts/export', { method: 'POST', body });
  const response = await routes.get('/api/artifacts/export')({
    req: { raw, header: () => undefined },
    get: () => ({ appId: 'fork-chat', principal: { kind: 'app', principalId: 'synthetic' } }),
    json: (value, status = 200) => Response.json(value, { status }),
  });
  assert.equal(response.status, expected); assert.equal(calls, 0);
  assert.equal((await response.json()).ok, false);
});

test('artifact boundary: unauthenticated request is rejected before reading its body', async () => {
  const routes = new Map(); let read = 0;
  registerArtifactRoutes({ post: (route, handler) => routes.set(route, handler), get: (route, handler) => routes.set(route, handler) }, {});
  const response = await routes.get('/api/artifacts/preview')({ req: { async json() { read++; throw Error('must not run'); } },
    get: () => null, json: (value, status = 200) => Response.json(value, { status }) });
  assert.equal(response.status, 403); assert.equal(read, 0);
});

test('artifact boundary: reject XML-invalid controls and broken Unicode before encoding', () => {
  for (const format of ['md', 'html', 'docx', 'pdf']) {
    for (const content of ['bad\u0000xml', '\ud800']) assert.throws(() => normalizeDocumentInput({ filename: `sample.${format}`, content }));
  }
  for (const title of ['bad\u0001title', '\ud800']) assert.throws(() => normalizeDocumentInput({ filename: 'sample.docx', content: 'body', title }));
  assert.doesNotThrow(() => normalizeDocumentInput({ filename: 'sample.docx', content: 'tab\tline\nnewline\r\n中文 English 123' }));
});

test('artifact boundary: access-context returns scope fingerprint only, never raw identity', async () => {
  const routes = new Map();
  registerArtifactRoutes({ post: (r, h) => routes.set(r, h), get: (r, h) => routes.set(r, h) }, {});
  const principal = { kind: 'app', principalId: 'stable-id' };
  const response = await routes.get('/api/artifacts/access-context')({
    get: key => key === 'appRequestContext' ? { appId: 'fork-chat', principal } : undefined,
    json: (value, status = 200) => Response.json(value, { status }),
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.ownerScheme, 'principal-v1');
  assert.match(body.ownerScopeKey, /^[0-9a-f]{64}$/);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('stable-id'), '指纹响应不得包含身份原文');
});

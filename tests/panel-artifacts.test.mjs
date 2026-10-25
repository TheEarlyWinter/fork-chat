import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactActions } from '../ui/assets/panel-artifacts.js';
import { artifactFilesHtml } from '../ui/assets/panel-artifact-markup.js';

const ARTIFACT_ID = 'a'.repeat(32);
const ARTIFACT = {
  artifactId: ARTIFACT_ID,
  name: '报告.md',
  mime: 'text/markdown',
  format: 'md',
  bytes: 24,
  sha256: 'b'.repeat(64),
  createdAt: '2026-10-24T00:00:00.000Z',
  cardId: 'card-root',
  requestId: 'request-1',
  preview: '# 报告',
  status: 'ready',
  origin: 'generated',
};

function response(payload) {
  return { json: async () => payload };
}

function makeHarness(overrides = {}) {
  const hostCalls = [];
  const saveCalls = [];
  const messages = [];
  const hana = {
    resources: {
      async saveFile(input) {
        saveCalls.push(input);
        return { kind: 'saved' };
      },
    },
  };
  const deps = {
    hana,
    requestHost: async (...args) => {
      hostCalls.push(args);
      return response({ ok: true, artifact: ARTIFACT, contentBase64: 'Z2VuZXJhdGVk', html: '<p>预览</p>' });
    },
    flashMessage: message => messages.push(String(message)),
    isActive: () => true,
    showPreview: () => {},
    ...overrides,
  };
  return {
    hana,
    hostCalls,
    saveCalls,
    messages,
    actions: createArtifactActions(deps),
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

test('panel-artifacts: save uses authenticated export route and saves only after a valid host receipt', async () => {
  const harness = makeHarness();
  const result = await harness.actions.save(ARTIFACT_ID);

  assert.equal(result.kind, 'saved');
  assert.equal(harness.hostCalls.length, 1);
  const [hana, route, init] = harness.hostCalls[0];
  assert.equal(hana, harness.hana);
  assert.equal(route, '/api/artifacts/export');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { artifactId: ARTIFACT_ID });
  assert.deepEqual(harness.saveCalls, [{
    suggestedName: ARTIFACT.name,
    mimeType: ARTIFACT.mime,
    contentBase64: 'Z2VuZXJhdGVk',
  }]);
  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0], /已保存/);
});

test('panel-artifacts: save status messages distinguish saved, download-started, canceled, and conflict', async () => {
  for (const [kind, expected, forbidden] of [
    ['saved', /已保存/, /已发起下载|冲突/],
    ['download-started', /已发起下载/, /已保存|冲突/],
    ['canceled', null, /已保存|已发起下载|冲突/],
    ['conflict', /冲突/, /已保存|已发起下载/],
  ]) {
    const messages = [];
    const harness = makeHarness({
      hana: { resources: { saveFile: async () => ({ kind }) } },
      flashMessage: message => messages.push(String(message)),
    });
    await harness.actions.save(ARTIFACT_ID);
    assert.equal(messages.length, kind === 'canceled' ? 0 : 1, `${kind} must not be misreported`);
    if (expected) assert.match(messages[0], expected);
    if (forbidden) for (const message of messages) assert.doesNotMatch(message, forbidden);
  }
});

test('panel-artifacts: unsupported host and malformed/error receipts are explicit user-visible failures', async () => {
  const unsupported = makeHarness({ hana: { resources: {} } });
  await unsupported.actions.save(ARTIFACT_ID);
  assert.equal(unsupported.hostCalls.length, 0, 'unsupported save must fail before any unauthenticated fallback');
  assert.match(unsupported.messages[0], /不支持|失败/);

  const malformed = makeHarness({
    requestHost: async (...args) => {
      args[0];
      return response({ ok: true, artifact: { ...ARTIFACT, artifactId: 'c'.repeat(32) }, contentBase64: 'Z2VuZXJhdGVk' });
    },
  });
  await malformed.actions.save(ARTIFACT_ID);
  assert.equal(malformed.saveCalls.length, 0);
  assert.match(malformed.messages[0], /失败|回执/);

  const failedRequest = makeHarness({
    requestHost: async () => { throw new Error('host denied'); },
  });
  await failedRequest.actions.save(ARTIFACT_ID);
  assert.equal(failedRequest.saveCalls.length, 0);
  assert.match(failedRequest.messages[0], /host denied|失败/);

  const failedSave = makeHarness({
    hana: { resources: { saveFile: async () => { throw new Error('save denied'); } } },
  });
  await failedSave.actions.save(ARTIFACT_ID);
  assert.match(failedSave.messages[0], /save denied|失败/);
});

test('panel-artifacts: duplicate clicks for one artifact are mutually exclusive, and the lock releases in finally', async () => {
  let releaseResponse;
  const responsePending = new Promise(resolve => { releaseResponse = resolve; });
  const harness = makeHarness({
    requestHost: async (...args) => {
      harness.hostCalls.push(args);
      return responsePending;
    },
  });

  const first = harness.actions.save(ARTIFACT_ID);
  await waitUntil(() => harness.hostCalls.length === 1, 'first save should reach the host');
  const duplicate = harness.actions.save(ARTIFACT_ID);
  assert.equal(harness.hostCalls.length, 1, 'duplicate click must not issue a second host request');
  assert.equal(await duplicate, undefined, 'duplicate click should be ignored while the same artifact is busy');

  releaseResponse(response({ ok: true, artifact: ARTIFACT, contentBase64: 'Z2VuZXJhdGVk' }));
  await first;
  assert.equal(harness.saveCalls.length, 1);

  await harness.actions.save(ARTIFACT_ID);
  assert.equal(harness.hostCalls.length, 2, 'finally must release the per-artifact lock');
  assert.equal(harness.saveCalls.length, 2);
});

test('panel-artifacts: isActive is checked after async boundaries so a switched canvas cannot save or flash stale success', async () => {
  let active = true;
  let releaseResponse;
  const responsePending = new Promise(resolve => { releaseResponse = resolve; });
  const harness = makeHarness({
    isActive: () => active,
    requestHost: async () => responsePending,
  });

  const pending = harness.actions.save(ARTIFACT_ID);
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  releaseResponse(response({ ok: true, artifact: ARTIFACT, contentBase64: 'Z2VuZXJhdGVk' }));
  await pending;

  assert.equal(harness.saveCalls.length, 0, 'a stale save must not hand bytes to the new session');
  assert.deepEqual(harness.messages, []);
});

test('panel-artifacts: preview uses the preview route, passes HTML and metadata to showPreview, and never calls saveFile', async () => {
  const previews = [];
  const harness = makeHarness({ showPreview: (...args) => previews.push(args) });
  const result = await harness.actions.preview(ARTIFACT_ID);

  assert.equal(result.kind, 'previewed');
  assert.equal(harness.hostCalls.length, 1);
  const [, route, init] = harness.hostCalls[0];
  assert.equal(route, '/api/artifacts/preview');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { artifactId: ARTIFACT_ID });
  assert.deepEqual(previews, [['<p>预览</p>', ARTIFACT]]);
  assert.equal(harness.saveCalls.length, 0);
  assert.deepEqual(harness.messages, []);
});

test('panel-artifacts: preview errors are visible and stale preview results cannot reach the next session', async () => {
  const failed = makeHarness({ requestHost: async () => { throw new Error('preview denied'); } });
  await failed.actions.preview(ARTIFACT_ID);
  assert.match(failed.messages[0], /preview denied|失败/);

  let active = true;
  let releaseResponse;
  const pendingResponse = new Promise(resolve => { releaseResponse = resolve; });
  const previews = [];
  const stale = makeHarness({
    isActive: () => active,
    requestHost: async () => pendingResponse,
    showPreview: (...args) => previews.push(args),
  });
  const pending = stale.actions.preview(ARTIFACT_ID);
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  releaseResponse(response({ ok: true, artifact: ARTIFACT, html: '<p>旧会话</p>' }));
  await pending;
  assert.deepEqual(previews, []);
  assert.deepEqual(stale.messages, []);
});

test('panel-artifacts: the file card renders escaped metadata with explicit preview and save controls', () => {
  const html = artifactFilesHtml({ artifacts: [{ ...ARTIFACT, name: '<script>-bad.md' }] });
  assert.match(html, /artifact-file-card/);
  assert.match(html, /data-artifact-action="preview"/);
  assert.match(html, /data-artifact-action="save"/);
  assert.match(html, new RegExp(`data-artifact-id="${ARTIFACT_ID}"`));
  assert.match(html, /&lt;script&gt;-bad\.md/);
  assert.doesNotMatch(html, /<script\b/i);
});

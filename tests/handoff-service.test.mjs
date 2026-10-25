import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import realFs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { createHandoffStore } from '../lib/handoff-store.js';
import { createHandoffService } from '../lib/handoff-service.js';

// ---------------------------------------------------------------------------
// 夹具：valid context、canonical owner、fake host/artifacts/sdk、route harness
//
// 注意：本文件是 C0 阶段为尚不存在的 service 写的 RED 测试。
// 当前运行会因 lib/handoff-service.js 缺失而整体失败，不能声称每条行为都已独立 RED。
// ---------------------------------------------------------------------------

const PRINCIPAL = 'user-1';
const OWNER = JSON.stringify(['timeline-reverser', 'authenticated', PRINCIPAL]);

function msg(role, text) {
  return { role, text };
}

function card(id, { parents = [], messages = [] } = {}) {
  const built = { id, x: 0, y: 0, width: 320, draft: '', messages };
  if (parents.length === 1) built.parentId = parents[0];
  else if (parents.length > 1) built.parentIds = [...parents];
  return built;
}

function handoffContext({ artifactIds = [], agentId = 'agent-a' } = {}) {
  const context = buildHandoffContext({
    snapshot: {
      cards: [card('card-1', { messages: [msg('user', '交接内容')] })],
      view: { x: 0, y: 0, scale: 1 },
      agent: { id: agentId, name: '助手' },
    },
    source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' },
    targetCardId: 'card-1',
    agentId,
    nextStep: '继续处理',
  });
  if (artifactIds.length) {
    context.nodes[0].messages[0].artifactIds = [...artifactIds];
    context.artifactIds = [...artifactIds];
    context.stats.artifactCount = artifactIds.length;
  }
  return context;
}

function artifactFixture(artifactId, content = 'artifact-body') {
  const bytes = Buffer.from(content, 'utf8');
  return {
    bytes,
    metadata: {
      artifactId,
      name: '报告.md',
      format: 'md',
      mime: 'text/markdown',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'ready',
    },
  };
}

function fakeArtifacts(entries = {}) {
  const calls = [];
  return {
    calls,
    async read({ owner, artifactId }) {
      calls.push({ owner, artifactId });
      const entry = entries[artifactId];
      if (!entry) {
        const error = new Error('文件不存在');
        error.code = 'ARTIFACT_NOT_FOUND';
        throw error;
      }
      return entry;
    },
  };
}

function fakeHost(overrides = {}) {
  const calls = [];
  let files = 0;
  const host = {
    calls,
    async capabilities() {
      return {
        supported: true,
        available: true,
        home: true,
        read: true,
        manage: true,
        stageFile: true,
        agentsRead: true,
        missing: [],
        reason: null,
      };
    },
    async create(input) {
      calls.push(['create', input]);
      return { sessionId: 'sess-1' };
    },
    async isIdle() {
      calls.push(['isIdle']);
      return true;
    },
    async stage(input) {
      calls.push(['stage', input]);
      files += 1;
      return { fileId: `file-${files}`, name: input.name, mime: input.mime };
    },
    async writeContext(input) {
      calls.push(['writeContext', input]);
      return { entryId: 'entry-1' };
    },
  };
  return Object.assign(host, overrides);
}

function fakeSdk(agentIds = ['agent-a']) {
  return {
    agents: {
      async list() {
        return { agents: agentIds.map(id => ({ id, lifecycle: 'active' })) };
      },
    },
  };
}

function requestContext({ principalId = PRINCIPAL, appId = 'timeline-reverser' } = {}) {
  return {
    appId,
    principal: { principalId, kind: 'authenticated' },
  };
}

function makeHarness({ host = fakeHost(), artifacts = fakeArtifacts(), sdk = fakeSdk(), dataDir, store, principalId = PRINCIPAL } = {}) {
  const routes = [];
  const app = {
    get(pattern, handler) { routes.push({ method: 'GET', pattern, handler }); },
    post(pattern, handler) { routes.push({ method: 'POST', pattern, handler }); },
  };
  const service = createHandoffService({ sdk, dataDir, artifacts, host, store });
  service.register(app);

  async function call(method, url, { body, principal = principalId, appId = 'timeline-reverser' } = {}) {
    const parsed = new URL(`http://local${url}`);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const route = routes.find(candidate => {
      if (candidate.method !== method) return false;
      const expected = candidate.pattern.split('/').filter(Boolean);
      return expected.length === parts.length
        && expected.every((piece, index) => piece.startsWith(':') || piece === parts[index]);
    });
    assert.ok(route, `没有注册 ${method} ${url}`);
    const params = {};
    const expectedParts = route.pattern.split('/').filter(Boolean);
    expectedParts.forEach((piece, index) => {
      if (piece.startsWith(':')) params[piece.slice(1)] = decodeURIComponent(parts[index]);
    });

    const raw = new Request(parsed, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const c = {
      req: {
        raw,
        json: async () => body,
        param: name => params[name],
        query: name => parsed.searchParams.get(name),
      },
      get: key => (key === 'appRequestContext' ? requestContext({ principalId: principal, appId }) : undefined),
      json: (value, status = 200) => ({ status, body: value }),
    };
    return route.handler(c);
  }

  return { call, service, routes };
}

async function makeDir() {
  return realFs.mkdtemp(path.join(os.tmpdir(), 'handoff-service-'));
}

async function prepareViaRoute(harness, context) {
  return harness.call('POST', '/api/handoff/prepare', { body: context });
}

function actionOf(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);
  return response.body.action;
}

// ---------------------------------------------------------------------------
// 能力与准备
// ---------------------------------------------------------------------------

test('capabilities exposes host caps and protocol limits without touching the store', async () => {
  const dataDir = await makeDir();
  const artifacts = fakeArtifacts();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const harness = makeHarness({ dataDir, store, artifacts });

  const response = await harness.call('GET', '/api/handoff/capabilities');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.home, true);
  assert.equal(response.body.agentsRead, true);
  assert.equal(response.body.limits.maxArtifacts, 16);
  assert.equal(artifacts.calls.length, 0);
  assert.deepEqual(await store.list({ owner: OWNER }), []);
});

test('prepare stores a private action without any host write and reads artifacts with the canonical owner', async () => {
  const dataDir = await makeDir();
  const artifactId = 'a'.repeat(32);
  const entry = artifactFixture(artifactId);
  const artifacts = fakeArtifacts({ [artifactId]: entry });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, artifacts, host });

  const response = await prepareViaRoute(harness, handoffContext({ artifactIds: [artifactId] }));
  const action = actionOf(response);
  assert.equal(action.state, 'prepared');
  assert.equal(action.agentId, 'agent-a');
  assert.equal(action.artifactCount, 1);
  assert.equal(host.calls.length, 0);
  assert.deepEqual(artifacts.calls, [{ owner: OWNER, artifactId }]);

  const stored = await store.get({ owner: OWNER, actionId: action.actionId });
  assert.ok(stored.context);
  assert.deepEqual(stored.artifactMetadata.map(item => item.artifactId), [artifactId]);
});

test('prepare rejects a different principal and never exposes another owner action', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const harness = makeHarness({ dataDir, store });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const foreign = await harness.call('GET', `/api/handoff/actions/${prepared.actionId}`, { principal: 'user-2' });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.ok, false);
  assert.equal(JSON.stringify(foreign.body).includes('交接内容'), false);

  const foreignList = await harness.call('GET', '/api/handoff/actions', { principal: 'user-2' });
  assert.equal(foreignList.body.ok, true);
  assert.deepEqual(foreignList.body.actions, []);
});

test('prepare verifies the agent against the host and rejects an inactive target before store or host writes', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, sdk: fakeSdk(['agent-b']) });

  const response = await prepareViaRoute(harness, handoffContext());
  assert.equal(response.body.ok, false);
  assert.equal(response.status >= 400, true);
  assert.deepEqual(await store.list({ owner: OWNER }), []);
  assert.equal(host.calls.length, 0);
});

test('prepare rejects artifact bytes that do not match the stored digest or exceed the single/aggregate limits', async () => {
  const dataDir = await makeDir();
  const tamperedId = 'a'.repeat(32);
  const tampered = artifactFixture(tamperedId, 'real-body');
  tampered.metadata.sha256 = 'c'.repeat(64);
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const harness = makeHarness({ dataDir, store, artifacts: fakeArtifacts({ [tamperedId]: tampered }) });

  const response = await prepareViaRoute(harness, handoffContext({ artifactIds: [tamperedId] }));
  assert.equal(response.body.ok, false);
  assert.deepEqual(await store.list({ owner: OWNER }), []);

  const oversizedId = 'b'.repeat(32);
  const oversized = artifactFixture(oversizedId);
  oversized.metadata.bytes = 16 * 1024 * 1024 + 1;
  const oversizedStore = createHandoffStore({ dataDir: await makeDir(), fs: realFs, clock: () => 1 });
  const oversizedHarness = makeHarness({
    dataDir: await makeDir(),
    store: oversizedStore,
    artifacts: fakeArtifacts({ [oversizedId]: oversized }),
  });
  const oversizedResponse = await prepareViaRoute(oversizedHarness, handoffContext({ artifactIds: [oversizedId] }));
  assert.equal(oversizedResponse.body.ok, false);
});

// ---------------------------------------------------------------------------
// 确认：只认 actionId、claim 先行、顺序与回执
// ---------------------------------------------------------------------------

test('confirm accepts only actionId; extra body fields cannot replace the stored context or agent', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ agentId: 'agent-a' })));
  const response = await harness.call('POST', '/api/handoff/confirm', {
    body: {
      actionId: prepared.actionId,
      agentId: 'agent-b',
      sessionId: 'attacker-session',
      context: handoffContext({ agentId: 'agent-b' }),
    },
  });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.agentId, 'agent-a');
  const create = host.calls.find(call => call[0] === 'create');
  assert.deepEqual(create[1], { agentId: 'agent-a' });
});

test('confirm never creates a host session when the store claim is lost', async () => {
  const dataDir = await makeDir();
  const realStore = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const store = { ...realStore, claim: async () => ({ claimed: false, record: null }) };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(response.body.ok, false);
  assert.equal(host.calls.some(call => call[0] === 'create'), false);
});

test('confirm creates, stages each artifact and the archive, then writes exactly one notify-only custom entry', async () => {
  const dataDir = await makeDir();
  const artifactId = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [artifactId]: artifactFixture(artifactId) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, artifacts });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [artifactId] })));
  const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.state, 'ready');
  assert.equal(response.body.action.sessionId, 'sess-1');

  const order = host.calls.map(call => call[0]);
  assert.deepEqual(order.filter(kind => kind !== 'isIdle'), ['create', 'stage', 'stage', 'writeContext']);
  const stages = host.calls.filter(call => call[0] === 'stage').map(call => call[1]);
  assert.equal(stages.length, 2);
  assert.ok(stages[1].name.endsWith('.md'));
  const writes = host.calls.filter(call => call[0] === 'writeContext');
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].details === undefined || typeof writes[0][1].details === 'object', true);
  assert.deepEqual(host.calls.filter(call => call[0] === 'create')[0][1], { agentId: 'agent-a' });

  // 确认后的 action 只保留宿主回执里的文件标识，不夹带私有路径或正文
  const files = response.body.action.files;
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.equal(Object.hasOwn(file, 'fileId'), true);
    assert.equal(Object.hasOwn(file, 'path'), false);
  }
});

test('a failing stage keeps the known session and earlier files, and a repeated confirm does not replay', async () => {
  const dataDir = await makeDir();
  const artifactId = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [artifactId]: artifactFixture(artifactId) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let stageCalls = 0;
  const host = fakeHost({
    async stage(input) {
      stageCalls += 1;
      host.calls.push(['stage', input]);
      if (stageCalls === 2) {
        const error = new Error('stage failed');
        error.code = 'HANDOFF_STAGE_FAILED';
        throw error;
      }
      return { fileId: 'file-1', name: input.name, mime: input.mime };
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [artifactId] })));
  const first = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(first.body.ok, true);
  assert.ok(['failed', 'partial', 'unknown'].includes(first.body.action.state));
  assert.equal(first.body.action.sessionId, 'sess-1');
  assert.equal(first.body.action.files.length, 1);
  assert.equal(first.body.action.errorCode?.startsWith('HANDOFF_'), true);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);

  const createCallsBefore = host.calls.filter(call => call[0] === 'create').length;
  const second = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(second.body.ok, false);
  assert.equal(host.calls.filter(call => call[0] === 'create').length, createCallsBefore);
});

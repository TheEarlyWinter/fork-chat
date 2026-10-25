import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import realFs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { HANDOFF_LIMITS, validateHandoffContext } from '../ui/assets/fork-handoff-contract.js';
import { createHandoffStore } from '../lib/handoff-store.js';
import { createHandoffDelivery } from '../lib/handoff-delivery.js';
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
      createdAt: '2026-10-25T00:00:00.000Z',
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
  const calls = [];
  return {
    calls,
    agents: {
      async list(input) {
        calls.push(input);
        return { agents: agentIds.map(id => ({ id, state: 'active', lifecycle: 'active' })) };
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

function makeHarness({ host = fakeHost(), artifacts = fakeArtifacts(), sdk = fakeSdk(), dataDir, store, delivery, principalId = PRINCIPAL } = {}) {
  const routes = [];
  const app = {
    get(pattern, handler) { routes.push({ method: 'GET', pattern, handler }); },
    post(pattern, handler) { routes.push({ method: 'POST', pattern, handler }); },
  };
  const service = createHandoffService({ sdk, dataDir, artifacts, host, store, delivery });
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

test('prepare verifies the agent against the host with all/active scope and rejects an inactive target', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const sdk = fakeSdk(['agent-b']);
  const harness = makeHarness({ dataDir, store, host, sdk });

  const response = await prepareViaRoute(harness, handoffContext());
  assert.equal(response.body.ok, false);
  assert.equal(response.status >= 400, true);
  assert.deepEqual(await store.list({ owner: OWNER }), []);
  assert.equal(host.calls.length, 0);
  assert.deepEqual(sdk.calls, [{ scope: 'all', lifecycle: 'active' }]);

  const retiredHarness = makeHarness({ dataDir, store, host, sdk: {
    agents: { async list() { return { agents: [{ id: 'agent-a', state: 'retired' }] }; } },
  } });
  const retired = await prepareViaRoute(retiredHarness, handoffContext());
  assert.equal(retired.body.ok, false);
  assert.deepEqual(await store.list({ owner: OWNER }), []);
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

test('confirm rejects any body field besides actionId', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const response = await harness.call('POST', '/api/handoff/confirm', {
    body: { actionId: prepared.actionId, agentId: 'agent-b' },
  });
  assert.equal(response.body.ok, false);
  assert.equal(response.status, 400);
  assert.equal(host.calls.length, 0);
  assert.equal((await store.get({ owner: OWNER, actionId: prepared.actionId })).action.state, 'prepared');
});

test('confirm never creates a host session when the store claim is lost', async () => {
  const dataDir = await makeDir();
  const realStore = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const store = { ...realStore, claim: async () => ({ claimed: false, record: null }) };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.state, 'prepared');
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
  // stage 调用已发出且无可信回执：未知，不是明确 failed/partial
  assert.equal(first.body.action.state, 'unknown');
  assert.equal(first.body.action.sessionId, 'sess-1');
  assert.equal(first.body.action.files.length, 1);
  assert.equal(first.body.action.errorCode?.startsWith('HANDOFF_'), true);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);

  const createCallsBefore = host.calls.filter(call => call[0] === 'create').length;
  const second = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(second.body.ok, true);
  assert.equal(second.body.action.state, first.body.action.state);
  assert.equal(host.calls.filter(call => call[0] === 'create').length, createCallsBefore);
});

// ---------------------------------------------------------------------------
// C 补充：流式上限、失败矩阵、并发、生命周期与脱敏
// ---------------------------------------------------------------------------

test('prepare rejects an oversized streaming body before touching the store', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });
  const body = { ...handoffContext(), nextStep: 'x'.repeat(4 * 1024 * 1024) };

  const response = await harness.call('POST', '/api/handoff/prepare', { body });
  assert.equal(response.status, 413);
  assert.equal(response.body.ok, false);
  assert.deepEqual(await store.list({ owner: OWNER }), []);
  assert.equal(host.calls.length, 0);
});

test('create without a trusted session becomes unknown and never leaks the host error', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost({
    async create() {
      const error = new Error('SECRET_CREATE /private/path');
      error.code = 'HANDOFF_HOST_ERROR';
      throw error;
    },
  });
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.state, 'unknown');
  assert.equal(response.body.action.sessionId, null);
  assert.equal(JSON.stringify(response.body).includes('SECRET_CREATE'), false);
  assert.equal(host.calls.some(call => call[0] === 'stage'), false);
});

test('create with a known session is preserved as partial and not retried', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let creates = 0;
  const host = fakeHost({
    async create() {
      creates += 1;
      const error = new Error('invalid receipt');
      error.code = 'HANDOFF_INVALID_SESSION';
      error.sessionId = 'sess-known';
      throw error;
    },
  });
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const first = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(first.body.action.state, 'partial');
  assert.equal(first.body.action.sessionId, 'sess-known');
  const second = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(second.body.ok, true);
  assert.equal(creates, 1);
});

test('archive and custom failures keep known receipts and stop later host writes', async () => {
  const artifactId = 'a'.repeat(32);
  for (const mode of ['archive', 'custom']) {
    const dataDir = await makeDir();
    const artifacts = fakeArtifacts({ [artifactId]: artifactFixture(artifactId) });
    const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
    let stageCalls = 0;
    const host = fakeHost({
      async stage(input) {
        stageCalls += 1;
        host.calls.push(['stage', input]);
        if (mode === 'archive' && stageCalls === 2) {
          const error = new Error('archive failed');
          error.code = 'HANDOFF_STAGE_FAILED';
          throw error;
        }
        return { fileId: `file-${stageCalls}`, name: input.name, mime: input.mime };
      },
      async writeContext(input) {
        host.calls.push(['writeContext', input]);
        if (mode === 'custom') {
          const error = new Error('custom failed');
          error.code = 'HANDOFF_CUSTOM_FAILED';
          throw error;
        }
        return { entryId: 'entry-1' };
      },
    });
    const harness = makeHarness({ dataDir, store, host, artifacts });

    const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [artifactId] })));
    const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
    assert.equal(response.body.ok, true);
    // 已调用 stage 但无可信回执：只能是未知，不能假定明确失败
    assert.equal(response.body.action.state, 'unknown', mode);
    assert.equal(response.body.action.sessionId, 'sess-1', mode);
    assert.equal(response.body.action.files.length, mode === 'archive' ? 1 : 2, mode);
    if (mode === 'archive') assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
    else assert.equal(host.calls.filter(call => call[0] === 'writeContext').length, 1);
    if (mode === 'archive') {
      const ownerHash = createHash('sha256').update(OWNER).digest('hex');
      const archivePath = path.join(dataDir, 'handoff-delivery', ownerHash, prepared.actionId, 'context.md');
      assert.equal((await realFs.lstat(archivePath)).isFile(), true, '未确认的归档副本应保留');
    }
  }
});

test('a checkpoint failure after the first stage stops further host calls', async () => {
  const dataDir = await makeDir();
  const realStore = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let checkpoints = 0;
  const store = {
    ...realStore,
    async checkpoint(input) {
      checkpoints += 1;
      if (checkpoints === 2) throw new Error('checkpoint failed');
      return realStore.checkpoint(input);
    },
  };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(response.body.ok, true);
  assert.equal(host.calls.filter(call => call[0] === 'stage').length, 1);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
  assert.equal(response.body.action.sessionId, 'sess-1');
  const ownerHash = createHash('sha256').update(OWNER).digest('hex');
  const deliveryDir = path.join(dataDir, 'handoff-delivery', ownerHash, prepared.actionId);
  const files = await realFs.readdir(deliveryDir);
  assert.equal(files.length, 1, 'checkpoint 失败时不能清理未确认的副本');
});

test('only two different actions can confirm at once and the third is busy before claim', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const host = fakeHost({
    async stage(input) {
      host.calls.push(['stage', input]);
      await gate;
      return { fileId: 'file-1', name: input.name, mime: input.mime };
    },
  });
  const harness = makeHarness({ dataDir, store, host });
  const first = actionOf(await prepareViaRoute(harness, handoffContext()));
  const second = actionOf(await prepareViaRoute(harness, handoffContext()));
  const third = actionOf(await prepareViaRoute(harness, handoffContext()));

  const pending = [
    harness.call('POST', '/api/handoff/confirm', { body: { actionId: first.actionId } }),
    harness.call('POST', '/api/handoff/confirm', { body: { actionId: second.actionId } }),
  ];
  try {
    // 等两个确认都进入 stage 前的停顿（有界等待，失败也会释放栅栏）
    await waitFor(() => host.calls.filter(call => call[0] === 'stage').length >= 2, '两个确认进入 stage');
    const busy = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: third.actionId } });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'HANDOFF_BUSY');
    assert.equal((await store.get({ owner: OWNER, actionId: third.actionId })).action.state, 'prepared');
  } finally {
    release();
  }
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.body.ok));
});

test('a precheck failure releases the confirmation slot for the next actions', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const b1 = 'b'.repeat(32);
  const c1 = 'c'.repeat(32);
  const entries = {
    [a1]: artifactFixture(a1, 'a-body'),
    [b1]: artifactFixture(b1, 'b-body'),
    [c1]: artifactFixture(c1, 'c-body'),
  };
  let armed = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const artifacts = {
    calls: seen,
    async read({ artifactId }) {
      if (!entries[artifactId]) throw Object.assign(new Error('missing'), { code: 'ARTIFACT_NOT_FOUND' });
      if (!armed) return entries[artifactId];
      seen.push(artifactId);
      if (artifactId === a1) {
        throw Object.assign(new Error('precheck failed'), { code: 'ARTIFACT_NOT_FOUND' });
      }
      await gate;
      return entries[artifactId];
    },
  };
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const first = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));
  const second = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [b1] })));
  const third = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [c1] })));

  armed = true;
  // 预检失败的确认不能把名额永久占住
  const failed = await confirmViaRoute(harness, first.actionId);
  assert.equal(failed.body.ok, false);
  assert.equal((await store.get({ owner: OWNER, actionId: first.actionId })).action.state, 'prepared');

  const pending = [confirmViaRoute(harness, second.actionId), confirmViaRoute(harness, third.actionId)];
  try {
    // 两个后续确认都拿到了名额并进入复核（预检失败没有把名额占住）
    await waitFor(() => seen.includes(b1) && seen.includes(c1), '两个后续确认都进入复核');
  } finally {
    release();
  }
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.body.ok), '预检失败后名额应可复用');
  assert.ok(results.every(result => result.body.action.state === 'ready'));
});

test('all 16 artifacts plus the archive are staged and recorded as 17 files', async () => {
  const dataDir = await makeDir();
  const ids = Array.from({ length: 16 }, (_, index) => String(index).padStart(2, '0').repeat(16));
  const entries = Object.fromEntries(ids.map(id => [id, artifactFixture(id, `body-${id}`)]));
  const artifacts = fakeArtifacts(entries);
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, artifacts });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: ids })));
  const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(response.body.action.state, 'ready');
  assert.equal(response.body.action.files.length, 17);
  assert.equal(host.calls.filter(call => call[0] === 'stage').length, 17);
  assert.equal(host.calls.filter(call => call[0] === 'writeContext').length, 1);
});

test('temporary files are removed after each confirmed stage and the exact action directory is gone before ready', async () => {
  const dataDir = await makeDir();
  const artifactId = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [artifactId]: artifactFixture(artifactId) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, artifacts });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [artifactId] })));
  const response = await harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(response.body.action.state, 'ready');
  const ownerHash = createHash('sha256').update(OWNER).digest('hex');
  const deliveryDir = path.join(dataDir, 'handoff-delivery', ownerHash, prepared.actionId);
  await assert.rejects(realFs.lstat(deliveryDir), error => error.code === 'ENOENT');
});

test('a restart sees the persisted state and never replays an in-flight action', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const host = fakeHost({
    async stage(input) {
      host.calls.push(['stage', input]);
      await gate;
      return { fileId: 'file-1', name: input.name, mime: input.mime };
    },
  });
  const harness = makeHarness({ dataDir, store, host });

  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));
  const pending = harness.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  while (host.calls.filter(call => call[0] === 'stage').length < 1) await new Promise(resolve => setTimeout(resolve, 5));

  const restartedStore = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const restartedHost = fakeHost();
  const restarted = makeHarness({ dataDir, store: restartedStore, host: restartedHost });
  const replay = await restarted.call('POST', '/api/handoff/confirm', { body: { actionId: prepared.actionId } });
  assert.equal(replay.body.ok, true);
  assert.equal(replay.body.action.state, 'unknown');
  assert.equal(restartedHost.calls.some(call => call[0] === 'create'), false);

  release();
  const finished = await pending;
  assert.equal(finished.body.action.state, 'ready');
});

test('an unauthenticated caller is refused before the store or host is touched', async () => {
  const dataDir = await makeDir();
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });
  const parsed = new URL('http://local/api/handoff/prepare');
  const c = {
    req: {
      raw: new Request(parsed, { method: 'POST', body: JSON.stringify(handoffContext()) }),
      param: () => undefined,
      query: () => null,
    },
    get: () => null,
    json: (value, status = 200) => ({ status, body: value }),
  };
  const routes = harness.routes.filter(route => route.method === 'POST' && route.pattern === '/api/handoff/prepare');
  const response = await routes[0].handler(c);
  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.deepEqual(await store.list({ owner: OWNER }), []);
  assert.equal(host.calls.length, 0);
});

// ---------------------------------------------------------------------------
// C 轮次 4/5：claim 之后的错误收口、并发闸位置、非法回执、未知结果
// ---------------------------------------------------------------------------

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function confirmViaRoute(harness, actionId) {
  return harness.call('POST', '/api/handoff/confirm', { body: { actionId } });
}

function hostWrites(host) {
  return host.calls.filter(call => call[0] !== 'isIdle').map(call => call[0]);
}

test('C-I1: the first post-claim checkpoint failure returns the safe action, not an HTTP 500', async () => {
  const dataDir = await makeDir();
  const realStore = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const store = {
    ...realStore,
    async checkpoint(input) {
      // 第一次会话 checkpoint（尚无 files 回执）落盘失败
      if (input.state === 'importing' && !input.receipt?.files) {
        throw new Error('SECRET_CHECKPOINT /private/path');
      }
      return realStore.checkpoint(input);
    },
  };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 200, 'claim 之后的 checkpoint 失败仍应是可查询的动作，而不是 500');
  assert.equal(response.body.ok, true);
  assert.ok(['creating', 'unknown'].includes(response.body.action.state), response.body.action.state);
  // 不得继续任何 host 副作用，也不得重复 create
  assert.equal(host.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(host.calls.some(call => call[0] === 'stage'), false);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
  assert.equal(JSON.stringify(response.body).includes('SECRET_CHECKPOINT'), false);
  assert.equal(JSON.stringify(response.body).includes('/private/path'), false);
});

test('C-I1: an artifact checkpoint failure stops host writes and keeps the unconfirmed temp copy', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const b1 = 'b'.repeat(32);
  const artifacts = fakeArtifacts({
    [a1]: artifactFixture(a1, 'a-body'),
    [b1]: artifactFixture(b1, 'b-body'),
  });
  const realStore = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const store = {
    ...realStore,
    async checkpoint(input) {
      if (Array.isArray(input.receipt?.files) && input.receipt.files.length > 0) {
        throw new Error('SECRET_CHECKPOINT');
      }
      return realStore.checkpoint(input);
    },
  };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1, b1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(host.calls.filter(call => call[0] === 'stage').length, 1, 'checkpoint 失败后不能再 stage');
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
  assert.equal(response.body.action.sessionId, 'sess-1');
  const ownerHash = createHash('sha256').update(OWNER).digest('hex');
  const deliveryDir = path.join(dataDir, 'handoff-delivery', ownerHash, prepared.actionId);
  const left = await realFs.readdir(deliveryDir);
  assert.equal(left.length, 1, 'checkpoint 失败时必须保留未确认的临时副本');
});

test('C-I1: when the saved action cannot be read either, the failure says so instead of claiming nothing ran', async () => {
  const dataDir = await makeDir();
  const realStore = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let claimed = false;
  const store = {
    ...realStore,
    async claim(input) {
      const result = await realStore.claim(input);
      claimed = true;
      return result;
    },
    async checkpoint() {
      throw new Error('SECRET_CHECKPOINT');
    },
    async get(input) {
      if (claimed) throw new Error('SECRET_READ');
      return realStore.get(input);
    },
  };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext()));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 409, String(response.status));
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'HANDOFF_ACTION_UNKNOWN');
  assert.equal(response.body.error.includes('actionId'), true);
  assert.equal(response.body.error.includes('请求未执行'), false, '宿主已经写过，不能说请求未执行');
  assert.equal(JSON.stringify(response.body).includes('SECRET_'), false);
});

test('C-I2: an isIdle failure after claim settles to a queryable action instead of an HTTP 500', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [a1]: artifactFixture(a1) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost({
    async isIdle() {
      host.calls.push(['isIdle']);
      throw new Error('SECRET_IDLE /private/path');
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 200, '查询异常不应变成 500');
  assert.equal(response.body.ok, true);
  const state = response.body.action.state;
  assert.ok(['partial', 'unknown'].includes(state), `持久状态必须是安全终态，实际 ${state}`);
  assert.equal(response.body.action.sessionId, 'sess-1');
  assert.equal(response.body.action.files.length, 0);
  assert.equal(host.calls.some(call => call[0] === 'stage'), false);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
  const persisted = await store.get({ owner: OWNER, actionId: prepared.actionId });
  assert.ok(['partial', 'unknown'].includes(persisted.action.state), `落盘状态 ${persisted.action.state}`);
  assert.equal(JSON.stringify(response.body).includes('SECRET_IDLE'), false);
  assert.equal(JSON.stringify(response.body).includes('/private/path'), false);
});

test('C-I2: an isIdle failure before the custom write keeps both earlier receipts and stops there', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [a1]: artifactFixture(a1) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let idleCalls = 0;
  const host = fakeHost({
    async isIdle() {
      idleCalls += 1;
      host.calls.push(['isIdle']);
      if (idleCalls === 3) throw new Error('SECRET_IDLE');
      return true;
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.ok(['partial', 'unknown'].includes(response.body.action.state), response.body.action.state);
  assert.equal(response.body.action.sessionId, 'sess-1');
  assert.equal(response.body.action.files.length, 2, '产物与归档回执都要保留');
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
  assert.equal(JSON.stringify(response.body).includes('SECRET_IDLE'), false);
});

test('C-I3: a third action is refused before its artifacts are read again', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const b1 = 'b'.repeat(32);
  const c1 = 'c'.repeat(32);
  const entries = {
    [a1]: artifactFixture(a1, 'a-body'),
    [b1]: artifactFixture(b1, 'b-body'),
    [c1]: artifactFixture(c1, 'c-body'),
  };
  const reads = [];
  let armed = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const artifacts = {
    calls: reads,
    async read({ artifactId }) {
      reads.push(artifactId);
      const entry = entries[artifactId];
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ARTIFACT_NOT_FOUND' });
      if (!armed) return entry;
      if (artifactId === a1 || artifactId === b1) {
        await gate;
        return entry;
      }
      throw Object.assign(new Error('第三个请求不应进入产物读取'), { code: 'ARTIFACT_NOT_FOUND' });
    },
  };
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const first = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));
  const second = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [b1] })));
  const third = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [c1] })));

  armed = true;
  const pending = [confirmViaRoute(harness, first.actionId), confirmViaRoute(harness, second.actionId)];
  try {
    await waitFor(() => reads.filter(id => id === a1).length === 2, '第一个确认进入产物复核');
    await waitFor(() => reads.filter(id => id === b1).length === 2, '第二个确认进入产物复核');
    const busy = await confirmViaRoute(harness, third.actionId);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'HANDOFF_BUSY');
    assert.equal(reads.filter(id => id === c1).length, 1, '第三个请求只应保留 prepare 时的一次读取');
    assert.equal((await store.get({ owner: OWNER, actionId: third.actionId })).action.state, 'prepared');
  } finally {
    release();
    await Promise.allSettled(pending);
  }
});

test('C-I3: a repeat confirm of a running action only queries and never drops the original key', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const entry = artifactFixture(a1);
  let armed = false;
  let reads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const artifacts = {
    calls: [],
    async read({ artifactId }) {
      if (artifactId !== a1) throw Object.assign(new Error('missing'), { code: 'ARTIFACT_NOT_FOUND' });
      if (!armed) return entry;
      reads += 1;
      if (reads === 1) {
        await gate;
        return entry;
      }
      // 第 2 次是 claim 后的正式复核，允许；第 3 次只可能是重复确认又去读产物
      if (reads > 2) throw Object.assign(new Error('重复 confirm 不应再次读取产物'), { code: 'ARTIFACT_NOT_FOUND' });
      return entry;
    },
  };
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));

  armed = true;
  const pending = confirmViaRoute(harness, prepared.actionId);
  await waitFor(() => reads === 1, '首个确认进入产物复核');
  let duplicate;
  try {
    duplicate = await confirmViaRoute(harness, prepared.actionId);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.ok, true);
    assert.equal(reads, 1, '同一 action 的重复确认只应查询');
  } finally {
    release();
  }
  const first = await pending;
  assert.equal(first.body.ok, true);
  assert.equal(first.body.action.state, 'ready');
  // 重复调用不能删掉原调用的名额/写权：动作结束后再查应是 ready，而不是 busy
  const afterwards = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(afterwards.status, 200);
  assert.equal(afterwards.body.action.state, 'ready');
});

test('C-I4: an artifact stage receipt carrying a private path is never saved into the action', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const b1 = 'b'.repeat(32);
  const artifacts = fakeArtifacts({
    [a1]: artifactFixture(a1, 'a-body'),
    [b1]: artifactFixture(b1, 'b-body'),
  });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let stageCalls = 0;
  const host = fakeHost({
    async stage(input) {
      stageCalls += 1;
      host.calls.push(['stage', input]);
      if (stageCalls === 2) {
        return { fileId: '/private/path/secret.md', name: input.name, mime: input.mime };
      }
      return { fileId: 'file-1', name: input.name, mime: input.mime };
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1, b1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  const body = JSON.stringify(response.body);
  assert.equal(body.includes('/private/path'), false, '无效 fileId 不能进 action');
  assert.equal(response.body.action.state, 'unknown', '无效回执属于未知结果');
  assert.equal(response.body.action.sessionId, 'sess-1');
  assert.equal(response.body.action.files.length, 1, '只保留可信回执');
  assert.equal(response.body.action.files[0].fileId, 'file-1');
  assert.equal(host.calls.filter(call => call[0] === 'stage').length, 2);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
  const persisted = await store.get({ owner: OWNER, actionId: prepared.actionId });
  assert.equal(JSON.stringify(persisted.action).includes('/private/path'), false);
});

test('C-I4: an archive stage receipt carrying a private path stops before the custom write', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [a1]: artifactFixture(a1) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let stageCalls = 0;
  const host = fakeHost({
    async stage(input) {
      stageCalls += 1;
      host.calls.push(['stage', input]);
      if (stageCalls === 2) {
        return { fileId: '../../private/context', name: input.name, mime: input.mime };
      }
      return { fileId: 'file-1', name: input.name, mime: input.mime };
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(JSON.stringify(response.body).includes('private/context'), false, '无效 fileId 不能进 action');
  assert.equal(response.body.action.state, 'unknown');
  assert.equal(response.body.action.files.length, 1);
  assert.equal(response.body.action.entryId, null);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
});

test('C-I6: a stage that times out is unknown, keeps earlier receipts and is never retried', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const b1 = 'b'.repeat(32);
  const artifacts = fakeArtifacts({
    [a1]: artifactFixture(a1, 'a-body'),
    [b1]: artifactFixture(b1, 'b-body'),
  });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let stageCalls = 0;
  const host = fakeHost({
    async stage(input) {
      stageCalls += 1;
      host.calls.push(['stage', input]);
      if (stageCalls === 2) {
        const error = new Error('ETIMEDOUT upstream timeout');
        error.code = 'HANDOFF_HOST_ERROR';
        throw error;
      }
      return { fileId: 'file-1', name: input.name, mime: input.mime };
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1, b1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.state, 'unknown', `超时属于未知结果，实际 ${response.body.action.state}`);
  assert.equal(response.body.action.sessionId, 'sess-1');
  assert.equal(response.body.action.files.length, 1);
  assert.equal(host.calls.filter(call => call[0] === 'stage').length, 2, '不得自动重试 stage');
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
  assert.equal(JSON.stringify(response.body).includes('ETIMEDOUT'), false);
});

test('C-I6: a stage that resolves without a usable receipt is unknown and saves no bogus fields', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [a1]: artifactFixture(a1) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost({
    async stage(input) {
      host.calls.push(['stage', input]);
      return { resource: { kind: 'session-file' } };
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.state, 'unknown');
  assert.equal(response.body.action.sessionId, 'sess-1');
  assert.equal(response.body.action.files.length, 0);
  assert.equal(host.calls.some(call => call[0] === 'writeContext'), false);
});

test('C-I6: a custom write that times out is unknown and keeps every known receipt', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [a1]: artifactFixture(a1) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost({
    async writeContext(input) {
      host.calls.push(['writeContext', input]);
      const error = new Error('ECONNRESET while sending');
      error.code = 'HANDOFF_HOST_ERROR';
      throw error;
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.state, 'unknown', `未知结果不能写成 partial，实际 ${response.body.action.state}`);
  assert.equal(response.body.action.sessionId, 'sess-1');
  assert.equal(response.body.action.files.length, 2);
  assert.equal(response.body.action.entryId, null);
  assert.equal(host.calls.filter(call => call[0] === 'writeContext').length, 1);
  assert.equal(JSON.stringify(response.body).includes('ECONNRESET'), false);
});

test('C-I6: a custom receipt without a usable entryId is unknown, not a silent success', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const artifacts = fakeArtifacts({ [a1]: artifactFixture(a1) });
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost({
    async writeContext(input) {
      host.calls.push(['writeContext', input]);
      return { ok: true, mode: 'notifyOnly' };
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });
  const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));

  const response = await confirmViaRoute(harness, prepared.actionId);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action.state, 'unknown');
  assert.equal(response.body.action.entryId, null);
  assert.equal(response.body.action.sessionId, 'sess-1');
  assert.equal(response.body.action.files.length, 2);
});

// ---------------------------------------------------------------------------
// round5 M2：先做 owner-scoped 查库（404 / 非 prepared 直接返回），只有 prepared 才登记名额
// ---------------------------------------------------------------------------

test('M2: the confirmation gate runs after the owner lookup, so missing/foreign/ready/unknown stay queries', async () => {
  const dataDir = await makeDir();
  const a1 = 'a'.repeat(32);
  const b1 = 'b'.repeat(32);
  const c1 = 'c'.repeat(32);
  const f1 = 'f'.repeat(32);
  const r1 = '1'.repeat(32);
  const u1 = '2'.repeat(32);
  const entries = {
    [a1]: artifactFixture(a1, 'a-body'),
    [b1]: artifactFixture(b1, 'b-body'),
    [c1]: artifactFixture(c1, 'c-body'),
    [f1]: artifactFixture(f1, 'f-body'),
    [r1]: artifactFixture(r1, 'r-body'),
    [u1]: artifactFixture(u1, 'u-body'),
  };
  let armed = false;
  let failStage = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reads = [];
  const artifacts = {
    calls: reads,
    async read({ artifactId }) {
      reads.push(artifactId);
      const entry = entries[artifactId];
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ARTIFACT_NOT_FOUND' });
      if (!armed) return entry;
      if (artifactId === a1 || artifactId === b1) {
        await gate;
        return entry;
      }
      return entry;
    },
  };
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let staged = 0;
  const host = fakeHost({
    async stage(input) {
      host.calls.push(['stage', input]);
      if (failStage) throw Object.assign(new Error('stage timeout'), { code: 'ETIMEDOUT' });
      staged += 1;
      return { fileId: `file-${staged}`, name: input.name, mime: input.mime };
    },
  });
  const harness = makeHarness({ dataDir, store, host, artifacts });

  const first = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [a1] })));
  const second = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [b1] })));
  const third = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [c1] })));
  const readyAction = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [r1] })));
  assert.equal((await confirmViaRoute(harness, readyAction.actionId)).body.action.state, 'ready');
  const unknownAction = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [u1] })));
  failStage = true;
  assert.equal((await confirmViaRoute(harness, unknownAction.actionId)).body.action.state, 'unknown');
  failStage = false;
  const createsBefore = host.calls.filter(call => call[0] === 'create').length;

  armed = true;
  const pending = [confirmViaRoute(harness, first.actionId), confirmViaRoute(harness, second.actionId)];
  try {
    await waitFor(() => reads.filter(id => id === a1).length === 2, '第一个确认进入产物复核');
    await waitFor(() => reads.filter(id => id === b1).length === 2, '第二个确认进入产物复核');

    // 不存在 / 其它 owner：是 404 而不是 busy
    const missing = await confirmViaRoute(harness, `ha_${'e'.repeat(32)}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'HANDOFF_ACTION_NOT_FOUND');

    const foreign = actionOf(await harness.call('POST', '/api/handoff/prepare', {
      body: handoffContext({ artifactIds: [f1] }),
      principal: 'user-2',
    }));
    const foreignConfirm = await confirmViaRoute(harness, foreign.actionId);
    assert.equal(foreignConfirm.status, 404, '其它 owner 的动作一律 404');
    assert.equal(foreignConfirm.body.code, 'HANDOFF_ACTION_NOT_FOUND');

    // prepared 的第三个动作才是 busy，且不因 busy 去读产物
    const busy = await confirmViaRoute(harness, third.actionId);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'HANDOFF_BUSY');
    assert.equal(reads.filter(id => id === c1).length, 1, 'busy 时不读产物');
    assert.equal((await store.get({ owner: OWNER, actionId: third.actionId })).action.state, 'prepared');

    // 终态动作：直接查库返回 200，不新 create、不抢名额
    const readyAgain = await confirmViaRoute(harness, readyAction.actionId);
    assert.equal(readyAgain.status, 200);
    assert.equal(readyAgain.body.ok, true);
    assert.equal(readyAgain.body.action.state, 'ready');
    assert.equal(readyAgain.body.action.actionId, readyAction.actionId);

    const unknownAgain = await confirmViaRoute(harness, unknownAction.actionId);
    assert.equal(unknownAgain.status, 200);
    assert.equal(unknownAgain.body.ok, true);
    assert.equal(unknownAgain.body.action.state, 'unknown');

    assert.equal(
      host.calls.filter(call => call[0] === 'create').length,
      createsBefore,
      '只查询不能再创建会话',
    );
  } finally {
    release();
    await Promise.allSettled(pending);
  }
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.body.ok), '释放栅栏后两个编排都能完成');
});

// ---------------------------------------------------------------------------
// Task3 前置：清理校验只容许 ENOENT 当“已不存在”；其余 lstat 故障必须停下编排
// ---------------------------------------------------------------------------

test('precondition: an unreadable action directory stops before isIdle/custom and stays partial', async () => {
  const artifactId = 'a'.repeat(32);
  for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
    const dataDir = await makeDir();
    const injection = { armed: false, actionDir: null, calls: [] };
    // 真实 delivery，只注入动作目录的 lstat 故障；Store 仍用真实 fs
    const injectedFs = {
      ...realFs,
      async unlink(target) {
        const result = await realFs.unlink(target);
        injection.calls.push(['unlink', target]);
        // 归档临时文件删掉之后再激活故障，模拟“清理到一半遇到不可读目录”
        if (path.basename(target) === 'context.md') injection.armed = true;
        return result;
      },
      async lstat(target, options) {
        if (injection.armed && target === injection.actionDir) {
          injection.calls.push(['lstat', target]);
          throw Object.assign(new Error(`SECRET_${code} ${target}`), { code });
        }
        return realFs.lstat(target, options);
      },
    };
    const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
    const artifacts = fakeArtifacts({ [artifactId]: artifactFixture(artifactId) });
    const host = fakeHost();
    const delivery = createHandoffDelivery({ dataDir, fs: injectedFs });
    const harness = makeHarness({ dataDir, store, host, artifacts, delivery });
    const prepared = actionOf(await prepareViaRoute(harness, handoffContext({ artifactIds: [artifactId] })));
    const ownerHash = createHash('sha256').update(OWNER).digest('hex');
    injection.actionDir = path.join(dataDir, 'handoff-delivery', ownerHash, prepared.actionId);

    const response = await confirmViaRoute(harness, prepared.actionId);
    assert.equal(response.status, 200, code);
    assert.equal(response.body.ok, true, code);
    assert.equal(response.body.action.state, 'partial', `${code}: 清理失败必须是 partial`);
    assert.equal(response.body.action.errorCode, 'HANDOFF_DELIVERY_CLEANUP_FAILED', code);
    assert.equal(response.body.action.sessionId, 'sess-1', `${code}: 已知 session 保留`);
    assert.equal(response.body.action.files.length, 2, `${code}: 已知回执保留`);
    assert.equal(response.body.action.entryId, null, code);
    assert.equal(host.calls.some(call => call[0] === 'writeContext'), false, `${code}: 不能再写 custom`);
    assert.equal(
      host.calls.filter(call => call[0] === 'isIdle').length,
      2,
      `${code}: 清理失败后不得再读 idle`,
    );
    const text = JSON.stringify(response.body);
    assert.equal(text.includes('SECRET_'), false, `${code}: 不能泄露错误原文`);
    assert.equal(text.includes(injection.actionDir), false, `${code}: 不能泄露路径`);
    assert.equal((await realFs.lstat(injection.actionDir)).isDirectory(), true, `${code}: 动作目录不能被删`);
  }
});

// ---------------------------------------------------------------------------
// I1：prepare / confirm 都必须在副作用之前检查正文预算
// ---------------------------------------------------------------------------

const TRANSCRIPT_BUDGET = HANDOFF_LIMITS.maxTranscriptBytes - HANDOFF_LIMITS.fileIndexReserveBytes;

/** 构造一个带指定长度 ASCII 正文的合法 DTO（编译器会提前拒绝超限，这里直接造协议层输入） */
function bigHandoffDto(chars) {
  return {
    schemaVersion: 1,
    source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' },
    agentId: 'agent-a',
    nextStep: '继续处理',
    nodes: [{
      cardId: 'card-1',
      title: '目标',
      parentIds: [],
      contextMode: 'include',
      doc: null,
      messages: [{
        role: 'user',
        text: 'x'.repeat(chars),
        agentName: '',
        status: 'ok',
        attachments: [],
        artifactIds: [],
      }],
      artifactIds: [],
    }],
    references: [],
    referenceSources: [],
    artifactIds: [],
    exclusions: [],
    omissions: { localNoticeCount: 0 },
    unsent: [],
    notices: [],
    stats: { nodeCount: 0, transcriptBytes: 0 },
  };
}

/** 规范化后的真实转录字节数（以协议层重算为准，不采信调用方 stats） */
function transcriptBytesFor(chars) {
  return validateHandoffContext(bigHandoffDto(chars)).stats.transcriptBytes;
}

test('I1: prepare rejects an over-budget canonical transcript before store or host side effects', async () => {
  const dataDir = await makeDir();
  const forged = bigHandoffDto(2_100_000);   // 伪报 stats=0
  assert.ok(transcriptBytesFor(2_100_000) > TRANSCRIPT_BUDGET, '夹具必须真的超过正文预算');
  assert.ok(JSON.stringify(forged).length < HANDOFF_LIMITS.maxPrepareJsonBytes, 'JSON 仍在 prepare 上限内');

  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  let storePrepareCalls = 0;
  const countedStore = {
    ...store,
    async prepare(args) {
      storePrepareCalls += 1;
      return store.prepare(args);
    },
  };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store: countedStore, host });

  const response = await harness.call('POST', '/api/handoff/prepare', { body: forged });
  assert.equal(response.status, 413, JSON.stringify(response.body).slice(0, 200));
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'HANDOFF_TRANSCRIPT_TOO_LARGE');
  assert.equal(storePrepareCalls, 0, '不得写入 Store');
  assert.equal(hostWrites(host).length, 0, '不得读能力或开宿主会话');
});

test('I1: confirm refuses an over-budget prepared record before claim, create or import', async () => {
  const dataDir = await makeDir();
  const seededContext = validateHandoffContext(bigHandoffDto(2_100_000));
  assert.ok(seededContext.stats.transcriptBytes > TRANSCRIPT_BUDGET);

  // 直接 Store seed 一个超限旧记录（经过规范化校验，stats 真实）
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const seeded = await store.prepare({ owner: OWNER, context: seededContext });
  assert.equal((await store.get({ owner: OWNER, actionId: seeded.actionId })).action.state, 'prepared');

  let claimCalls = 0;
  const countedStore = {
    ...store,
    async claim(args) {
      claimCalls += 1;
      return store.claim(args);
    },
  };
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store: countedStore, host });

  const response = await confirmViaRoute(harness, seeded.actionId);
  assert.equal(response.status, 413, JSON.stringify(response.body).slice(0, 200));
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'HANDOFF_TRANSCRIPT_TOO_LARGE');
  assert.equal(claimCalls, 0, '不得 claim');
  assert.equal(hostWrites(host).length, 0, '不得 create/import/dispatch');

  // 状态仍可查，没留下空会话或半成品
  const still = await harness.call('GET', `/api/handoff/actions/${seeded.actionId}`);
  assert.equal(still.status, 200);
  assert.equal(still.body.action.state, 'prepared');
  assert.equal(still.body.action.sessionId, null);
});

test('I1: the exact transcript budget is accepted and one byte more is refused', async () => {
  const dataDir = await makeDir();
  const probeBytes = transcriptBytesFor(1000);
  const exactChars = 1000 + (TRANSCRIPT_BUDGET - probeBytes);
  assert.equal(transcriptBytesFor(exactChars), TRANSCRIPT_BUDGET, '边界夹具必须恰好等于预算');

  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => 1 });
  const host = fakeHost();
  const harness = makeHarness({ dataDir, store, host });

  const allowed = await prepareViaRoute(harness, bigHandoffDto(exactChars));
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body).slice(0, 200));
  assert.equal(allowed.body.ok, true);

  const over = await prepareViaRoute(harness, bigHandoffDto(exactChars + 1));
  assert.equal(over.status, 413);
  assert.equal(over.body.code, 'HANDOFF_TRANSCRIPT_TOO_LARGE');

  // 普通上下文仍能走完 prepare → confirm → ready
  const normal = await prepareViaRoute(harness, handoffContext());
  assert.equal(normal.status, 200);
  const confirmed = await confirmViaRoute(harness, normal.body.action.actionId);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.action.state, 'ready');
});


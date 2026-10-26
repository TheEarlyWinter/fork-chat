import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandoffHost } from '../lib/handoff-host.js';

// ---------------------------------------------------------------------------
// 夹具：只模拟官方命名 SDK，方法用普通函数以便记录 receiver
// ---------------------------------------------------------------------------

const PERMISSIONS = [
  'app/sessions.home',
  'app/sessions.read',
  'app/sessions.manage',
  'app/session.stage-file',
  'app/agents.read',
];

function grantMap(overrides = {}) {
  return { ...Object.fromEntries(PERMISSIONS.map(capability => [capability, 'always'])), ...overrides };
}

function ledger(grants) {
  return {
    capabilities: Object.entries(grants).map(([capability, status]) => ({
      capability,
      status,
      enforcement: 'hard',
    })),
  };
}

function homeReceipt(overrides = {}) {
  return {
    ok: true,
    namespace: 'home',
    sessionId: 'sess-1',
    sessionPath: '/sessions/sess-1.jsonl',
    path: '/sessions/sess-1.jsonl',
    agentId: 'agent-a',
    visibility: 'public',
    // 真实宿主用创建者 App 盖章，home 不等于 owner 为 null
    ownerPluginId: 'fork-chat',
    ...overrides,
  };
}

function stageReceipt(overrides = {}) {
  return {
    file: { name: 'artifact.md' },
    mediaItem: null,
    resource: { kind: 'session-file', fileId: 'file-9', sessionId: 'sess-1' },
    ...overrides,
  };
}

function customReceipt(overrides = {}) {
  return {
    ok: true,
    mode: 'notifyOnly',
    customType: 'hana:branch-handoff',
    entryId: 'entry-1',
    sessionId: 'sess-1',
    ...overrides,
  };
}

function makeSdk(options = {}) {
  const calls = { capabilities: [], create: [], context: [], stageFile: [], sendCustom: [], send: [], list: [] };
  const contextResults = Array.isArray(options.contextResults) ? [...options.contextResults] : null;
  const createReceipts = Array.isArray(options.createReceipts) ? [...options.createReceipts] : null;
  let createIndex = 0;
  let customIndex = 0;

  const sdk = {
    sessions: {
      async create(input) {
        calls.create.push({ input, receiver: this });
        if (options.createError) throw options.createError;
        if (createReceipts) {
          return createReceipts[Math.min(createIndex++, createReceipts.length - 1)];
        }
        return options.createReceipt ?? homeReceipt();
      },
      async context(input) {
        calls.context.push({ input, receiver: this });
        if (options.contextError) throw options.contextError;
        if (contextResults) {
          if (!contextResults.length) throw new Error('contextResults 已耗尽');
          return contextResults.shift();
        }
        return { sessionId: 'sess-1', isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
      },
      async stageFile(input) {
        calls.stageFile.push({ input, receiver: this });
        if (options.stageError) throw options.stageError;
        return (options.stageReceipts?.[callCount(calls, 'stageFile') - 1]) ?? options.stageReceipt ?? stageReceipt();
      },
      async sendCustom(input) {
        calls.sendCustom.push({ input, receiver: this });
        if (options.sendCustomError) throw options.sendCustomError;
        const receipts = options.sendCustomReceipts ?? [options.sendCustomReceipt ?? customReceipt()];
        return receipts[Math.min(customIndex++, receipts.length - 1)];
      },
      // 旧的回传通道：host 只允许 notifyOnly，绝不能落到 send
      async send(input) {
        calls.send.push({ input, receiver: this });
        throw new Error('不允许调用 session:send');
      },
    },
    capabilities: {
      async get(input) {
        calls.capabilities.push(input);
        if (options.capabilitiesError) throw options.capabilitiesError;
        return ledger(options.permissions ?? grantMap());
      },
    },
    agents: {
      async list(input) {
        calls.list.push({ input, receiver: this });
        return { agents: [{ id: 'agent-a', lifecycle: 'active' }] };
      },
    },
  };

  for (const [domain, method] of options.remove ?? []) delete sdk[domain][method];

  return { sdk, calls };
}

function callCount(calls, kind) {
  return calls[kind].length;
}

function context(sessionId = 'sess-1') {
  return { sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('capabilities reports availability when the named SDK and all four grants are present', async () => {
  const { sdk, calls } = makeSdk();
  const host = createHandoffHost({ sdk });

  assert.deepEqual(await host.capabilities(), {
    supported: true,
    available: true,
    home: true,
    read: true,
    manage: true,
    stageFile: true,
    agentsRead: true,
    missing: [],
    reason: null,
  });
  assert.equal(calls.capabilities.length, 1);
});

test('capabilities reports unsupported without consulting the ledger when a named method is missing', async () => {
  const { sdk, calls } = makeSdk({ remove: [['sessions', 'sendCustom']] });
  const host = createHandoffHost({ sdk });

  const caps = await host.capabilities();
  assert.equal(caps.supported, false);
  assert.equal(caps.available, false);
  assert.equal(caps.reason, 'HANDOFF_UNSUPPORTED');
  assert.deepEqual(caps.missing, []);
  assert.equal(calls.capabilities.length, 0);

  await assert.rejects(
    host.writeContext({ sessionId: 'sess-1', content: '正文', details: {} }),
    error => error.code === 'HANDOFF_UNSUPPORTED',
  );
});

test('capabilities lists denied grants as missing and refuses to write', async () => {
  const { sdk, calls } = makeSdk({
    permissions: grantMap({ 'app/sessions.manage': 'denied', 'app/sessions.home': 'not_asked' }),
  });
  const host = createHandoffHost({ sdk });

  const caps = await host.capabilities();
  assert.equal(caps.supported, true);
  assert.equal(caps.available, false);
  assert.equal(caps.home, false);
  assert.equal(caps.manage, false);
  assert.deepEqual(caps.missing, ['app/sessions.home', 'app/sessions.manage']);
  assert.equal(caps.reason, 'HANDOFF_PERMISSION_MISSING');

  await assert.rejects(
    host.writeContext({ sessionId: 'sess-1', content: '正文', details: {} }),
    error => error.code === 'HANDOFF_PERMISSION_MISSING',
  );
  assert.equal(calls.sendCustom.length, 0);
});

test('capabilities requires the existing agents.read grant for agent validation', async () => {
  const { sdk } = makeSdk({ permissions: grantMap({ 'app/agents.read': 'not_asked' }) });
  const caps = await createHandoffHost({ sdk }).capabilities();

  assert.equal(caps.available, false);
  assert.equal(caps.agentsRead, false);
  assert.deepEqual(caps.missing, ['app/agents.read']);
  assert.equal(caps.reason, 'HANDOFF_PERMISSION_MISSING');
});

test('capabilities fails closed as a permission problem when the ledger cannot be read', async () => {
  const { sdk } = makeSdk({ capabilitiesError: new Error('bus unavailable') });
  const caps = await createHandoffHost({ sdk }).capabilities();

  assert.equal(caps.supported, true);
  assert.equal(caps.available, false);
  assert.equal(caps.reason, 'HANDOFF_PERMISSION_MISSING');
  assert.deepEqual(caps.missing, PERMISSIONS);
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('create asks for a home session with memory disabled and accepts a public home receipt', async () => {
  const { sdk, calls } = makeSdk({ createReceipt: homeReceipt() });
  const host = createHandoffHost({ sdk });

  assert.deepEqual(await host.create({ agentId: 'agent-a' }), { sessionId: 'sess-1' });
  assert.deepEqual(calls.create[0].input, { namespace: 'home', memoryEnabled: false, agentId: 'agent-a' });
  assert.equal(calls.create[0].receiver, sdk.sessions);
});

test('create rejects an app-scoped receipt but carries the trusted session id', async () => {
  const { sdk } = makeSdk({
    createReceipt: homeReceipt({ namespace: 'app', visibility: 'private' }),
  });
  const host = createHandoffHost({ sdk });

  await assert.rejects(host.create({ agentId: 'agent-a' }), error => {
    assert.equal(error.code, 'HANDOFF_INVALID_SESSION');
    assert.equal(error.sessionId, 'sess-1');
    assert.equal(error.details?.sessionId, 'sess-1');
    return true;
  });
});

test('create accepts a home public receipt whose owner is null or absent', async () => {
  const { sdk } = makeSdk({
    createReceipts: [
      homeReceipt({ sessionId: 'sess-null', ownerPluginId: null }),
      homeReceipt({ sessionId: 'sess-absent', ownerPluginId: undefined }),
    ],
  });
  const host = createHandoffHost({ sdk });

  assert.deepEqual(await host.create({ agentId: 'agent-a' }), { sessionId: 'sess-null' });
  assert.deepEqual(await host.create({ agentId: 'agent-a' }), { sessionId: 'sess-absent' });
});

test('create rejects a receipt owned by another app but carries the trusted session id', async () => {
  const { sdk } = makeSdk({
    createReceipt: homeReceipt({ sessionId: 'sess-other-app', ownerPluginId: 'another-app' }),
  });

  await assert.rejects(createHandoffHost({ sdk }).create({ agentId: 'agent-a' }), error => {
    assert.equal(error.code, 'HANDOFF_INVALID_SESSION');
    assert.equal(error.sessionId, 'sess-other-app');
    assert.equal(error.details?.sessionId, 'sess-other-app');
    return true;
  });
});

test('create rejects a receipt without a trusted session id and exposes no fabricated id', async () => {
  const { sdk } = makeSdk({
    createReceipt: { ok: false, namespace: 'home', visibility: 'public', ownerPluginId: null },
  });

  await assert.rejects(createHandoffHost({ sdk }).create({ agentId: 'agent-a' }), error => {
    assert.equal(error.code, 'HANDOFF_INVALID_SESSION');
    assert.equal(error.sessionId, undefined);
    return true;
  });
});

test('create rejects a receipt whose agent differs from the frozen request but carries the trusted session id', async () => {
  for (const receipt of [
    homeReceipt({ sessionId: 'sess-other-agent', agentId: 'agent-b' }),
    homeReceipt({ sessionId: 'sess-no-agent', agentId: undefined }),
  ]) {
    const { sdk } = makeSdk({ createReceipt: receipt });
    await assert.rejects(createHandoffHost({ sdk }).create({ agentId: 'agent-a' }), error => {
      assert.equal(error.code, 'HANDOFF_INVALID_SESSION');
      assert.equal(error.sessionId, receipt.sessionId);
      assert.equal(error.details?.sessionId, receipt.sessionId);
      return true;
    });
  }
});

test('create refuses before the host call when the home grant is missing', async () => {
  const { sdk, calls } = makeSdk({ permissions: grantMap({ 'app/sessions.home': 'denied' }) });

  await assert.rejects(createHandoffHost({ sdk }).create({ agentId: 'agent-a' }), error => {
    assert.equal(error.code, 'HANDOFF_PERMISSION_MISSING');
    assert.deepEqual(error.details?.missing, ['app/sessions.home']);
    return true;
  });
  assert.equal(calls.create.length, 0);
});

// ---------------------------------------------------------------------------
// isIdle
// ---------------------------------------------------------------------------

test('isIdle is true only for a matching session with both flags false and zero pending messages', async () => {
  const { sdk, calls } = makeSdk({
    contextResults: [
      { ...context(), systemPrompt: '机密提示词' },
      { ...context(), isStreaming: true },
      { ...context(), isCompacting: true },
      { ...context(), pendingMessageCount: 2 },
      { ...context(), pendingMessageCount: null },
      { ...context(), sessionId: 'sess-other' },
    ],
  });
  const host = createHandoffHost({ sdk });

  assert.equal(await host.isIdle('sess-1'), true);
  assert.equal(await host.isIdle('sess-1'), false);
  assert.equal(await host.isIdle('sess-1'), false);
  assert.equal(await host.isIdle('sess-1'), false);
  assert.equal(await host.isIdle('sess-1'), false);
  assert.equal(await host.isIdle('sess-1'), false);

  assert.deepEqual(calls.context[0].input, { sessionId: 'sess-1', scope: 'all' });
  assert.equal(calls.context[0].receiver, sdk.sessions);
});

test('isIdle surfaces a refused context read instead of claiming the session is busy', async () => {
  const { sdk } = makeSdk({ contextError: new Error('permission denied: app/sessions.read') });

  await assert.rejects(createHandoffHost({ sdk }).isIdle('sess-1'), error => {
    assert.equal(error.code, 'HANDOFF_PERMISSION_MISSING');
    assert.equal(error.message, '宿主拒绝了这项操作');
    return true;
  });
});

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

test('stage takes the file id from the host resource receipt and never sends a message', async () => {
  const { sdk, calls } = makeSdk();
  const host = createHandoffHost({ sdk });

  assert.deepEqual(
    await host.stage({ sessionId: 'sess-1', path: '/private/app/artifact.md', name: 'artifact.md', mime: 'text/markdown' }),
    { fileId: 'file-9', name: 'artifact.md', mime: 'text/markdown' },
  );
  assert.deepEqual(calls.stageFile[0].input, {
    path: '/private/app/artifact.md',
    sessionId: 'sess-1',
    scope: 'all',
    name: 'artifact.md',
    mime: 'text/markdown',
    deliverAs: 'attachment',
  });
  assert.equal(calls.stageFile[0].receiver, sdk.sessions);
  assert.equal(calls.sendCustom.length, 0);
  assert.equal(calls.send.length, 0);
});

test('stage rejects a receipt without a resource file id for the target session', async () => {
  const { sdk, calls } = makeSdk({
    stageReceipts: [
      stageReceipt({ resource: { kind: 'session-file', fileId: '', sessionId: 'sess-1' } }),
      stageReceipt({ resource: { kind: 'session-file', fileId: 'file-9', sessionId: 'sess-other' } }),
      stageReceipt({ resource: { kind: 'local-file', fileId: 'file-9', sessionId: 'sess-1' } }),
    ],
  });
  const host = createHandoffHost({ sdk });

  for (let index = 0; index < 3; index++) {
    await assert.rejects(
      host.stage({ sessionId: 'sess-1', path: '/private/app/artifact.md', name: 'artifact.md', mime: 'text/markdown' }),
      error => error.code === 'HANDOFF_INVALID_FILE',
    );
  }
  assert.equal(calls.sendCustom.length, 0);
});

// ---------------------------------------------------------------------------
// writeContext
// ---------------------------------------------------------------------------

test('writeContext writes exactly one notify-only custom entry with triggerTurn false', async () => {
  const { sdk, calls } = makeSdk();
  const host = createHandoffHost({ sdk });
  const details = { source: { canvasId: 'canvas-1' } };

  assert.deepEqual(
    await host.writeContext({ sessionId: 'sess-1', content: '# 交接正文', details }),
    { entryId: 'entry-1' },
  );
  assert.deepEqual(calls.sendCustom[0].input, {
    sessionId: 'sess-1',
    scope: 'all',
    content: '# 交接正文',
    customType: 'branch-handoff',
    display: true,
    triggerTurn: false,
    details,
  });
  assert.equal(calls.sendCustom[0].receiver, sdk.sessions);
  assert.equal(calls.sendCustom.length, 1);
  assert.equal(calls.send.length, 0);
});

test('writeContext only accepts ok with notifyOnly mode and a trusted entry id', async () => {
  const { sdk } = makeSdk({
    sendCustomReceipts: [
      customReceipt({ mode: 'interactive' }),
      customReceipt({ entryId: null }),
      customReceipt({ ok: false }),
    ],
  });
  const host = createHandoffHost({ sdk });

  for (let index = 0; index < 3; index++) {
    await assert.rejects(
      host.writeContext({ sessionId: 'sess-1', content: '正文', details: {} }),
      error => error.code === 'HANDOFF_INVALID_CONTEXT',
    );
  }
});

// ---------------------------------------------------------------------------
// 错误可见性
// ---------------------------------------------------------------------------

test('upstream errors cannot smuggle raw text through a HANDOFF_ code or details', async () => {
  const sentinel = 'SECRET_SENTINEL /private/path Authorization: Bearer token';
  const failures = [
    { code: 'HANDOFF_HOST_ERROR', message: sentinel },
    { code: 'HANDOFF_PERMISSION_MISSING', message: sentinel },
    { code: 'HANDOFF_INVALID_CONTEXT', message: sentinel, details: { body: sentinel } },
  ];

  for (const failure of failures) {
    const { sdk } = makeSdk({ sendCustomError: failure });
    await assert.rejects(
      createHandoffHost({ sdk }).writeContext({ sessionId: 'sess-1', content: '正文', details: {} }),
      error => {
        assert.equal(error.code, 'HANDOFF_HOST_ERROR');
        assert.equal(error.message, '宿主调用失败');
        assert.doesNotMatch(error.message, /SECRET_SENTINEL/);
        assert.doesNotMatch(JSON.stringify(error.details ?? null), /SECRET_SENTINEL/);
        return true;
      },
    );
  }
});

test('host failures get a stable code without echoing the raw host message', async () => {
  // 宿主报错可能夹带正文、私有路径或凭据：只允许在内存里分类，绝不回传原文
  const sentinel = 'SecretPath-/home/user/private/report.md Bearer-sentinel-token-7f3a body-sentinel';
  const cases = [
    [new Error(`permission denied: ${sentinel}`), 'HANDOFF_PERMISSION_MISSING', '宿主拒绝了这项操作'],
    [new Error(`socket closed ${sentinel}`), 'HANDOFF_HOST_ERROR', '宿主调用失败'],
  ];

  for (const [failure, code, safeMessage] of cases) {
    const { sdk } = makeSdk({ sendCustomError: failure });
    await assert.rejects(
      createHandoffHost({ sdk }).writeContext({ sessionId: 'sess-1', content: '正文', details: {} }),
      error => {
        assert.equal(error.code, code);
        assert.equal(error.message, safeMessage);
        assert.doesNotMatch(error.message, /sentinel/i);
        assert.doesNotMatch(JSON.stringify(error.details ?? null), /sentinel/i);
        return true;
      },
    );
  }
});

test('create failures are classified without inventing a session id', async () => {
  const { sdk } = makeSdk({ createError: new Error('host unavailable') });
  await assert.rejects(createHandoffHost({ sdk }).create({ agentId: 'agent-a' }), error => {
    assert.equal(error.code, 'HANDOFF_HOST_ERROR');
    assert.equal(error.message, '宿主调用失败');
    assert.equal(error.sessionId, undefined);
    return true;
  });
});

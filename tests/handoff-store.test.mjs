import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import realFs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  createHandoffStore,
  HANDOFF_STORE_LIMITS,
  HANDOFF_STORE_ERROR_CODES as CODES,
} from '../lib/handoff-store.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-25T00:00:00.000Z');
const MINUTE = 60 * 1000;
const OWNER = 'owner-a';

function ownerKey(owner) {
  return createHash('sha256').update(owner).digest('hex');
}

function ownerRoot(dataDir, owner = OWNER) {
  return path.join(dataDir, 'handoff', ownerKey(owner));
}

function artifactMetadata(artifactId = 'a'.repeat(32), extra = {}) {
  return {
    artifactId,
    name: '文档.md',
    mime: 'text/markdown',
    bytes: 12,
    sha256: 'b'.repeat(64),
    ...extra,
  };
}

function handoffContext(extra = {}) {
  return {
    schemaVersion: 1,
    source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' },
    agentId: 'agent-a',
    nextStep: '继续处理这份交接',
    nodes: [],
    references: [],
    artifactIds: [],
    exclusions: [],
    referenceSources: [],
    omissions: { localNoticeCount: 0 },
    unsent: [],
    notices: [],
    stats: { transcriptBytes: 1234 },
    ...extra,
  };
}

async function makeDir() {
  return realFs.mkdtemp(path.join(os.tmpdir(), 'handoff-store-'));
}

function makeStore(dataDir, options = {}) {
  const clock = options.clock ?? (() => NOW);
  return createHandoffStore({ dataDir, fs: realFs, clock, ...options });
}

/** 注入式故障：在第 N 次 handle.sync() 抛 ENOSPC */
function faultyFs({ failSyncAt = Infinity, onOpen } = {}) {
  let syncs = 0;
  return new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          if (onOpen) await onOpen(...args);
          const handle = await target.open(...args);
          return {
            writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
            readFile: (...readArgs) => handle.readFile(...readArgs),
            close: () => handle.close(),
            stat: (...statArgs) => handle.stat(...statArgs),
            sync: async () => {
              syncs += 1;
              if (syncs >= failSyncAt) {
                const error = new Error('injected fsync failure');
                error.code = 'ENOSPC';
                throw error;
              }
              return handle.sync();
            },
          };
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function readRecord(dataDir, actionId, owner = OWNER) {
  return JSON.parse(await realFs.readFile(path.join(ownerRoot(dataDir, owner), 'actions', actionId, 'record.json'), 'utf8'));
}

function bigContext(bytes) {
  return handoffContext({ nextStep: 'x'.repeat(bytes) });
}

async function prepareMany(store, count, owner = OWNER) {
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    actions.push(await store.prepare({ owner, context: handoffContext() }));
  }
  return actions;
}

// ---------------------------------------------------------------------------
// 1. 基本读写、owner 隔离、路径注入、私有形状
// ---------------------------------------------------------------------------

test('prepare publishes a durable action whose payload hash and bytes match the frozen payload', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });

  assert.match(action.actionId, /^ha_[a-f0-9]{32}$/);
  assert.equal(action.state, 'prepared');
  assert.equal(action.agentId, 'agent-a');
  assert.equal(action.source.targetCardId, 'card-1');
  assert.equal(action.bytes, 1234);
  assert.equal(action.sessionId, null);
  assert.deepEqual(action.files, []);
  assert.equal(action.entryId, null);
  assert.equal(action.errorCode, null);
  assert.equal(Date.parse(action.expiresAt) - Date.parse(action.createdAt), HANDOFF_STORE_LIMITS.ttlMs);
  assert.equal(Object.hasOwn(action, 'owner'), false);
  assert.equal(Object.hasOwn(action, 'context'), false);

  const payloadBytes = await realFs.readFile(path.join(ownerRoot(dataDir), 'actions', action.actionId, 'payload.json'));
  assert.equal(action.payloadHash, createHash('sha256').update(payloadBytes).digest('hex'));
  assert.equal(Buffer.byteLength(payloadBytes), Buffer.byteLength(JSON.stringify({ context: handoffContext(), artifactMetadata: [] })));

  const got = await store.get({ owner: OWNER, actionId: action.actionId });
  assert.deepEqual(got.context, handoffContext());
  assert.deepEqual(got.artifactMetadata, []);
  assert.equal(got.action.payloadHash, action.payloadHash);

  const modes = await realFs.stat(path.join(ownerRoot(dataDir), 'actions'));
  assert.equal(modes.mode & 0o777, 0o700);
  const payloadMode = await realFs.stat(path.join(ownerRoot(dataDir), 'actions', action.actionId, 'payload.json'));
  assert.equal(payloadMode.mode & 0o777, 0o600);
});

test('owners cannot read, claim or list each other actions', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });

  assert.equal(await store.get({ owner: 'owner-b', actionId: action.actionId }), null);
  assert.deepEqual(await store.claim({ owner: 'owner-b', actionId: action.actionId }), { claimed: false, record: null });
  assert.deepEqual(await store.list({ owner: 'owner-b' }), []);
  assert.equal((await store.list({ owner: OWNER })).length, 1);
});

test('action ids are validated and cannot inject paths', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });

  for (const actionId of ['../escape', 'ha_' + 'a'.repeat(31), 'ha_' + 'a'.repeat(33), '/tmp/x', '']) {
    await assert.rejects(store.get({ owner: OWNER, actionId }), error => error.code === CODES.INVALID_ACTION_ID);
    await assert.rejects(store.claim({ owner: OWNER, actionId }), error => error.code === CODES.INVALID_ACTION_ID);
  }
});

test('artifact metadata must cover context.artifactIds exactly once and stay public', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const id = 'a'.repeat(32);

  await assert.rejects(
    store.prepare({ owner: OWNER, context: handoffContext({ artifactIds: [id] }) }),
    error => error.code === CODES.INVALID_ARTIFACT,
  );
  await assert.rejects(
    store.prepare({ owner: OWNER, context: handoffContext(), artifactMetadata: [artifactMetadata(id)] }),
    error => error.code === CODES.INVALID_ARTIFACT,
  );
  await assert.rejects(
    store.prepare({
      owner: OWNER,
      context: handoffContext({ artifactIds: [id] }),
      artifactMetadata: [artifactMetadata(id), artifactMetadata(id)],
    }),
    error => error.code === CODES.INVALID_ARTIFACT,
  );
  await assert.rejects(
    store.prepare({
      owner: OWNER,
      context: handoffContext({ artifactIds: [id] }),
      artifactMetadata: [artifactMetadata(id, { path: '/private/secret' })],
    }),
  );

  const action = await store.prepare({
    owner: OWNER,
    context: handoffContext({ artifactIds: [id] }),
    artifactMetadata: [artifactMetadata(id)],
  });
  const got = await store.get({ owner: OWNER, actionId: action.actionId });
  assert.deepEqual(got.artifactMetadata, [artifactMetadata(id)]);
  assert.equal(got.action.artifactCount, 1);
  assert.equal(got.action.artifactBytes, 12);
});

test('prepare rejects a missing owner and a context without source or stats', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);

  await assert.rejects(store.prepare({ owner: '', context: handoffContext() }), error => error.code === CODES.INVALID_OWNER);
  await assert.rejects(
    store.prepare({ owner: OWNER, context: handoffContext({ source: {} }) }),
    error => error.code === CODES.INVALID_CONTEXT,
  );
  await assert.rejects(
    store.prepare({ owner: OWNER, context: handoffContext({ stats: {} }) }),
    error => error.code === CODES.INVALID_CONTEXT,
  );
});

// ---------------------------------------------------------------------------
// 2. claim/checkpoint 的同步屏障与写权
// ---------------------------------------------------------------------------

test('claim never hands out dispatch rights when any sync barrier fails, and the marker stays', async () => {
  for (const failSyncAt of [1, 2, 3]) {
    const dataDir = await makeDir();
    const action = await makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() });
    const faulty = createHandoffStore({ dataDir, fs: faultyFs({ failSyncAt }), clock: () => NOW });

    await assert.rejects(faulty.claim({ owner: OWNER, actionId: action.actionId }), error => error.code === CODES.STORE_IO);
    assert.equal((await faulty.claim({ owner: OWNER, actionId: action.actionId })).claimed, false);
    assert.equal((await makeStore(dataDir).claim({ owner: OWNER, actionId: action.actionId })).claimed, false);
    const projected = await makeStore(dataDir).get({ owner: OWNER, actionId: action.actionId });
    assert.equal(projected.action.state, 'unknown');
  }
});

test('two stores and repeated calls can only claim once', async () => {
  const dataDir = await makeDir();
  const action = await makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() });
  const first = makeStore(dataDir);
  const second = makeStore(dataDir);

  const results = await Promise.all([
    first.claim({ owner: OWNER, actionId: action.actionId }),
    second.claim({ owner: OWNER, actionId: action.actionId }),
  ]);
  assert.equal(results.filter(result => result.claimed).length, 1);
  assert.equal((await first.claim({ owner: OWNER, actionId: action.actionId })).claimed, false);
  assert.equal((await second.claim({ owner: OWNER, actionId: action.actionId })).claimed, false);
});

test('claim asks only for prepared actions and never grants settled states', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing' });
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready' });

  assert.equal((await makeStore(dataDir).claim({ owner: OWNER, actionId: action.actionId })).claimed, false);
});

test('a foreign instance projects unknown without writing, then sees ready after the owner checkpoints', async () => {
  const dataDir = await makeDir();
  const owner = makeStore(dataDir);
  const action = await owner.prepare({ owner: OWNER, context: handoffContext() });
  await owner.claim({ owner: OWNER, actionId: action.actionId });

  const recordPath = path.join(ownerRoot(dataDir), 'actions', action.actionId, 'record.json');
  const before = await realFs.readFile(recordPath);
  const beforeStat = await realFs.stat(recordPath);

  const foreign = makeStore(dataDir);
  assert.equal((await foreign.get({ owner: OWNER, actionId: action.actionId })).action.state, 'unknown');
  assert.equal((await foreign.list({ owner: OWNER }))[0].state, 'unknown');
  assert.deepEqual(await realFs.readFile(recordPath), before);
  assert.equal((await realFs.stat(recordPath)).mtimeMs, beforeStat.mtimeMs);

  await owner.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });
  await owner.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready' });
  const after = await foreign.get({ owner: OWNER, actionId: action.actionId });
  assert.equal(after.action.state, 'ready');
  assert.equal(after.action.sessionId, 'sess-1');
  assert.equal(after.context.source.targetCardId, 'card-1');
});

test('checkpoint failures revoke local dispatch rights and keep only append-only receipts', async () => {
  const dataDir = await makeDir();
  let fail = false;
  const fs = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          const handle = await target.open(...args);
          return {
            writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
            readFile: (...readArgs) => handle.readFile(...readArgs),
            close: () => handle.close(),
            stat: (...statArgs) => handle.stat(...statArgs),
            sync: async () => {
              if (fail) {
                const error = new Error('injected failure');
                error.code = 'EIO';
                throw error;
              }
              return handle.sync();
            },
          };
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createHandoffStore({ dataDir, fs, clock: () => NOW });
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });

  fail = true;
  await assert.rejects(
    store.checkpoint({
      owner: OWNER,
      actionId: action.actionId,
      state: 'importing',
      receipt: { sessionId: 'sess-1', files: [{ fileId: 'file-1', name: 'a.md', mime: 'text/markdown', kind: 'artifact', artifactId: 'a'.repeat(32) }] },
    }),
    error => error.code === CODES.STORE_IO,
  );
  fail = false;
  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing' }),
    error => error.code === CODES.CHECKPOINT_DENIED,
  );

  const record = await readRecord(dataDir, action.actionId);
  assert.equal(record.state, 'creating');
  assert.equal(record.sessionId, null);
  assert.deepEqual(record.files, []);
});

test('checkpoint is single-writer, append-only and cannot overwrite terminal states', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });

  await assert.rejects(
    makeStore(dataDir).checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing' }),
    error => error.code === CODES.CHECKPOINT_DENIED,
  );

  await store.checkpoint({
    owner: OWNER,
    actionId: action.actionId,
    state: 'importing',
    receipt: {
      sessionId: 'sess-1',
      files: [{ fileId: 'file-1', name: 'a.md', mime: 'text/markdown', kind: 'artifact' }],
    },
  });
  const imported = await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { entryId: 'entry-1' } });
  assert.equal(imported.sessionId, 'sess-1');
  assert.equal(imported.entryId, 'entry-1');
  assert.equal(imported.files.length, 1);

  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-2' } }),
    error => error.code === CODES.INVALID_STATE,
  );
  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { entryId: 'entry-2' } }),
    error => error.code === CODES.INVALID_STATE,
  );

  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready' });
  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'creating' }),
    error => error.code === CODES.INVALID_STATE,
  );
  assert.equal((await store.get({ owner: OWNER, actionId: action.actionId })).action.state, 'ready');
});

test('create collision with an existing action marker rotates to a fresh id', async () => {
  const dataDir = await makeDir();
  const ids = ['ha_' + 'a'.repeat(32), 'ha_' + 'a'.repeat(32), 'ha_' + 'c'.repeat(32)];
  const store = makeStore(dataDir, { randomId: () => ids.shift() });

  const first = await store.prepare({ owner: OWNER, context: handoffContext() });
  const second = await store.prepare({ owner: OWNER, context: handoffContext() });
  assert.equal(first.actionId, 'ha_' + 'a'.repeat(32));
  assert.equal(second.actionId, 'ha_' + 'c'.repeat(32));
  assert.notEqual(first.actionId, second.actionId);
});

// ---------------------------------------------------------------------------
// 3. 配额：slot、字节、半写、owner 独立
// ---------------------------------------------------------------------------

test('32 slots cap the owner and concurrent prepares cannot both take the last slot', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  await prepareMany(store, 31);

  const results = await Promise.allSettled([
    store.prepare({ owner: OWNER, context: handoffContext() }),
    store.prepare({ owner: OWNER, context: handoffContext() }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, CODES.QUOTA_EXCEEDED);

  const fullDir = await makeDir();
  const full = makeStore(fullDir);
  await prepareMany(full, 32);
  await assert.rejects(full.prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.QUOTA_EXCEEDED);
});

test('reserved payload bytes never exceed 16 MiB even under concurrency', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const nineMiB = 9 * 1024 * 1024;

  await store.prepare({ owner: OWNER, context: bigContext(nineMiB) });
  await assert.rejects(
    store.prepare({ owner: OWNER, context: bigContext(nineMiB) }),
    error => error.code === CODES.QUOTA_EXCEEDED,
  );

  const concurrentDir = await makeDir();
  const concurrent = makeStore(concurrentDir);
  const results = await Promise.allSettled([
    concurrent.prepare({ owner: OWNER, context: bigContext(nineMiB) }),
    concurrent.prepare({ owner: OWNER, context: bigContext(nineMiB) }),
  ]);
  assert.ok(results.filter(result => result.status === 'fulfilled').length <= 1);

  const ownerDir = await makeDir();
  const shared = makeStore(ownerDir);
  await shared.prepare({ owner: OWNER, context: bigContext(nineMiB) });
  await shared.prepare({ owner: 'owner-b', context: bigContext(nineMiB) });
});

test('a half-written slot reservation fails closed instead of being ignored', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const slots = path.join(ownerRoot(dataDir), 'slots', '7');
  await realFs.mkdir(slots, { recursive: true, mode: 0o700 });
  await realFs.writeFile(path.join(slots, 'pending.json'), '{"actionId":', { encoding: 'utf8', mode: 0o600 });

  await assert.rejects(store.prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_CORRUPT);
});

// ---------------------------------------------------------------------------
// 4. TTL 与回收
// ---------------------------------------------------------------------------

test('expired prepared actions are retired, their slots freed, and their ids stay unusable', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const expired = await store.prepare({ owner: OWNER, context: handoffContext() });

  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;
  const fresh = await store.prepare({ owner: OWNER, context: handoffContext() });

  assert.equal(await store.get({ owner: OWNER, actionId: expired.actionId }), null);
  assert.equal((await store.claim({ owner: OWNER, actionId: expired.actionId })).claimed, false);
  assert.ok(fresh.actionId);
});

test('creating, importing, unknown and partial actions survive TTL', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });

  const creating = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: creating.actionId });

  const importing = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: importing.actionId });
  await store.checkpoint({ owner: OWNER, actionId: importing.actionId, state: 'importing' });

  const unknown = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: unknown.actionId });
  await store.checkpoint({ owner: OWNER, actionId: unknown.actionId, state: 'unknown' });

  const partial = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: partial.actionId });
  await store.checkpoint({ owner: OWNER, actionId: partial.actionId, state: 'partial' });

  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;
  await store.prepare({ owner: OWNER, context: handoffContext() });

  for (const action of [creating, importing, unknown, partial]) {
    const got = await store.get({ owner: OWNER, actionId: action.actionId });
    assert.ok(got, `${action.actionId} 不应被回收`);
    assert.ok(got.context);
  }
  assert.equal((await store.get({ owner: OWNER, actionId: unknown.actionId })).action.state, 'unknown');
});

test('ready and failed payloads are reclaimed but the action stays readable and blocked from retry', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const ready = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: ready.actionId });
  await store.checkpoint({ owner: OWNER, actionId: ready.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });
  await store.checkpoint({ owner: OWNER, actionId: ready.actionId, state: 'ready', receipt: { entryId: 'entry-1' } });

  const failed = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: failed.actionId });
  await store.checkpoint({ owner: OWNER, actionId: failed.actionId, state: 'failed', receipt: { errorCode: 'HANDOFF_STAGE_FAILED' } });

  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;
  await store.prepare({ owner: OWNER, context: handoffContext() });

  const readyGot = await store.get({ owner: OWNER, actionId: ready.actionId });
  assert.equal(readyGot.action.state, 'ready');
  assert.equal(readyGot.action.sessionId, 'sess-1');
  assert.equal(readyGot.context, null);
  assert.deepEqual(readyGot.artifactMetadata, []);
  assert.equal((await store.claim({ owner: OWNER, actionId: ready.actionId })).claimed, false);

  const failedGot = await store.get({ owner: OWNER, actionId: failed.actionId });
  assert.equal(failedGot.action.state, 'failed');
  assert.equal(failedGot.action.errorCode, 'HANDOFF_STAGE_FAILED');
  assert.equal(failedGot.context, null);

  const claimPath = path.join(ownerRoot(dataDir), 'actions', ready.actionId, 'dispatch.decision');
  assert.ok((await realFs.stat(claimPath)).isFile(), '防重标记必须保留');
});

test('many ready actions do not permanently consume the 32-slot quota', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const actions = await prepareMany(store, 32);
  for (const action of actions) {
    await store.claim({ owner: OWNER, actionId: action.actionId });
    await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready' });
  }

  // ready 已完成，本地准备数据可以安全回收，不能让成功动作永久占满 32 个 slot
  const next = await store.prepare({ owner: OWNER, context: handoffContext() });
  assert.ok(next.actionId);
  const first = await store.get({ owner: OWNER, actionId: actions[0].actionId });
  assert.equal(first.action.state, 'ready');
  assert.equal(first.context, null);

  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;
  await store.prepare({ owner: OWNER, context: handoffContext() });
  assert.equal((await store.get({ owner: OWNER, actionId: actions[0].actionId })).action.state, 'ready');
});

// ---------------------------------------------------------------------------
// 5. TTL 与暂停 writer / claim 的竞争
// ---------------------------------------------------------------------------

test('a writer paused across TTL cannot publish after TTL retires its reservation', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  let releaseGate;
  let gateReached;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const reached = new Promise(resolve => { gateReached = resolve; });
  const gated = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          if (String(args[0]).endsWith('publish.decision') && args[1] === 'wx') {
            gateReached();
            await gate;
          }
          return target.open(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const writer = createHandoffStore({ dataDir, fs: gated, clock: () => now });
  const pending = writer.prepare({ owner: OWNER, context: handoffContext() });
  await reached;
  const pausedIds = await realFs.readdir(path.join(ownerRoot(dataDir), 'actions'));
  assert.equal(pausedIds.length, 1);
  const pausedId = pausedIds[0];

  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;
  const sweeper = makeStore(dataDir, { clock: () => now });
  const other = await sweeper.prepare({ owner: OWNER, context: handoffContext() });
  assert.ok(other.actionId);

  releaseGate();
  await assert.rejects(pending, error => error.code === CODES.DECISION_LOST);
  assert.equal(await sweeper.get({ owner: OWNER, actionId: pausedId }), null);
  assert.equal((await sweeper.claim({ owner: OWNER, actionId: pausedId })).claimed, false);
  const remaining = await sweeper.list({ owner: OWNER });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].actionId, other.actionId);
});

test('claim beating retire keeps the action; retire beating claim never resurrects it', async () => {
  for (let round = 0; round < 3; round += 1) {
    const dataDir = await makeDir();
    let now = NOW;
    const setup = makeStore(dataDir, { clock: () => now });
    const action = await setup.prepare({ owner: OWNER, context: handoffContext() });
    now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;

    const claimer = makeStore(dataDir, { clock: () => now });
    const sweeper = makeStore(dataDir, { clock: () => now });
    const [claimResult] = await Promise.all([
      claimer.claim({ owner: OWNER, actionId: action.actionId }),
      sweeper.prepare({ owner: OWNER, context: handoffContext() }).catch(() => null),
    ]);

    if (claimResult.claimed) {
      const got = await claimer.get({ owner: OWNER, actionId: action.actionId });
      assert.ok(got, 'claim 胜出时动作必须仍存在');
      assert.notEqual(got.action.state, 'unknown');
    } else {
      const got = await claimer.get({ owner: OWNER, actionId: action.actionId });
      assert.ok(got === null || got.action.state !== 'ready');
    }
  }
});

test('slot cleanup never deletes a reservation already reused by a newer action', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const old = await store.prepare({ owner: OWNER, context: handoffContext() });
  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;
  await store.prepare({ owner: OWNER, context: handoffContext() });
  assert.equal(await store.get({ owner: OWNER, actionId: old.actionId }), null);

  const fresh = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.prepare({ owner: OWNER, context: handoffContext() });
  const slots = await realFs.readdir(path.join(ownerRoot(dataDir), 'slots'));
  let found = false;
  for (const slot of slots) {
    const names = await realFs.readdir(path.join(ownerRoot(dataDir), 'slots', slot));
    if (names.includes(`${fresh.actionId}.json`)) found = true;
  }
  assert.equal(found, true);
  assert.ok(await store.get({ owner: OWNER, actionId: fresh.actionId }));
});

// ---------------------------------------------------------------------------
// 6. 正文与记录损坏
// ---------------------------------------------------------------------------

test('a corrupted payload is refused by get and claim', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  const payloadPath = path.join(ownerRoot(dataDir), 'actions', action.actionId, 'payload.json');
  const original = await realFs.readFile(payloadPath);
  await realFs.writeFile(payloadPath, Buffer.concat([original, Buffer.from(' ')]), { mode: 0o600 });

  await assert.rejects(store.get({ owner: OWNER, actionId: action.actionId }), error => error.code === CODES.PAYLOAD_CORRUPT);
  await assert.rejects(store.claim({ owner: OWNER, actionId: action.actionId }), error => error.code === CODES.PAYLOAD_CORRUPT);
});

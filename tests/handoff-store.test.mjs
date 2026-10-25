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

const ARCHIVE_FILE = { fileId: 'file-archive', name: '交接.md', mime: 'text/markdown', kind: 'archive' };

function artifactFile(artifactId, fileId = 'file-1') {
  return { fileId, name: '文档.md', mime: 'text/markdown', kind: 'artifact', artifactId };
}

/** 走真实状态机完成一个 ready 动作：importing 需要 session，ready 需要 entry + 归档 */
async function completeReady(store, action, { sessionId = 'sess-1', entryId = 'entry-1', artifactIds = [] } = {}) {
  await store.claim({ owner: OWNER, actionId: action.actionId });
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId } });
  await store.checkpoint({
    owner: OWNER,
    actionId: action.actionId,
    state: 'ready',
    receipt: {
      entryId,
      files: [...artifactIds.map((artifactId, index) => artifactFile(artifactId, `file-${index + 1}`)), ARCHIVE_FILE],
    },
  });
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
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready', receipt: { entryId: 'entry-1', files: [ARCHIVE_FILE] } });

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
  await owner.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready', receipt: { entryId: 'entry-1', files: [ARCHIVE_FILE] } });
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
      receipt: { sessionId: 'sess-1', files: [ARCHIVE_FILE] },
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
      files: [ARCHIVE_FILE],
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
  await store.checkpoint({ owner: OWNER, actionId: importing.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });

  const unknown = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: unknown.actionId });
  await store.checkpoint({ owner: OWNER, actionId: unknown.actionId, state: 'unknown' });

  const partial = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: partial.actionId });
  await store.checkpoint({ owner: OWNER, actionId: partial.actionId, state: 'partial', receipt: { sessionId: 'sess-1' } });

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
  await store.checkpoint({ owner: OWNER, actionId: ready.actionId, state: 'ready', receipt: { entryId: 'entry-1', files: [ARCHIVE_FILE] } });

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
    await completeReady(store, action);
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
    const [claimSettled] = await Promise.allSettled([
      claimer.claim({ owner: OWNER, actionId: action.actionId }),
      sweeper.prepare({ owner: OWNER, context: handoffContext() }).catch(() => null),
    ]);

    if (claimSettled.status === 'rejected') {
      assert.equal(claimSettled.reason.code, CODES.ACTION_EXPIRED);
      assert.equal(await claimer.get({ owner: OWNER, actionId: action.actionId }), null);
      continue;
    }
    const claimResult = claimSettled.value;
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

// ---------------------------------------------------------------------------
// 7. C1：ready 的真实前置条件与记录守卫
// ---------------------------------------------------------------------------

test('ready can only be reached from importing and needs session, entry and one archive', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });

  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready' }),
    error => error.code === CODES.INVALID_STATE,
  );
  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing' }),
    error => error.code === CODES.INVALID_STATE,
  );
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });

  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready', receipt: { files: [ARCHIVE_FILE] } }),
    error => error.code === CODES.INVALID_STATE,
  );
  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready', receipt: { entryId: 'entry-1' } }),
    error => error.code === CODES.INVALID_STATE,
  );
  const ready = await store.checkpoint({
    owner: OWNER,
    actionId: action.actionId,
    state: 'ready',
    receipt: { entryId: 'entry-1', files: [ARCHIVE_FILE] },
  });
  assert.equal(ready.state, 'ready');
});

test('ready requires every frozen artifact exactly once and rejects foreign artifacts', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const artifactId = 'a'.repeat(32);
  const action = await store.prepare({
    owner: OWNER,
    context: handoffContext({ artifactIds: [artifactId] }),
    artifactMetadata: [artifactMetadata(artifactId)],
  });
  await store.claim({ owner: OWNER, actionId: action.actionId });
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });

  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready', receipt: { entryId: 'entry-1', files: [ARCHIVE_FILE] } }),
    error => error.code === CODES.INVALID_STATE,
  );
  await assert.rejects(
    store.checkpoint({
      owner: OWNER,
      actionId: action.actionId,
      state: 'ready',
      receipt: { entryId: 'entry-1', files: [artifactFile('b'.repeat(32), 'file-x'), ARCHIVE_FILE] },
    }),
    error => error.code === CODES.INVALID_STATE,
  );

  const ready = await store.checkpoint({
    owner: OWNER,
    actionId: action.actionId,
    state: 'ready',
    receipt: { entryId: 'entry-1', files: [artifactFile(artifactId), ARCHIVE_FILE] },
  });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.files.map(file => file.kind), ['artifact', 'archive']);
});

test('a record cannot claim ready on disk without session, entry, artifacts and archive', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });

  const recordPath = path.join(ownerRoot(dataDir), 'actions', action.actionId, 'record.json');
  const record = JSON.parse(await realFs.readFile(recordPath, 'utf8'));
  await realFs.writeFile(recordPath, JSON.stringify({ ...record, state: 'ready' }), { mode: 0o600 });

  await assert.rejects(store.get({ owner: OWNER, actionId: action.actionId }), error => error.code === CODES.STORE_CORRUPT);
});

test('failed is refused once host side effects are known; partial needs a known side effect', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });

  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'partial' }),
    error => error.code === CODES.INVALID_STATE,
  );

  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });
  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'failed', receipt: { errorCode: 'HANDOFF_STAGE_FAILED' } }),
    error => error.code === CODES.INVALID_STATE,
  );
  const partial = await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'partial', receipt: { errorCode: 'HANDOFF_STAGE_FAILED' } });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.sessionId, 'sess-1');
});

// ---------------------------------------------------------------------------
// 8. I1：过期 claim
// ---------------------------------------------------------------------------

test('claim refuses an expired prepared action and retires it without a new prepare', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;

  await assert.rejects(
    store.claim({ owner: OWNER, actionId: action.actionId }),
    error => error.code === CODES.ACTION_EXPIRED,
  );
  assert.equal(await store.get({ owner: OWNER, actionId: action.actionId }), null);
  assert.deepEqual(await store.list({ owner: OWNER }), []);
});

test('claim already in progress is not retired by TTL', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });
  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;

  assert.equal((await store.claim({ owner: OWNER, actionId: action.actionId })).claimed, false);
  await store.prepare({ owner: OWNER, context: handoffContext() });
  const got = await store.get({ owner: OWNER, actionId: action.actionId });
  assert.equal(got.action.state, 'creating');
});

// ---------------------------------------------------------------------------
// 9. I2：nonce 按 owner 隔离，最终读取失败不留权
// ---------------------------------------------------------------------------

test('the same action id under two owners keeps separate checkpoint authority', async () => {
  const dataDir = await makeDir();
  const fixedId = 'ha_' + 'a'.repeat(32);
  const store = createHandoffStore({ dataDir, fs: realFs, clock: () => NOW, randomId: () => fixedId });
  const actionA = await store.prepare({ owner: 'owner-a', context: handoffContext() });
  const actionB = await store.prepare({ owner: 'owner-b', context: handoffContext() });
  assert.equal(actionA.actionId, actionB.actionId);

  assert.equal((await store.claim({ owner: 'owner-a', actionId: fixedId })).claimed, true);
  assert.equal((await store.claim({ owner: 'owner-b', actionId: fixedId })).claimed, true);
  await store.checkpoint({ owner: 'owner-a', actionId: fixedId, state: 'importing', receipt: { sessionId: 'sess-a' } });
  await store.checkpoint({ owner: 'owner-b', actionId: fixedId, state: 'importing', receipt: { sessionId: 'sess-b' } });
});

test('a failed final payload read after claiming does not leave local dispatch authority', async () => {
  const dataDir = await makeDir();
  const prepared = await makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() });
  let payloadOpens = 0;
  const fs = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          if (String(args[0]).endsWith('payload.json')) {
            payloadOpens += 1;
            if (payloadOpens === 2) {
              const error = new Error('final read failed');
              error.code = 'EIO';
              throw error;
            }
          }
          return target.open(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createHandoffStore({ dataDir, fs, clock: () => NOW });

  await assert.rejects(store.claim({ owner: OWNER, actionId: prepared.actionId }), error => error.code === CODES.STORE_IO);
  await assert.rejects(
    store.checkpoint({ owner: OWNER, actionId: prepared.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } }),
    error => error.code === CODES.CHECKPOINT_DENIED,
  );
  assert.equal((await makeStore(dataDir).claim({ owner: OWNER, actionId: prepared.actionId })).claimed, false);
});

// ---------------------------------------------------------------------------
// 10. I3：17 文件边界
// ---------------------------------------------------------------------------

test('16 artifacts plus one archive can be delivered in one batch or incrementally', async () => {
  const dataDir = await makeDir();
  const ids = Array.from({ length: 16 }, (_, index) => String(index).padStart(2, '0').repeat(16));
  const store = makeStore(dataDir);
  const context = handoffContext({ artifactIds: ids });
  const metadata = ids.map(id => artifactMetadata(id));

  const batch = await store.prepare({ owner: OWNER, context, artifactMetadata: metadata });
  await store.claim({ owner: OWNER, actionId: batch.actionId });
  await store.checkpoint({ owner: OWNER, actionId: batch.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });
  const ready = await store.checkpoint({
    owner: OWNER,
    actionId: batch.actionId,
    state: 'ready',
    receipt: { entryId: 'entry-1', files: [...ids.map((id, index) => artifactFile(id, `file-${index}`)), ARCHIVE_FILE] },
  });
  assert.equal(ready.files.length, 17);
  assert.equal(ready.artifactCount, 16);

  const incremental = await store.prepare({ owner: OWNER, context, artifactMetadata: metadata });
  await store.claim({ owner: OWNER, actionId: incremental.actionId });
  await store.checkpoint({ owner: OWNER, actionId: incremental.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });
  await store.checkpoint({
    owner: OWNER,
    actionId: incremental.actionId,
    state: 'importing',
    receipt: { files: ids.map((id, index) => artifactFile(id, `file-${index}`)) },
  });
  const incrementalReady = await store.checkpoint({
    owner: OWNER,
    actionId: incremental.actionId,
    state: 'ready',
    receipt: { entryId: 'entry-1', files: [ARCHIVE_FILE] },
  });
  assert.equal(incrementalReady.files.length, 17);
});

test('duplicate artifacts, several archives and files beyond 17 are refused', async () => {
  const dataDir = await makeDir();
  const id = 'a'.repeat(32);
  const store = makeStore(dataDir);
  const action = await store.prepare({
    owner: OWNER,
    context: handoffContext({ artifactIds: [id] }),
    artifactMetadata: [artifactMetadata(id)],
  });
  await store.claim({ owner: OWNER, actionId: action.actionId });
  await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });

  const tooMany = Array.from({ length: 17 }, (_, index) => ({ fileId: `extra-${index}`, name: 'x.md', mime: 'text/markdown', kind: 'archive' }));
  const cases = [
    [artifactFile(id, 'file-1'), artifactFile(id, 'file-2'), ARCHIVE_FILE],
    [artifactFile(id, 'file-1'), ARCHIVE_FILE, { ...ARCHIVE_FILE, fileId: 'file-archive-2' }],
    [artifactFile(id, 'file-1'), ARCHIVE_FILE, ...tooMany],
  ];
  for (const files of cases) {
    await assert.rejects(
      store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready', receipt: { entryId: 'entry-1', files } }),
      error => error.code === CODES.INVALID_STATE,
    );
  }
});

// ---------------------------------------------------------------------------
// 11. I5 / I6 / Minor：删除同步、最终符号链接、slot 结构
// ---------------------------------------------------------------------------

function faultyDirSync(match) {
  return new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          const handle = await target.open(...args);
          const filePath = String(args[0]);
          return {
            writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
            readFile: (...readArgs) => handle.readFile(...readArgs),
            close: () => handle.close(),
            stat: (...statArgs) => handle.stat(...statArgs),
            sync: async () => {
              if (filePath.includes(match)) {
                const error = new Error('injected dir fsync failure');
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
}

test('a failed slot-directory sync during TTL retire is reported, not swallowed', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  await store.prepare({ owner: OWNER, context: handoffContext() });
  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;

  const faulty = createHandoffStore({ dataDir, fs: faultyDirSync('/slots/'), clock: () => now });
  await assert.rejects(faulty.prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_IO);
});

test('a failed action-directory sync after reclaiming a ready payload is reported', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await completeReady(store, action);
  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;

  const faulty = createHandoffStore({ dataDir, fs: faultyDirSync('/actions/'), clock: () => now });
  await assert.rejects(faulty.prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_IO);
});

test('a symlinked payload is refused instead of followed', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  const payloadPath = path.join(ownerRoot(dataDir), 'actions', action.actionId, 'payload.json');
  const outside = path.join(dataDir, 'outside.json');
  await realFs.writeFile(outside, '{"context":{}}', { mode: 0o600 });
  await realFs.unlink(payloadPath);
  await realFs.symlink(outside, payloadPath);

  await assert.rejects(store.get({ owner: OWNER, actionId: action.actionId }), error => error.code === CODES.STORE_CORRUPT);
});

test('slot names outside 0..31 and nested entries fail closed', async () => {
  const badIndexDir = await makeDir();
  const slots99 = path.join(ownerRoot(badIndexDir), 'slots', '99');
  await realFs.mkdir(slots99, { recursive: true, mode: 0o700 });
  await realFs.writeFile(
    path.join(slots99, 'ha_' + 'a'.repeat(32) + '.json'),
    JSON.stringify({ actionId: 'ha_' + 'a'.repeat(32), payloadBytes: 1, createdAt: new Date(NOW).toISOString() }),
    { mode: 0o600 },
  );
  await assert.rejects(makeStore(badIndexDir).prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_CORRUPT);

  const nestedDir = await makeDir();
  const slot0 = path.join(ownerRoot(nestedDir), 'slots', '0');
  const nestedId = 'ha_' + 'b'.repeat(32);
  await realFs.mkdir(slot0, { recursive: true, mode: 0o700 });
  await realFs.writeFile(
    path.join(slot0, nestedId + '.json'),
    JSON.stringify({ actionId: nestedId, payloadBytes: 1, createdAt: new Date(NOW).toISOString() }),
    { mode: 0o600 },
  );
  await realFs.mkdir(path.join(slot0, 'nested'), { mode: 0o700 });
  await assert.rejects(makeStore(nestedDir).prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_CORRUPT);
});

// ---------------------------------------------------------------------------
// 12. fix2 I5：未发布清理失败必须可见，可信墓碑可续次恢复
// ---------------------------------------------------------------------------

test('prepare reports a cleanup failure instead of swallowing unlink errors as a clean abort', async () => {
  const dataDir = await makeDir();
  let unlinkAttempts = 0;
  const fs = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          if (String(args[0]).endsWith('publish.decision') && args[1] === 'wx') {
            const error = new Error('injected publish failure');
            error.code = 'EIO';
            throw error;
          }
          return target.open(...args);
        };
      }
      if (prop === 'unlink') {
        return async filePath => {
          if (String(filePath).endsWith('payload.json')) {
            unlinkAttempts += 1;
            const error = new Error('injected unlink failure');
            error.code = 'EACCES';
            throw error;
          }
          return target.unlink(filePath);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createHandoffStore({ dataDir, fs, clock: () => NOW });

  await assert.rejects(store.prepare({ owner: OWNER, context: handoffContext() }), error => {
    assert.equal(error.code, CODES.STORE_IO);
    // 命中注入点：清理失败必须是错误原因，不能被当成已清完
    assert.equal(error.cause?.code, 'EACCES');
    return true;
  });
  assert.equal(unlinkAttempts, 1);

  const actionIds = await realFs.readdir(path.join(ownerRoot(dataDir), 'actions'));
  assert.equal(actionIds.length, 1);
  assert.equal((await realFs.lstat(path.join(ownerRoot(dataDir), 'actions', actionIds[0], 'payload.json'))).isFile(), true);
  const slots = await realFs.readdir(path.join(ownerRoot(dataDir), 'slots'));
  let reserved = false;
  for (const slot of slots) {
    const names = await realFs.readdir(path.join(ownerRoot(dataDir), 'slots', slot));
    if (names.includes(`${actionIds[0]}.json`)) reserved = true;
  }
  assert.equal(reserved, true, '清理失败时必须留下可恢复的预约');
});

test('a failed slot release after dispatch-retire is recovered by the next sweep', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;

  const faulty = createHandoffStore({ dataDir, fs: faultyDirSync('/slots/'), clock: () => now });
  await assert.rejects(faulty.claim({ owner: OWNER, actionId: action.actionId }), error => error.code === CODES.STORE_IO);

  const tombstone = path.join(ownerRoot(dataDir), 'actions', action.actionId);
  await assert.rejects(realFs.lstat(path.join(tombstone, 'record.json')), error => error.code === 'ENOENT');
  assert.equal(await realFs.readFile(path.join(tombstone, 'dispatch.decision'), 'utf8'), 'retire');

  await makeStore(dataDir, { clock: () => now }).prepare({ owner: OWNER, context: handoffContext() });
  const slots = await realFs.readdir(path.join(ownerRoot(dataDir), 'slots'));
  const reservedIds = [];
  for (const slot of slots) {
    for (const name of await realFs.readdir(path.join(ownerRoot(dataDir), 'slots', slot))) reservedIds.push(name.replace(/\.json$/, ''));
  }
  assert.equal(reservedIds.includes(action.actionId), false, '可信 retire 墓碑应被续次清理并释放旧 slot');
});

test('a trusted publish-retire tombstone is cleaned and its slot released on the next sweep', async () => {
  const dataDir = await makeDir();
  const actionId = 'ha_' + 'd'.repeat(32);
  const root = ownerRoot(dataDir);
  const slotDir = path.join(root, 'slots', '0');
  const actionDir = path.join(root, 'actions', actionId);
  await realFs.mkdir(slotDir, { recursive: true, mode: 0o700 });
  await realFs.mkdir(actionDir, { recursive: true, mode: 0o700 });
  await realFs.writeFile(
    path.join(slotDir, `${actionId}.json`),
    JSON.stringify({ actionId, payloadBytes: 10, createdAt: new Date(NOW).toISOString() }),
    { mode: 0o600 },
  );
  await realFs.writeFile(path.join(actionDir, 'payload.json'), 'payload', { mode: 0o600 });
  await realFs.writeFile(path.join(actionDir, 'record.json'), '{}', { mode: 0o600 });
  await realFs.writeFile(path.join(actionDir, 'publish.decision'), 'retire', { mode: 0o600 });

  await makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() });
  await assert.rejects(realFs.lstat(path.join(actionDir, 'payload.json')), error => error.code === 'ENOENT');
  await assert.rejects(realFs.lstat(path.join(actionDir, 'record.json')), error => error.code === 'ENOENT');
  assert.equal(await realFs.readFile(path.join(actionDir, 'publish.decision'), 'utf8'), 'retire');
  const slots = await realFs.readdir(path.join(root, 'slots'));
  let oldReserved = false;
  for (const slot of slots) {
    if ((await realFs.readdir(path.join(root, 'slots', slot))).includes(`${actionId}.json`)) oldReserved = true;
  }
  assert.equal(oldReserved, false);
});

test('an unreadable decision is not treated as unpublished and keeps payload and slot', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  const publishPath = path.join(ownerRoot(dataDir), 'actions', action.actionId, 'publish.decision');
  await realFs.chmod(publishPath, 0o000);
  try {
    await assert.rejects(makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_IO);
    assert.equal((await realFs.lstat(path.join(ownerRoot(dataDir), 'actions', action.actionId, 'payload.json'))).isFile(), true);
    const slots = await realFs.readdir(path.join(ownerRoot(dataDir), 'slots'));
    let reserved = false;
    for (const slot of slots) {
      if ((await realFs.readdir(path.join(ownerRoot(dataDir), 'slots', slot))).includes(`${action.actionId}.json`)) reserved = true;
    }
    assert.equal(reserved, true);
  } finally {
    await realFs.chmod(publishPath, 0o600);
  }
  assert.ok(await store.get({ owner: OWNER, actionId: action.actionId }));
});

// ---------------------------------------------------------------------------
// 13. fix2 I7：坏时间字段与可跨 TTL 的合法确认
// ---------------------------------------------------------------------------

async function tamperRecord(dataDir, actionId, mutate) {
  const recordPath = path.join(ownerRoot(dataDir), 'actions', actionId, 'record.json');
  const record = JSON.parse(await realFs.readFile(recordPath, 'utf8'));
  mutate(record);
  await realFs.writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
}

const BAD_TIME_CASES = [
  record => { delete record.expiresAt; },
  record => { record.expiresAt = 'NaN'; },
  record => { record.expiresAt = 'not-a-date'; },
  record => { record.expiresAt = 1700000000000; },
  record => { record.updatedAt = '2020-01-01T00:00:00.000Z'; record.createdAt = '2021-01-01T00:00:00.000Z'; },
  record => { record.expiresAt = record.createdAt; },
  record => { record.createdAt = 'garbage'; },
];

test('corrupt time fields cannot be read as a trusted action or bypass claim expiry', async () => {
  for (const [index, mutate] of BAD_TIME_CASES.entries()) {
    const dataDir = await makeDir();
    const store = makeStore(dataDir);
    const action = await store.prepare({ owner: OWNER, context: handoffContext() });
    await tamperRecord(dataDir, action.actionId, mutate);

    await assert.rejects(store.get({ owner: OWNER, actionId: action.actionId }), error => {
      assert.equal(error.code, CODES.STORE_CORRUPT, `case ${index}`);
      return true;
    });
    await assert.rejects(store.claim({ owner: OWNER, actionId: action.actionId }), error => error.code === CODES.STORE_CORRUPT);
  }
});

test('a claim can finish after TTL and a rewound clock cannot write updatedAt backwards', async () => {
  const dataDir = await makeDir();
  let now = NOW;
  const store = makeStore(dataDir, { clock: () => now });
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  await store.claim({ owner: OWNER, actionId: action.actionId });

  now += HANDOFF_STORE_LIMITS.ttlMs + MINUTE;
  const imported = await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { sessionId: 'sess-1' } });
  assert.ok(imported.updatedAt > action.expiresAt);

  now = NOW;
  const again = await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'importing', receipt: { files: [ARCHIVE_FILE] } });
  assert.ok(again.updatedAt >= imported.updatedAt, '回拨时钟时 updatedAt 不能倒退');
  const ready = await store.checkpoint({ owner: OWNER, actionId: action.actionId, state: 'ready', receipt: { entryId: 'entry-1' } });
  assert.equal(ready.state, 'ready');
});

// ---------------------------------------------------------------------------
// 14. fix3 I5：P/D decision 矩阵与完整清理故障
// ---------------------------------------------------------------------------

async function seedTombstone(dataDir, { actionId, publish, dispatch, withRecord = true }) {
  const root = ownerRoot(dataDir);
  const slotDir = path.join(root, 'slots', '0');
  const actionDir = path.join(root, 'actions', actionId);
  await realFs.mkdir(slotDir, { recursive: true, mode: 0o700 });
  await realFs.mkdir(actionDir, { recursive: true, mode: 0o700 });
  await realFs.writeFile(
    path.join(slotDir, `${actionId}.json`),
    JSON.stringify({ actionId, payloadBytes: 10, createdAt: new Date(NOW).toISOString() }),
    { mode: 0o600 },
  );
  await realFs.writeFile(path.join(actionDir, 'payload.json'), 'payload', { mode: 0o600 });
  if (withRecord) await realFs.writeFile(path.join(actionDir, 'record.json'), '{}', { mode: 0o600 });
  if (publish !== null) await realFs.writeFile(path.join(actionDir, 'publish.decision'), publish, { mode: 0o600 });
  if (dispatch !== null) await realFs.writeFile(path.join(actionDir, 'dispatch.decision'), dispatch, { mode: 0o600 });
  return actionDir;
}

async function slotHasAction(dataDir, actionId) {
  for (const slot of await realFs.readdir(path.join(ownerRoot(dataDir), 'slots'))) {
    if ((await realFs.readdir(path.join(ownerRoot(dataDir), 'slots', slot))).includes(`${actionId}.json`)) return true;
  }
  return false;
}

test('an unknown publish decision keeps payload, record and slot instead of being cleaned as unpublished', async () => {
  const dataDir = await makeDir();
  let written = 0;
  const fs = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          if (String(args[0]).endsWith('publish.decision') && args[1] === 'wx') {
            await target.writeFile(args[0], 'garbage', { mode: 0o600 });
            written += 1;
            const error = new Error('injected publish failure');
            error.code = 'EIO';
            throw error;
          }
          return target.open(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createHandoffStore({ dataDir, fs, clock: () => NOW });

  await assert.rejects(store.prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_IO);
  assert.equal(written, 1);
  const [actionId] = await realFs.readdir(path.join(ownerRoot(dataDir), 'actions'));
  assert.equal(await realFs.readFile(path.join(ownerRoot(dataDir), 'actions', actionId, 'publish.decision'), 'utf8'), 'garbage');
  assert.equal((await realFs.lstat(path.join(ownerRoot(dataDir), 'actions', actionId, 'payload.json'))).isFile(), true);
  assert.equal((await realFs.lstat(path.join(ownerRoot(dataDir), 'actions', actionId, 'record.json'))).isFile(), true);
  assert.equal(await slotHasAction(dataDir, actionId), true);
});

test('publish-retire with a claim or unknown dispatch preserves data and slot, with or without record', async () => {
  const cases = [
    { dispatch: JSON.stringify({ decision: 'claim', nonce: 'n1', claimedAt: new Date(NOW).toISOString() }), withRecord: true },
    { dispatch: JSON.stringify({ decision: 'claim', nonce: 'n1', claimedAt: new Date(NOW).toISOString() }), withRecord: false },
    { dispatch: 'garbage', withRecord: true },
    { dispatch: 'garbage', withRecord: false },
  ];
  for (const [index, item] of cases.entries()) {
    const dataDir = await makeDir();
    const actionId = `ha_${String(index).repeat(32)}`;
    const actionDir = await seedTombstone(dataDir, {
      actionId,
      publish: 'retire',
      dispatch: item.dispatch,
      withRecord: item.withRecord,
    });

    await makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() });
    assert.equal((await realFs.lstat(path.join(actionDir, 'payload.json'))).isFile(), true, `case ${index} payload 应保留`);
    assert.equal(await slotHasAction(dataDir, actionId), true, `case ${index} slot 应保留`);
  }
});

test('publish-retire with no dispatch or retire recovers and releases only the exact slot', async () => {
  for (const dispatch of [null, 'retire']) {
    const dataDir = await makeDir();
    const actionId = 'ha_' + 'e'.repeat(32);
    const actionDir = await seedTombstone(dataDir, { actionId, publish: 'retire', dispatch });
    await makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() });
    await assert.rejects(realFs.lstat(path.join(actionDir, 'payload.json')), error => error.code === 'ENOENT');
    assert.equal(await slotHasAction(dataDir, actionId), false);
  }
});

test('a failed reservation-sync cleanup reports the injected unlink cause and keeps the reservation', async () => {
  const dataDir = await makeDir();
  const fs = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'open') {
        return async (...args) => {
          const handle = await target.open(...args);
          const filePath = String(args[0]);
          return {
            writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
            readFile: (...readArgs) => handle.readFile(...readArgs),
            close: () => handle.close(),
            stat: (...statArgs) => handle.stat(...statArgs),
            sync: async () => {
              if (filePath.endsWith('/slots')) {
                const error = new Error('injected slot dir sync failure');
                error.code = 'EIO';
                throw error;
              }
              return handle.sync();
            },
          };
        };
      }
      if (prop === 'unlink') {
        return async filePath => {
          if (String(filePath).includes('/slots/') && String(filePath).endsWith('.json')) {
            const error = new Error('injected unlink failure');
            error.code = 'EACCES';
            throw error;
          }
          return target.unlink(filePath);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  await assert.rejects(
    createHandoffStore({ dataDir, fs, clock: () => NOW }).prepare({ owner: OWNER, context: handoffContext() }),
    error => {
      assert.equal(error.code, CODES.STORE_IO);
      assert.equal(error.cause?.code, 'EACCES');
      return true;
    },
  );
  const slots = await realFs.readdir(path.join(ownerRoot(dataDir), 'slots'));
  assert.ok(slots.length > 0, '清理失败必须保留 slot 预约供恢复');
});

test('discard directory-sync and rmdir failures are observed and keep the reservation', async () => {
  for (const mode of ['action-sync', 'parent-sync']) {
    const dataDir = await makeDir();
    const fs = new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'open') {
          return async (...args) => {
            const filePath = String(args[0]);
            if (filePath.endsWith('publish.decision') && args[1] === 'wx') {
              const error = new Error('injected publish failure');
              error.code = 'EIO';
              throw error;
            }
            const handle = await target.open(...args);
            return {
              writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
              readFile: (...readArgs) => handle.readFile(...readArgs),
              close: () => handle.close(),
              stat: (...statArgs) => handle.stat(...statArgs),
              sync: async () => {
                const shouldFail = mode === 'action-sync'
                  ? filePath.includes('/actions/')
                  : filePath.endsWith('/actions');
                if (shouldFail) {
                  const error = new Error(`injected ${mode} failure`);
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

    await assert.rejects(
      createHandoffStore({ dataDir, fs, clock: () => NOW }).prepare({ owner: OWNER, context: handoffContext() }),
      error => {
        assert.equal(error.code, CODES.STORE_IO);
        assert.equal(error.cause?.code, 'EIO', mode);
        return true;
      },
    );
    const reservedIds = [];
    for (const slot of await realFs.readdir(path.join(ownerRoot(dataDir), 'slots'))) {
      for (const name of await realFs.readdir(path.join(ownerRoot(dataDir), 'slots', slot))) reservedIds.push(name.replace(/\.json$/, ''));
    }
    assert.equal(reservedIds.length, 1, mode);
    assert.equal(await slotHasAction(dataDir, reservedIds[0]), true, mode);
  }
});

test('an unreadable dispatch decision preserves published data and slot', async () => {
  const dataDir = await makeDir();
  const store = makeStore(dataDir);
  const action = await store.prepare({ owner: OWNER, context: handoffContext() });
  const dispatchPath = path.join(ownerRoot(dataDir), 'actions', action.actionId, 'dispatch.decision');
  await realFs.writeFile(dispatchPath, 'garbage', { mode: 0o600 });
  await realFs.chmod(dispatchPath, 0o000);
  try {
    await assert.rejects(makeStore(dataDir).prepare({ owner: OWNER, context: handoffContext() }), error => error.code === CODES.STORE_IO);
    assert.equal((await realFs.lstat(path.join(ownerRoot(dataDir), 'actions', action.actionId, 'payload.json'))).isFile(), true);
    assert.equal(await slotHasAction(dataDir, action.actionId), true);
  } finally {
    await realFs.chmod(dispatchPath, 0o600);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridgeOutbox } from '../lib/bridge-outbox.js';

function faultFs(control) {
  const fail = () => { throw Object.assign(new Error('injected storage failure'), { code: control.code || 'ENOSPC' }); };
  return {
    ...fs,
    async open(file, flags, mode) {
      const metadata = String(file).endsWith('.tmp');
      if (metadata && control.phase === 'open') fail();
      const handle = await fs.open(file, flags, mode);
      return {
        async writeFile(...args) {
          if (metadata && control.phase === 'write') fail();
          return handle.writeFile(...args);
        },
        async sync() {
          if (metadata && control.phase === 'file-sync') fail();
          if (!metadata && control.phase === 'directory-sync') fail();
          return handle.sync();
        },
        close: () => handle.close(),
      };
    },
    async rename(...args) {
      if (control.phase === 'rename') fail();
      return fs.rename(...args);
    },
  };
}

async function setup(t, dispatch) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forkchat-outbox-durability-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const control = { phase: null, code: 'ENOSPC' };
  const outbox = createBridgeOutbox({ dataDir, fs: faultFs(control), dispatch });
  return { dataDir, control, outbox };
}
const input = { targetSessionId: 'sess-1', kind: 'send-text', text: 'do not send twice' };

for (const phase of ['open', 'write', 'file-sync', 'rename', 'directory-sync']) {
  test(`durability: ${phase} failure before dispatch rejects and calls no host`, async (t) => {
    let calls = 0;
    const { dataDir, control, outbox } = await setup(t, async () => { calls++; return { accepted: true }; });
    const action = await outbox.prepare(input);
    control.phase = phase;
    await assert.rejects(outbox.confirm({ actionId: action.actionId }), { code: 'outbox_persist_failed' });
    assert.equal(calls, 0);
    await assert.rejects(outbox.confirm({ actionId: action.actionId }));
    assert.equal(calls, 0, 'same in-memory action cannot resume after a failed barrier');
    assert.equal((await outbox.get({ actionId: action.actionId })).state, 'failed');
    assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
  });
}

test('durability: failed prepare is not acknowledged and does not poison later saves', async (t) => {
  let calls = 0;
  const { dataDir, control, outbox } = await setup(t, async () => { calls++; return { accepted: true }; });
  control.phase = 'write';
  await assert.rejects(outbox.prepare(input), { code: 'outbox_persist_failed' });
  assert.equal(calls, 0);
  assert.equal((await outbox.list()).length, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'bridge-export')), []);
  control.phase = null;
  const valid = await outbox.prepare(input);
  assert.equal((await outbox.confirm({ actionId: valid.actionId })).state, 'accepted');
  assert.equal(calls, 1, 'save queue must recover, without replaying the rejected operation');
});

test('durability: dispatch observes a durable dispatching record, not prepared', async (t) => {
  let dataDir;
  let calls = 0;
  const setupResult = await setup(t, async ({ record }) => {
    calls++;
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'bridge-actions.json'), 'utf8'));
    assert.equal(saved.actions.find(item => item.actionId === record.actionId).state, 'dispatching');
    return { accepted: true };
  });
  dataDir = setupResult.dataDir;
  const action = await setupResult.outbox.prepare(input);
  await setupResult.outbox.confirm({ actionId: action.actionId });
  assert.equal(calls, 1);
});

test('durability: post-send persistence failure becomes unknown; restart never dispatches again', async (t) => {
  let calls = 0;
  let control;
  const fixture = await setup(t, async () => {
    calls++;
    control.phase = 'write';
    return { accepted: true };
  });
  ({ control } = fixture);
  const action = await fixture.outbox.prepare(input);
  await assert.rejects(fixture.outbox.confirm({ actionId: action.actionId }), { code: 'action_unknown' });
  assert.equal(calls, 1);
  assert.equal((await fixture.outbox.get({ actionId: action.actionId })).state, 'unknown');
  control.phase = null;
  const revived = createBridgeOutbox({ dataDir: fixture.dataDir, dispatch: async () => { calls++; return { accepted: true }; } });
  assert.equal((await revived.get({ actionId: action.actionId })).state, 'unknown');
  await assert.rejects(revived.confirm({ actionId: action.actionId }), { code: 'action_already_used' });
  assert.equal(calls, 1);
});

test('durability: ambiguous host error plus failed save stays unknown and never retries', async (t) => {
  let calls = 0;
  let control;
  const fixture = await setup(t, async () => {
    calls++;
    control.phase = 'rename';
    throw new Error('reply lost');
  });
  ({ control } = fixture);
  const action = await fixture.outbox.prepare(input);
  await assert.rejects(fixture.outbox.confirm({ actionId: action.actionId }), { code: 'action_unknown' });
  assert.equal((await fixture.outbox.get({ actionId: action.actionId })).state, 'unknown');
  await assert.rejects(fixture.outbox.confirm({ actionId: action.actionId }));
  assert.equal(calls, 1);
});

for (const code of ['EACCES', 'EIO']) {
  test(`durability: ${code} cannot pass the dispatch barrier`, async (t) => {
    let calls = 0;
    const { control, outbox } = await setup(t, async () => { calls++; return { accepted: true }; });
    const action = await outbox.prepare(input);
    control.phase = 'open';
    control.code = code;
    await assert.rejects(outbox.confirm({ actionId: action.actionId }), { code: 'outbox_persist_failed' });
    assert.equal(calls, 0);
  });
}

for (const phase of ['file-sync', 'rename', 'directory-sync']) {
  test(`durability: post-send ${phase} failure never restores a replayable prepared action`, async (t) => {
    let calls = 0;
    let control;
    const fixture = await setup(t, async () => {
      calls++;
      control.phase = phase;
      return { accepted: true };
    });
    ({ control } = fixture);
    const action = await fixture.outbox.prepare(input);
    await assert.rejects(fixture.outbox.confirm({ actionId: action.actionId }), { code: 'action_unknown' });
    control.phase = null;
    const revived = createBridgeOutbox({ dataDir: fixture.dataDir, dispatch: async () => { calls++; } });
    const saved = await revived.get({ actionId: action.actionId });
    assert.ok(['accepted', 'unknown'].includes(saved.state));
    await assert.rejects(revived.confirm({ actionId: action.actionId }), { code: 'action_already_used' });
    assert.equal(calls, 1);
  });
}

test('durability: one failed barrier does not leave the persistence queue permanently rejected', async (t) => {
  let calls = 0;
  const { control, outbox } = await setup(t, async () => { calls++; return { accepted: true }; });
  const first = await outbox.prepare(input);
  control.phase = 'rename';
  await assert.rejects(outbox.confirm({ actionId: first.actionId }));
  assert.equal(calls, 0);
  control.phase = null;
  const next = await outbox.prepare({ ...input, text: 'a separate explicit action' });
  await outbox.confirm({ actionId: next.actionId });
  assert.equal(calls, 1);
  await assert.rejects(outbox.confirm({ actionId: first.actionId }));
  assert.equal(calls, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createForkSessionStore, FORK_SESSION_STORAGE_KEY } from '../ui/assets/fork-session-store.js';
import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { memoryHost, snapshot } from './helpers/fork-memory.mjs';

async function setup(host = memoryHost(), delayMs = 10000) {
  const store = createForkSessionStore(host, { locks: host.locks });
  let canvas = snapshot(), cancelled = 0;
  const controller = createForkSessionController({ store, capture: () => canvas,
    apply(value) { canvas = value; }, cancelPending() { cancelled++; }, delayMs });
  await controller.init();
  return { host, store, controller, get canvas() { return canvas; }, set canvas(value) { canvas = value; }, get cancelled() { return cancelled; } };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('new/switch/reopen retain independent complete canvases and drafts', async () => {
  const ui = await setup(); const first = ui.controller.state.activeId;
  ui.canvas.cards[0].draft = 'A draft'; ui.controller.scheduleSave();
  await ui.controller.newSession(snapshot('B question'));
  const second = ui.controller.state.activeId;
  assert.notEqual(first, second);
  ui.canvas.cards[0].draft = 'B draft'; ui.controller.scheduleSave();
  await ui.controller.switchTo(first);
  assert.equal(ui.canvas.cards[0].draft, 'A draft');
  await ui.controller.switchTo(second);
  assert.equal(ui.canvas.cards[0].draft, 'B draft');
  const reopened = await setup(ui.host);
  assert.equal(reopened.controller.state.activeId, second);
  assert.equal(reopened.canvas.cards[0].draft, 'B draft');
  await reopened.controller.close(); await ui.controller.close();
});

test('failed save blocks navigation and preserves the current canvas, then retry recovers', async () => {
  const ui = await setup(); const first = ui.controller.state.activeId;
  ui.canvas.cards[0].draft = 'must not lose'; ui.controller.scheduleSave();
  ui.host.control.failWrites = true;
  await ui.controller.newSession(snapshot('new'));
  assert.equal(ui.controller.state.activeId, first);
  assert.equal(ui.canvas.cards[0].draft, 'must not lose');
  assert.match(ui.controller.state.error, /SAVE_DENIED/);
  assert.equal(ui.controller.state.busy, false);
  assert.equal(ui.controller.state.dirty, true);
  ui.host.control.failWrites = false;
  await ui.controller.flush();
  assert.equal(ui.controller.state.error, '');
  assert.equal((await ui.store.get(first)).snapshot.cards[0].draft, 'must not lose');
  await ui.controller.close();
});

test('transient save failure self-heals and flushes automatically on subsequent user edits', async () => {
  // 这条测的是定时器自己会不会跑，所以必须用一个短延迟的控制器；
  // 沿用默认的 10 秒延迟就只能靠手动 flush 兜底，那等于把自动保存替掉了。
  const ui = await setup(memoryHost(), 80); const first = ui.controller.state.activeId;
  // 注入瞬态失败
  ui.host.control.failWrites = true;
  ui.canvas.cards[0].draft = 'failed draft';
  await ui.controller.flush().catch(() => {});
  assert.ok(ui.controller.state.error.length > 0, '应记录保存失败错误');

  // 恢复环境，用户发生后续新的编辑
  ui.host.control.failWrites = false;
  ui.canvas.cards[0].draft = 'healed auto-save draft';
  ui.controller.scheduleSave();

  // 只等定时器自己跑完，不手动 flush。
  // 原来这里等完 50ms 又补了一次 flush()，等于替自动保存在干活：
  // 定时器就算根本没触发，这个测试也照样绿。
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(ui.controller.state.dirty, false, '定时保存应当已经把脏状态清掉');
  assert.equal(ui.controller.state.error, '', '后续编辑排队保存应清除历史报错并恢复自愈');
  assert.equal((await ui.store.get(first)).snapshot.cards[0].draft, 'healed auto-save draft');
  await ui.controller.close();
});

test('mutations arriving during a save remain dirty and are saved by the next flush', async () => {
  const ui = await setup(); const save = ui.store.save;
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  ui.store.save = async (...args) => { started(); await new Promise(resolve => { release = resolve; }); return save(...args); };
  ui.canvas.cards[0].draft = 'old'; ui.controller.scheduleSave();
  const saving = ui.controller.flush(); await began;
  ui.canvas.cards[0].draft = 'latest'; ui.controller.scheduleSave(); release();
  await saving;
  assert.equal(ui.controller.state.dirty, true);
  ui.store.save = save;
  await ui.controller.flush();
  assert.equal((await ui.store.get(ui.controller.state.activeId)).snapshot.cards[0].draft, 'latest');
  await ui.controller.close();
});

test('same-origin stale writers report a conflict and can save a non-destructive copy', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'first window'; one.controller.scheduleSave(); await one.controller.flush();
  two.canvas.cards[0].draft = 'second window'; two.controller.scheduleSave();
  await assert.rejects(two.controller.flush(), error => error.code === 'SESSION_CONFLICT');
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'first window');
  await two.controller.saveCopy();
  assert.notEqual(two.controller.state.activeId, id);
  assert.equal((await two.store.get(two.controller.state.activeId)).snapshot.cards[0].draft, 'second window');
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'first window');
  await one.controller.close(); await two.controller.close();
});

test('transitions advance generation before cancelling requests and save interrupted output', async () => {
  const host = memoryHost(), store = createForkSessionStore(host, { locks: host.locks });
  let canvas = snapshot('A'), oldGeneration, controller;
  controller = createForkSessionController({ store, capture: () => canvas, apply(value) { canvas = value; }, delayMs: 10000,
    cancelPending() {
      assert.ok(controller.generation > oldGeneration);
      for (const message of canvas.cards[0].messages) if (message.streaming) { message.streaming = false; message.failed = true; message.status = 'cancelled'; }
    },
  });
  await controller.init(); const first = controller.state.activeId;
  canvas.cards[0].messages.push({ role: 'assistant', requestId: 'req-A', text: 'partial', status: 'generating', streaming: true });
  oldGeneration = controller.generation;
  await controller.newSession(snapshot('B'));
  assert.equal((await store.get(first)).snapshot.cards[0].messages.at(-1).status, 'cancelled');
  assert.equal(canvas.cards[0].messages[0].text, 'B');
  oldGeneration = controller.generation; await controller.close();
});

test('rename preserves the live canvas and catches final stream output arriving while metadata is busy', async () => {
  const ui = await setup(); const id = ui.controller.state.activeId;
  const message = { role: 'assistant', requestId: 'req-live', text: 'partial', streaming: true, status: 'generating' };
  ui.canvas.cards[0].messages.push(message); ui.controller.scheduleSave();
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const rename = ui.store.rename;
  ui.store.rename = async (...args) => { started(); await new Promise(resolve => { release = resolve; }); return rename(...args); };
  const canvas = ui.canvas, generation = ui.controller.generation;
  const pending = ui.controller.rename(id, '自定义名称', 'question');
  await began;
  message.text = 'final answer'; message.streaming = false; message.status = 'completed';
  ui.controller.scheduleSave(); release();
  assert.equal((await pending).ok, true);
  assert.equal(ui.controller.generation, generation);
  assert.equal(ui.cancelled, 0);
  assert.equal(ui.canvas, canvas);
  await ui.controller.flush();
  const saved = await ui.store.get(id);
  assert.equal(saved.title, '自定义名称');
  assert.equal(saved.snapshot.cards[0].messages.at(-1).text, 'final answer');
  assert.equal(saved.snapshot.cards[0].messages.at(-1).status, 'completed');
  await ui.controller.close();
});

test('renaming and deleting an inactive session do not switch or cancel the active canvas', async () => {
  const ui = await setup(); const old = await ui.store.get(ui.controller.state.activeId);
  await ui.controller.newSession(snapshot('active'));
  const id = ui.controller.state.activeId, canvas = ui.canvas, generation = ui.controller.generation, cancellations = ui.cancelled;
  assert.equal((await ui.controller.rename(old.id, '历史记录', old.title)).ok, true);
  const target = await ui.store.get(old.id);
  assert.equal((await ui.controller.remove(old.id, target.revision, snapshot())).ok, true);
  assert.equal(ui.controller.state.activeId, id);
  assert.equal(ui.canvas, canvas);
  assert.equal(ui.controller.generation, generation);
  assert.equal(ui.cancelled, cancellations);
  await ui.controller.close();
});

test('deleting the current last session cancels first and clears canvas without resurrection', async () => {
  const ui = await setup(); const id = ui.controller.state.activeId, generation = ui.controller.generation;
  ui.canvas.cards[0].draft = 'explicitly discarded'; ui.controller.scheduleSave();
  assert.equal((await ui.controller.remove(id, 1)).ok, true);
  assert.ok(ui.controller.generation > generation);
  assert.equal(ui.cancelled, 1);
  assert.equal(ui.controller.state.activeId, null);
  assert.equal(ui.canvas, null);
  await assert.rejects(ui.store.get(id), error => error.code === 'SESSION_NOT_FOUND');
  await ui.controller.flush();
  await assert.rejects(ui.store.get(id), error => error.code === 'SESSION_NOT_FOUND');
  await ui.controller.close();
});

test('delete failure retains the entire current canvas and store; retry can succeed', async () => {
  const ui = await setup(); const id = ui.controller.state.activeId;
  ui.canvas.cards[0].draft = 'retained on failure';
  ui.host.control.failWrites = true;
  assert.equal((await ui.controller.remove(id, 1, snapshot())).ok, false);
  assert.equal(ui.controller.state.activeId, id);
  assert.equal(ui.canvas.cards[0].draft, 'retained on failure');
  assert.equal((await ui.store.get(id)).id, id);
  ui.host.control.failWrites = false;
  assert.equal((await ui.controller.remove(id, 1, snapshot())).ok, true);
  await ui.controller.close();
});

test('metadata failure does not trip the autosave breaker for final output arriving while busy', async () => {
  const host = memoryHost(), store = createForkSessionStore(host, { locks: host.locks });
  let canvas = snapshot(), release, started, final = false, savedFinal;
  const began = new Promise(resolve => { started = resolve; });
  const autosaved = new Promise(resolve => { savedFinal = resolve; });
  const controller = createForkSessionController({ store, capture: () => canvas, apply(value) { canvas = value; }, cancelPending() {}, delayMs: 5,
    onChange(state) { if (final && !state.busy && !state.saving && !state.dirty) savedFinal(); },
  });
  await controller.init(); const id = controller.state.activeId;
  canvas.cards[0].messages.push({ role: 'assistant', requestId: 'req-failed-rename', text: 'partial', streaming: true, status: 'generating' });
  controller.scheduleSave();
  store.rename = async () => { started(); await new Promise(resolve => { release = resolve; }); throw Object.assign(new Error('invalid metadata'), { code: 'INVALID_SESSION_TITLE' }); };
  const renaming = controller.rename(id, 'name', 'question'); await began;
  Object.assign(canvas.cards[0].messages.at(-1), { text: 'final despite failed rename', streaming: false, status: 'completed' });
  final = true; controller.scheduleSave(); release();
  assert.equal((await renaming).ok, false);
  await autosaved;
  assert.equal(controller.state.error, '');
  assert.equal((await store.get(id)).snapshot.cards[0].messages.at(-1).text, 'final despite failed rename');
  await controller.close();
});

test('delete conflicts protect foreign changes, and a fresh explicit confirmation can delete the latest revision', async () => {
  const ui = await setup(), id = ui.controller.state.activeId;
  let remote = await ui.store.get(id);
  remote.snapshot.cards[0].draft = 'other window';
  remote = await ui.store.save(id, remote.revision, remote.snapshot);
  assert.equal((await ui.controller.remove(id, 1, snapshot())).ok, false);
  assert.equal((await ui.store.get(id)).snapshot.cards[0].draft, 'other window');
  const confirmedRevision = remote.revision;
  remote = await ui.store.save(id, confirmedRevision, remote.snapshot);
  assert.equal((await ui.controller.remove(id, confirmedRevision, snapshot())).ok, false);
  assert.equal((await ui.store.get(id)).revision, remote.revision);
  assert.equal((await ui.controller.remove(id, remote.revision, snapshot())).ok, true);
  await assert.rejects(ui.store.get(id), error => error.code === 'SESSION_NOT_FOUND');
  await ui.controller.close();
});

test('corrupt persisted data remains untouched and the canvas stays disabled', async () => {
  const host = memoryHost(); host.values.set(FORK_SESSION_STORAGE_KEY, { version: 999 });
  const ui = await setup(host);
  assert.equal(ui.controller.state.ready, false);
  assert.match(ui.controller.state.error, /SESSION_STORE_CORRUPT/);
  assert.deepEqual(host.values.get(FORK_SESSION_STORAGE_KEY), { version: 999 });
  assert.equal(host.control.writes, 0);
  await ui.controller.close();
});

test('refresh adopts a session created by another window after this canvas became empty', async () => {
  const host = memoryHost();
  const emptyWindow = await setup(host);
  const otherWindow = await setup(host);
  const oldId = emptyWindow.controller.state.activeId;

  assert.equal((await emptyWindow.controller.remove(oldId, 1)).ok, true);
  assert.equal(emptyWindow.controller.state.activeId, null);

  await otherWindow.controller.newSession(snapshot('created elsewhere'));
  const newId = otherWindow.controller.state.activeId;
  await emptyWindow.controller.refresh();

  assert.equal(emptyWindow.controller.state.activeId, newId);
  assert.equal(emptyWindow.canvas.cards[0].messages[0].text, 'created elsewhere');
  await emptyWindow.controller.close();
  await otherWindow.controller.close();
});

test('refresh adopts an external activeId switch when the current canvas is clean', async () => {
  const host = memoryHost();
  const first = await setup(host);
  const second = await setup(host);
  const oldId = first.controller.state.activeId;

  await second.controller.newSession(snapshot('other active session'));
  const newId = second.controller.state.activeId;
  assert.notEqual(newId, oldId);
  await first.controller.refresh();

  assert.equal(first.controller.state.activeId, newId);
  assert.equal(first.canvas.cards[0].messages[0].text, 'other active session');
  await first.controller.close();
  await second.controller.close();
});

test('冲突后普通 flush 仍被 sticky conflict 阻断，只有 retrySave 才能明确覆盖', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'first window'; one.controller.scheduleSave(); await one.controller.flush();
  two.canvas.cards[0].draft = 'second window'; two.controller.scheduleSave();
  await assert.rejects(two.controller.flush(), error => error.code === 'SESSION_CONFLICT');
  assert.equal(two.controller.state.conflict, 'modified');
  assert.equal(two.controller.state.activeRevision, (await two.store.get(id)).revision);
  assert.match(two.controller.state.notice || '', /覆盖/);

  // force 只绕过生命周期门，不是覆盖授权；普通重试不能写入远端。
  await assert.rejects(two.controller.flush(true), error => error.code === 'SESSION_CONFLICT');
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'first window');

  // 只有明确的用户重试才允许使用最新 revision 覆盖。
  await two.controller.retrySave();
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'second window');
  await one.controller.close(); await two.controller.close();
});

test('refresh adopts a clean same-id remote revision and advances generation', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  const oldGeneration = one.controller.generation;
  const oldCancelled = one.cancelled;
  const remote = await two.store.get(id);
  remote.snapshot.cards[0].draft = 'remote revision 2';
  const saved = await two.store.save(id, remote.revision, remote.snapshot);

  await one.controller.refresh();

  assert.equal(one.controller.state.activeId, id);
  assert.equal(one.controller.state.activeRevision, saved.revision);
  assert.equal(one.canvas.cards[0].draft, 'remote revision 2');
  assert.equal(one.controller.state.dirty, false);
  assert.equal(one.controller.state.conflict, null);
  assert.ok(one.controller.generation > oldGeneration);
  assert.ok(one.cancelled > oldCancelled);
  await one.controller.close(); await two.controller.close();
});

test('refresh preserves dirty local input and marks same-id remote revision conflict', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'local draft'; one.controller.scheduleSave();
  const remote = await two.store.get(id);
  remote.snapshot.cards[0].draft = 'remote draft';
  await two.store.save(id, remote.revision, remote.snapshot);

  await one.controller.refresh();

  assert.equal(one.controller.state.activeId, id);
  assert.equal(one.canvas.cards[0].draft, 'local draft');
  assert.equal(one.controller.state.dirty, true);
  assert.equal(one.controller.state.conflict, 'modified');
  assert.match(one.controller.state.error, /SESSION_CONFLICT/);
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'remote draft');
  await one.controller.close().catch(() => {}); await two.controller.close();
});

test('refresh preserves dirty local input when the active record is deleted, then saveCopy recovers it', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'local before delete'; one.controller.scheduleSave();
  await two.store.remove(id, 1, snapshot('fallback')); // activeId becomes null

  await one.controller.refresh();

  assert.equal(one.controller.state.activeId, id);
  assert.equal(one.canvas.cards[0].draft, 'local before delete');
  assert.equal(one.controller.state.dirty, true);
  assert.equal(one.controller.state.conflict, 'deleted');
  assert.match(one.controller.state.error, /删除/);
  await one.controller.saveCopy();
  const copyId = one.controller.state.activeId;
  assert.notEqual(copyId, id);
  assert.equal((await one.store.get(copyId)).snapshot.cards[0].draft, 'local before delete');
  assert.equal(one.controller.state.conflict, null);
  await one.controller.close(); await two.controller.close();
});

test('flush(true) checks a clean remote revision even without a watch callback', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  const remote = await two.store.get(id);
  remote.snapshot.cards[0].draft = 'remote without watch';
  const saved = await two.store.save(id, remote.revision, remote.snapshot);

  await one.controller.flush(true);

  assert.equal(one.controller.state.activeRevision, saved.revision);
  assert.equal(one.canvas.cards[0].draft, 'remote without watch');
  assert.equal(one.controller.getSavedSnapshot().revision, saved.revision);
  await one.controller.close(); await two.controller.close();
});

test('get during refresh cannot adopt over newer local input', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  const remote = await two.store.get(id);
  remote.snapshot.cards[0].draft = 'remote value';
  await two.store.save(id, remote.revision, remote.snapshot);

  const gate = deferred();
  const reached = deferred();
  const get = one.store.get;
  let gated = true;
  one.store.get = async (...args) => {
    if (gated && args[0] === id) {
      gated = false;
      reached.resolve();
      await gate.promise;
    }
    return get(...args);
  };
  const refreshing = one.controller.refresh();
  await reached.promise;
  one.canvas.cards[0].draft = 'new local input';
  one.controller.scheduleSave();
  gate.resolve();
  await refreshing;

  assert.equal(one.canvas.cards[0].draft, 'new local input');
  assert.equal(one.controller.state.dirty, true);
  assert.equal(one.controller.state.conflict, 'modified');
  await one.controller.close().catch(() => {}); await two.controller.close();
});

test('late refresh result cannot overwrite a newer saveCopy scope', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const oldId = one.controller.state.activeId;
  await two.controller.newSession(snapshot('remote active'));
  const remoteActiveId = two.controller.state.activeId;

  const gate = deferred();
  const reached = deferred();
  const get = one.store.get;
  let gated = true;
  one.store.get = async (...args) => {
    if (gated && args[0] === remoteActiveId) {
      gated = false;
      reached.resolve();
      await gate.promise;
    }
    return get(...args);
  };
  const refreshing = one.controller.refresh();
  await reached.promise;
  await one.controller.saveCopy();
  const copyId = one.controller.state.activeId;
  assert.notEqual(copyId, oldId);
  gate.resolve();
  await refreshing;

  assert.equal(one.controller.state.activeId, copyId);
  assert.notEqual(one.controller.state.activeId, remoteActiveId);
  assert.equal(one.canvas.cards[0].messages[0].text, 'question');
  await one.controller.close(); await two.controller.close();
});

test('own-save watch is quiet, but an external write immediately after it is adopted', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const stop = one.store.watch(() => { void one.controller.refresh(); });
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'own save'; one.controller.scheduleSave();
  await one.controller.flush();
  await tick();
  assert.equal(one.controller.state.conflict, null);
  assert.equal(one.controller.state.error, '');

  const remote = await two.store.get(id);
  remote.snapshot.cards[0].draft = 'external after own save';
  await two.store.save(id, remote.revision, remote.snapshot);
  await tick(); await tick();

  assert.equal(one.controller.state.activeRevision, remote.revision + 1);
  assert.equal(one.canvas.cards[0].draft, 'external after own save');
  assert.equal(one.controller.state.dirty, false);
  assert.equal(one.controller.state.conflict, null);
  stop();
  await one.controller.close(); await two.controller.close();
});

test('close keeps best-effort save when there is no conflict', async () => {
  const ui = await setup();
  const id = ui.controller.state.activeId;
  ui.canvas.cards[0].draft = 'close best effort';
  ui.controller.scheduleSave();
  await ui.controller.close();
  assert.equal((await ui.store.get(id)).snapshot.cards[0].draft, 'close best effort');
});

test('sticky modified conflict blocks autosave and close from overwriting the remote revision', async () => {
  const host = memoryHost(), one = await setup(host, 10), two = await setup(host, 10);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'remote wins'; one.controller.scheduleSave(); await one.controller.flush();
  two.canvas.cards[0].draft = 'local conflict'; two.controller.scheduleSave();
  await assert.rejects(two.controller.flush(), error => error.code === 'SESSION_CONFLICT');

  await assert.rejects(two.controller.flush(true), error => error.code === 'SESSION_CONFLICT');
  two.canvas.cards[0].draft = 'later local input';
  two.controller.scheduleSave();
  await sleep(40);
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'remote wins');
  await two.controller.close().catch(error => assert.equal(error.code, 'SESSION_CONFLICT'));
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'remote wins');
  await one.controller.close();
});

test('retrySave reads the latest revision and a second CAS race still needs another explicit retry', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'window A'; one.controller.scheduleSave(); await one.controller.flush();
  two.canvas.cards[0].draft = 'window B'; two.controller.scheduleSave();
  await assert.rejects(two.controller.flush(), error => error.code === 'SESSION_CONFLICT');

  const gate = deferred();
  const saveStarted = deferred();
  const save = two.store.save;
  two.store.save = async (...args) => {
    saveStarted.resolve(args);
    await gate.promise;
    return save(...args);
  };
  const retrying = two.controller.retrySave();
  await saveStarted.promise;
  const remote = await one.store.get(id);
  remote.snapshot.cards[0].draft = 'window C';
  await one.store.save(id, remote.revision, remote.snapshot);
  gate.resolve();
  await assert.rejects(retrying, error => error.code === 'SESSION_CONFLICT');
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'window C');
  assert.equal(two.controller.state.conflict, 'modified');

  two.store.save = save;
  await two.controller.retrySave();
  assert.equal((await one.store.get(id)).snapshot.cards[0].draft, 'window B');
  await one.controller.close(); await two.controller.close();
});

test('getSavedSnapshot rejects a sticky conflict until retry or saveCopy resolves it', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'remote'; one.controller.scheduleSave(); await one.controller.flush();
  two.canvas.cards[0].draft = 'local'; two.controller.scheduleSave();
  await assert.rejects(two.controller.flush(), error => error.code === 'SESSION_CONFLICT');
  assert.throws(() => two.controller.getSavedSnapshot(), error => error.code === 'SESSION_NOT_SAVED');
  await two.controller.saveCopy();
  assert.equal(two.controller.state.conflict, null);
  assert.notEqual(two.controller.state.activeId, id);
  await one.controller.close(); await two.controller.close();
});

test('dirty refresh preserves the local session when another window switches activeId', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'local active'; one.controller.scheduleSave();
  await two.controller.newSession(snapshot('other active'));
  await one.controller.refresh();
  assert.equal(one.controller.state.activeId, id);
  assert.equal(one.canvas.cards[0].draft, 'local active');
  assert.equal(one.controller.state.dirty, true);
  assert.equal(one.controller.state.conflict, 'active-changed');
  await one.controller.close().catch(() => {}); await two.controller.close();
});

test('dirty deletion with a replacement activeId remains local and can be copied', async () => {
  const host = memoryHost(), one = await setup(host), two = await setup(host);
  const id = one.controller.state.activeId;
  one.canvas.cards[0].draft = 'local deleted'; one.controller.scheduleSave();
  const replacement = await two.store.create(snapshot('replacement active'));
  await two.store.remove(id, 1, snapshot('fallback'));
  assert.equal((await two.store.list()).activeId, replacement.id);

  await one.controller.refresh();
  assert.equal(one.controller.state.activeId, id);
  assert.equal(one.canvas.cards[0].draft, 'local deleted');
  assert.equal(one.controller.state.conflict, 'deleted');
  await one.controller.saveCopy();
  assert.equal((await one.store.get(one.controller.state.activeId)).snapshot.cards[0].draft, 'local deleted');
  await one.controller.close(); await two.controller.close();
});

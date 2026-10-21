import test from 'node:test';
import assert from 'node:assert/strict';
import { createForkSessionStore, FORK_SESSION_STORAGE_KEY } from '../ui/assets/fork-session-store.js';
import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { memoryHost, snapshot } from './helpers/fork-memory.mjs';

async function setup(host = memoryHost()) {
  const store = createForkSessionStore(host, { locks: host.locks });
  let canvas = snapshot(), cancelled = 0;
  const controller = createForkSessionController({ store, capture: () => canvas,
    apply(value) { canvas = value; }, cancelPending() { cancelled++; }, delayMs: 10000 });
  await controller.init();
  return { host, store, controller, get canvas() { return canvas; }, set canvas(value) { canvas = value; }, get cancelled() { return cancelled; } };
}

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

test('deleting the current last session cancels first and replaces it atomically without resurrection', async () => {
  const ui = await setup(); const id = ui.controller.state.activeId, generation = ui.controller.generation;
  ui.canvas.cards[0].draft = 'explicitly discarded'; ui.controller.scheduleSave();
  const blank = snapshot(); blank.cards[0].messages = [];
  assert.equal((await ui.controller.remove(id, 1, blank)).ok, true);
  assert.ok(ui.controller.generation > generation);
  assert.equal(ui.cancelled, 1);
  assert.notEqual(ui.controller.state.activeId, id);
  assert.equal(ui.canvas.cards[0].messages.length, 0);
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

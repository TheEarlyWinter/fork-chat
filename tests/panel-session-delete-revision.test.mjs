import test from 'node:test';
import assert from 'node:assert/strict';

import { createForkSessionStore } from '../ui/assets/fork-session-store.js';
import { loadPanel } from './helpers/panel-harness.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

async function settle() {
  await tick();
  await tick();
}

test('[I2-1-R2] real panel delete confirmation rejects a stale revision and requires a fresh read', async (t) => {
  const app = await loadPanel();
  t.after(async () => {
    await app.panel.dispose();
  });

  const composition = app.sessionUiCompositions[0];
  assert.ok(composition, '实际 panel 必须创建 SessionUI composition');
  const controller = composition.deps.getSessionController();
  const store = createForkSessionStore(app.hana, { locks: app.host.locks });
  const id = controller.state.activeId;
  const command = (requestId) => composition.ui.handleSessionMessage({
    type: 'FORK_SESSION_COMMAND',
    targetCanvasId: composition.deps.canvasId,
    command: 'delete',
    sessionId: id,
    requestId,
  });

  command('delete-r1');
  await settle();
  const dialog = app.ui.nodes.get('delete-session-dialog');
  assert.equal(dialog.open, true, '删除确认必须真实挂载');

  const remote = await store.get(id);
  remote.snapshot.cards[0].draft = 'remote revision 2';
  const saved = await store.save(id, remote.revision, remote.snapshot);
  await controller.refresh();
  assert.equal(controller.state.activeRevision, saved.revision);

  app.ui.nodes.get('btn-delete-confirm').dispatchEvent({ type: 'click', isTrusted: true });
  await settle();
  assert.equal((await store.get(id)).revision, saved.revision, '旧确认失败后远端 r2 必须保留');
  assert.equal(app.ui.nodes.get('btn-delete-confirm').disabled, true, '旧删除确认必须被禁用');
  assert.match(app.ui.nodes.get('delete-dialog-progress').textContent, /保存版本已变化，请关闭后重新发起删除/);

  dialog.dispatchEvent({ type: 'cancel', preventDefault() {} });
  assert.equal(dialog.open, false, '旧确认必须可以取消');

  command('delete-r2');
  await settle();
  app.ui.nodes.get('btn-delete-confirm').dispatchEvent({ type: 'click', isTrusted: true });
  await settle();
  await assert.rejects(store.get(id), error => error.code === 'SESSION_NOT_FOUND');
});

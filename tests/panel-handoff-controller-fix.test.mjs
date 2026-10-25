import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelHandoff } from '../ui/assets/panel-handoff.js';
import { makeControllerDeps, response } from './fixtures/handoff-fixtures.mjs';

test('I2 integration: flush adoption retires only the stale preview loading op', async () => {
  let flushCalls = 0;
  const deps = makeControllerDeps({
    onRequest: async path => {
      if (path === '/api/handoff/actions') return response({ ok: true, actions: [] });
      return undefined;
    },
  });
  deps.sessionController.flush = async () => {
    flushCalls++;
    // Simulate clean same-id remote revision adoption by the real controller.
    deps.state.generation++;
  };

  let dialog = null;
  const appendChild = deps.documentRef.body.appendChild.bind(deps.documentRef.body);
  deps.documentRef.body.appendChild = child => {
    dialog = child;
    return appendChild(child);
  };
  const handoff = createPanelHandoff(deps);
  try {
    await handoff.open('target');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(flushCalls, 1);
    assert.ok(dialog);
    assert.equal(dialog.open, false, 'stale loading must not remain modal and unusable');
    assert.match(deps.flashMessages.at(-1) || '', /重新打开交接预览/);
    assert.equal(deps.calls.filter(call => call.path === '/api/handoff/prepare').length, 0);
  } finally {
    handoff.dispose();
  }
});

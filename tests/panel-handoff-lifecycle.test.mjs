import test from 'node:test';
import assert from 'node:assert/strict';

import { createPanelHandoff } from '../ui/assets/panel-handoff.js';
import {
  deferred,
  makeAction,
  makeControllerDeps,
  response,
  waitFor,
} from './fixtures/handoff-fixtures.mjs';

const ACTION_A = `ha_${'a'.repeat(32)}`;
const ACTION_B = `ha_${'b'.repeat(32)}`;

const CAPS_OK = {
  ok: true,
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

function currentDialog(deps) {
  return deps.documentRef.body.querySelector('.handoff-dialog');
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function openHistory(deps) {
  const handoff = createPanelHandoff(deps);
  await handoff.open('target');
  const dialog = currentDialog(deps);
  assert.ok(dialog, '历史/预览对话框必须挂载');
  return { handoff, dialog };
}

test('[Round4-C3-1] close then same-target reopen starts a new metadata scope while old caps is pending', async () => {
  const firstCaps = deferred();
  const secondCaps = deferred();
  let capsCalls = 0;
  const deps = makeControllerDeps({
    onRequest: path => {
      if (path === '/api/handoff/capabilities') {
        capsCalls++;
        return capsCalls === 1 ? firstCaps.promise : secondCaps.promise;
      }
      return undefined;
    },
  });
  const handoff = createPanelHandoff(deps);
  const opens = [];

  try {
    opens.push(handoff.open('target'));
    await waitFor(() => capsCalls === 1);
    const oldDialog = currentDialog(deps);
    assert.ok(oldDialog, '首个 open 必须先挂载 loading 对话框');

    oldDialog.querySelector('.btn-handoff-close').dispatchEvent({ type: 'click' });
    assert.equal(currentDialog(deps), null, '关闭后旧对话框必须立即移除');

    opens.push(handoff.open('target'));
    await tick();
    assert.equal(capsCalls, 2, '关闭后的同目标 reopen 必须发出第 2 次 capabilities GET');
    const newDialog = currentDialog(deps);
    assert.ok(newDialog, 'reopen 必须立即挂载新对话框');
    assert.notEqual(newDialog, oldDialog, 'reopen 不得复用已关闭的 DOM 作用域');

    firstCaps.resolve(response(CAPS_OK, 200));
    await opens[0];
    assert.equal(currentDialog(deps), newDialog, '旧 caps finally 不得清掉新作用域');

    secondCaps.resolve(response(CAPS_OK, 200));
    await opens[1];
    assert.equal(currentDialog(deps), newDialog, '旧 open 完成后不得污染新作用域');
  } finally {
    firstCaps.resolve(response(CAPS_OK, 200));
    secondCaps.resolve(response(CAPS_OK, 200));
    await Promise.allSettled(opens);
    handoff.dispose();
  }
});

test('[Round4-C3-2] history selection creates independent query/focus scopes across A to B to A', async () => {
  const queryAFirst = deferred();
  const queryASecond = deferred();
  const queryB = deferred();
  let queryACalls = 0;
  let queryBCalls = 0;
  const focusCalls = [];
  const actionA = makeAction({ actionId: ACTION_A, state: 'creating', sessionId: null, agentId: 'agent-a' });
  const actionB = makeAction({ actionId: ACTION_B, state: 'creating', sessionId: null, agentId: 'agent-b' });

  const deps = makeControllerDeps({
    onRequest: (path, init) => {
      if (path === '/api/handoff/actions') {
        return response({ ok: true, actions: [actionA, actionB] }, 200);
      }
      if (path === `/api/handoff/actions/${ACTION_A}`) {
        queryACalls++;
        return queryACalls === 1 ? queryAFirst.promise : queryASecond.promise;
      }
      if (path === `/api/handoff/actions/${ACTION_B}`) {
        queryBCalls++;
        return queryB.promise;
      }
      if (init?.method === 'POST') {
        throw new Error('历史 query/focus 路径不得 POST');
      }
      return undefined;
    },
    focus: async ({ sessionId }) => {
      focusCalls.push(sessionId);
    },
  });
  const { handoff, dialog: initialDialog } = await openHistory(deps);

  try {
    const historySelect = initialDialog.querySelector('.handoff-history-select');
    assert.ok(historySelect, '多条历史动作必须提供选择器');
    assert.equal(historySelect.querySelectorAll('option').length, 2, '选择器必须包含 A、B 两条动作');

    historySelect.value = ACTION_A;
    historySelect.dispatchEvent({ type: 'change' });
    currentDialog(deps).querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
    await waitFor(() => queryACalls === 1);

    let liveDialog = currentDialog(deps);
    liveDialog.querySelector('.handoff-history-select').value = ACTION_B;
    liveDialog.querySelector('.handoff-history-select').dispatchEvent({ type: 'change' });
    currentDialog(deps).querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
    await tick();
    assert.equal(queryBCalls, 1, 'A 查询挂起时切到 B，B 仍必须能发起自己的 query');

    // A 的迟到响应不能释放 B 自己的单飞锁，也不能改写 B 的当前动作。
    queryAFirst.resolve(response({
      ok: true,
      action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'session-A-late' }),
    }, 200));
    await tick();
    currentDialog(deps).querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
    await tick();
    assert.equal(queryBCalls, 1, 'A 的旧 finally 不得解除 B 的在途 query 单飞锁');

    queryB.resolve(response({
      ok: true,
      action: makeAction({ actionId: ACTION_B, state: 'ready', sessionId: 'session-B-current' }),
    }, 200));
    await waitFor(() => currentDialog(deps).querySelector('.btn-handoff-focus')?.style.display === 'inline-block');
    currentDialog(deps).querySelector('.btn-handoff-focus').dispatchEvent({ type: 'click' });
    await tick();
    assert.deepEqual(focusCalls, ['session-B-current'], 'B 的 focus 必须消费 B 的最新 sessionId');

    // 再切回 A。即使 A 的第一次 query 已结束，A 的新代际仍必须可独立 query。
    liveDialog = currentDialog(deps);
    liveDialog.querySelector('.handoff-history-select').value = ACTION_A;
    liveDialog.querySelector('.handoff-history-select').dispatchEvent({ type: 'change' });
    currentDialog(deps).querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
    await tick();
    assert.equal(queryACalls, 2, 'A→B→A 必须按新选择代际发起新的 query');

    queryASecond.resolve(response({
      ok: true,
      action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'session-A-current' }),
    }, 200));
    await waitFor(() => currentDialog(deps).querySelector('.btn-handoff-focus')?.style.display === 'inline-block');
    currentDialog(deps).querySelector('.btn-handoff-focus').dispatchEvent({ type: 'click' });
    await tick();
    assert.deepEqual(focusCalls, ['session-B-current', 'session-A-current'], '回到 A 后 focus 必须只消费当前 A 代际');
  } finally {
    queryAFirst.resolve(response({ ok: true, action: actionA }, 200));
    queryASecond.resolve(response({ ok: true, action: actionA }, 200));
    queryB.resolve(response({ ok: true, action: actionB }, 200));
    handoff.dispose();
  }
});

test('[Round4-C3-2b] a late rejected focus from A cannot pollute or unlock selected B', async () => {
  const focusA = deferred();
  const focusCalls = [];
  const actionA = makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'session-A' });
  const actionB = makeAction({ actionId: ACTION_B, state: 'ready', sessionId: 'session-B' });
  const deps = makeControllerDeps({
    onRequest: path => {
      if (path === '/api/handoff/actions') return response({ ok: true, actions: [actionA, actionB] }, 200);
      return undefined;
    },
    focus: async ({ sessionId }) => {
      focusCalls.push(sessionId);
      if (sessionId === 'session-A') return focusA.promise;
    },
  });
  const { handoff } = await openHistory(deps);

  try {
    const select = currentDialog(deps).querySelector('.handoff-history-select');
    select.value = ACTION_A;
    select.dispatchEvent({ type: 'change' });
    currentDialog(deps).querySelector('.btn-handoff-focus').dispatchEvent({ type: 'click' });
    await waitFor(() => focusCalls.length === 1);

    currentDialog(deps).querySelector('.handoff-history-select').value = ACTION_B;
    currentDialog(deps).querySelector('.handoff-history-select').dispatchEvent({ type: 'change' });
    currentDialog(deps).querySelector('.btn-handoff-focus').dispatchEvent({ type: 'click' });
    await tick();
    assert.deepEqual(focusCalls, ['session-A', 'session-B'], 'B 的 focus 不得被 A 的在途 focus 单飞锁阻断');

    focusA.reject(new Error('old focus rejected'));
    await tick();
    assert.equal(currentDialog(deps).querySelector('.handoff-error').style.display, 'none', 'A 的旧 reject 不得给当前 B 显示错误');
    assert.equal(currentDialog(deps).querySelector('.btn-handoff-focus').style.display, 'inline-block');
  } finally {
    focusA.reject(new Error('old focus rejected'));
    handoff.dispose();
  }
});

test('[Round4-C3-3] closing a new-preview wait retires it, blocks late follow-up, and permits immediate reopen', async t => {
  await t.test('close while flush is pending', async () => {
    const firstFlush = deferred();
    const secondFlush = deferred();
    let capsCalls = 0;
    let flushCalls = 0;
    let snapshotCalls = 0;
    let agentCalls = 0;
    const deps = makeControllerDeps({
      onRequest: path => {
        if (path === '/api/handoff/capabilities') {
          capsCalls++;
          return response(CAPS_OK, 200);
        }
        if (path === '/api/handoff/actions') return response({ ok: true, actions: [] }, 200);
        if (path === '/api/agents') {
          agentCalls++;
          return response({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }, 200);
        }
        return undefined;
      },
    });
    const originalSnapshot = deps.sessionController.getSavedSnapshot;
    deps.sessionController.getSavedSnapshot = () => {
      snapshotCalls++;
      return originalSnapshot();
    };
    deps.sessionController.flush = async () => {
      flushCalls++;
      return flushCalls === 1 ? firstFlush.promise : secondFlush.promise;
    };
    const handoff = createPanelHandoff(deps);
    const opens = [];

    try {
      opens.push(handoff.open('target'));
      await waitFor(() => flushCalls === 1);
      const oldDialog = currentDialog(deps);
      oldDialog.querySelector('.btn-handoff-close').dispatchEvent({ type: 'click' });

      opens.push(handoff.open('target'));
      await tick();
      assert.equal(capsCalls, 2, 'preview 等待期间关闭后立即 reopen 必须进入新 metadata scope');
      const newDialog = currentDialog(deps);
      assert.ok(newDialog, 'reopen 必须挂载新对话框');
      assert.notEqual(newDialog, oldDialog);

      firstFlush.resolve();
      await opens[0];
      await tick();
      assert.equal(snapshotCalls, 0, '旧 preview close 后不得继续读取 savedSnapshot');
      assert.equal(agentCalls, 0, '旧 preview close 后不得继续 GET agents');
      assert.equal(currentDialog(deps), newDialog, '旧 flush finally 不得复活旧 preview');

      secondFlush.resolve();
      await opens[1];
      assert.equal(agentCalls, 1, '新 scope 必须可以独立获取 agents');
      assert.equal(currentDialog(deps), newDialog);
    } finally {
      firstFlush.resolve();
      secondFlush.resolve();
      await Promise.allSettled(opens);
      handoff.dispose();
    }
  });

  await t.test('close while agents is pending', async () => {
    const firstAgents = deferred();
    const secondAgents = deferred();
    let capsCalls = 0;
    let agentCalls = 0;
    const deps = makeControllerDeps({
      onRequest: path => {
        if (path === '/api/handoff/capabilities') {
          capsCalls++;
          return response(CAPS_OK, 200);
        }
        if (path === '/api/handoff/actions') return response({ ok: true, actions: [] }, 200);
        if (path === '/api/agents') {
          agentCalls++;
          return agentCalls === 1 ? firstAgents.promise : secondAgents.promise;
        }
        return undefined;
      },
    });
    const handoff = createPanelHandoff(deps);
    const opens = [];

    try {
      opens.push(handoff.open('target'));
      await waitFor(() => agentCalls === 1);
      const oldDialog = currentDialog(deps);
      oldDialog.querySelector('.btn-handoff-close').dispatchEvent({ type: 'click' });

      opens.push(handoff.open('target'));
      await tick();
      assert.equal(capsCalls, 2, 'agents 等待期间关闭后 reopen 不得复用旧 open promise');
      const newDialog = currentDialog(deps);
      assert.ok(newDialog);
      assert.notEqual(newDialog, oldDialog);

      firstAgents.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }, 200));
      await opens[0];
      await tick();
      assert.equal(currentDialog(deps), newDialog, '旧 agents finally 不得重新渲染旧 preview');

      secondAgents.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }, 200));
      await opens[1];
      assert.equal(currentDialog(deps), newDialog, '新 scope 完成后必须保留新对话框');
    } finally {
      firstAgents.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }, 200));
      secondAgents.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }, 200));
      await Promise.allSettled(opens);
      handoff.dispose();
    }
  });
});

test('[Round4-C3-4] busy new-preview precheck keeps history query/focus alive and can retry after ready', async () => {
  const historyAction = makeAction({ actionId: ACTION_A, state: 'creating', sessionId: null });
  let queryCalls = 0;
  let flushCalls = 0;
  let prepareCalls = 0;
  const focusCalls = [];
  const deps = makeControllerDeps({
    onRequest: (path, init) => {
      if (path === '/api/handoff/actions') return response({ ok: true, actions: [historyAction] }, 200);
      if (path === `/api/handoff/actions/${ACTION_A}`) {
        queryCalls++;
        return response({
          ok: true,
          action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'session-history' }),
        }, 200);
      }
      if (path === '/api/handoff/prepare') {
        prepareCalls++;
        return response({ ok: true, action: makeAction({ actionId: ACTION_B, state: 'prepared' }) }, 200);
      }
      if (init?.method === 'POST') throw new Error('busy/history recovery must not POST before explicit new-preview');
      return undefined;
    },
    focus: async ({ sessionId }) => {
      focusCalls.push(sessionId);
    },
  });
  deps.sessionController.flush = async () => {
    flushCalls++;
  };
  const { handoff } = await openHistory(deps);

  try {
    const getDialog = () => currentDialog(deps);
    deps.state.busy = true;
    getDialog().querySelector('.btn-handoff-new-preview').dispatchEvent({ type: 'click' });
    await tick();
    assert.equal(flushCalls, 0, 'busy 前置失败不得先 flush');

    getDialog().querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
    await tick();
    assert.equal(queryCalls, 1, 'busy 新预览失败后原 history query 仍必须可用');
    await waitFor(() => getDialog().querySelector('.btn-handoff-focus')?.style.display === 'inline-block');
    getDialog().querySelector('.btn-handoff-focus').dispatchEvent({ type: 'click' });
    await tick();
    assert.deepEqual(focusCalls, ['session-history'], 'busy 新预览失败后原 history focus 仍必须可用');

    deps.state.busy = false;
    getDialog().querySelector('.btn-handoff-new-preview').dispatchEvent({ type: 'click' });
    await waitFor(() => getDialog().querySelector('.btn-handoff-prepare')?.style.display === 'inline-block');
    assert.equal(flushCalls, 1, '恢复 ready 后明确重试新预览才允许 flush');

    getDialog().querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await waitFor(() => prepareCalls === 1);
    assert.equal(prepareCalls, 1, '恢复 ready 后新预览必须可以 prepare');
  } finally {
    handoff.dispose();
  }
});

test('[Round4-I4] list 500 retry to empty is GET-only until explicit new-preview', async () => {
  let actionsCalls = 0;
  let flushCalls = 0;
  let snapshotCalls = 0;
  let postCalls = 0;
  let preparedDto = null;
  const deps = makeControllerDeps({
    onRequest: (path, init) => {
      if (path === '/api/handoff/actions') {
        actionsCalls++;
        if (actionsCalls === 1) return response({ ok: false, error: 'DATABASE_TIMEOUT' }, 500);
        return response({ ok: true, actions: [] }, 200);
      }
      if (init?.method === 'POST') {
        postCalls++;
        if (path === '/api/handoff/prepare') {
          preparedDto = JSON.parse(init.body);
          return response({ ok: true, action: makeAction({ actionId: ACTION_B, state: 'prepared' }) }, 200);
        }
      }
      return undefined;
    },
  });
  const originalSnapshot = deps.sessionController.getSavedSnapshot;
  deps.sessionController.getSavedSnapshot = () => {
    snapshotCalls++;
    return originalSnapshot();
  };
  deps.sessionController.flush = async () => {
    flushCalls++;
  };
  const { handoff } = await openHistory(deps);

  try {
    const getDialog = () => currentDialog(deps);
    const retry = getDialog().querySelector('.btn-handoff-recover');
    assert.ok(retry, '历史列表失败必须提供真实重试按钮');
    retry.dispatchEvent({ type: 'click' });
    await waitFor(() => actionsCalls === 2);
    await tick();

    assert.equal(flushCalls, 0, '500 后 GET-only retry 返回 [] 不得自动 flush');
    assert.equal(snapshotCalls, 0, '500 后 GET-only retry 返回 [] 不得读取 snapshot');
    assert.equal(postCalls, 0, '500 后 GET-only retry 返回 [] 不得自动 POST');
    assert.match(getDialog().textContent, /无历史|没有历史/, '空列表必须明确显示无历史状态');

    const newPreview = getDialog().querySelector('.btn-handoff-new-preview');
    assert.ok(newPreview, '空历史必须提供显式新预览按钮');
    assert.equal(newPreview.style.display, 'inline-block', '空历史时新预览按钮必须可见');

    newPreview.dispatchEvent({ type: 'click' });
    await waitFor(() => flushCalls === 1);
    await waitFor(() => getDialog().querySelector('.btn-handoff-prepare')?.style.display === 'inline-block');
    assert.equal(snapshotCalls, 1, '明确点击新预览后才允许读取一次最新 snapshot');

    getDialog().querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await waitFor(() => postCalls === 1);
    assert.equal(postCalls, 1, '明确点击新预览后才允许发出一次 prepare POST');
    assert.equal(typeof preparedDto?.source?.revision, 'string', 'prepare DTO 的 revision 必须规范化为字符串');
  } finally {
    handoff.dispose();
  }
});

test('[Round4-C3/I4] metadata to automatic preview remains single-flight while flush and agents are pending', async () => {
  const flushGate = deferred();
  const agentsGate = deferred();
  let capsCalls = 0;
  let actionsCalls = 0;
  let flushCalls = 0;
  let agentsCalls = 0;
  const deps = makeControllerDeps({
    onRequest: path => {
      if (path === '/api/handoff/capabilities') {
        capsCalls++;
        return response(CAPS_OK, 200);
      }
      if (path === '/api/handoff/actions') {
        actionsCalls++;
        return response({ ok: true, actions: [] }, 200);
      }
      if (path === '/api/agents') {
        agentsCalls++;
        return agentsGate.promise;
      }
      return undefined;
    },
  });
  deps.sessionController.flush = async () => {
    flushCalls++;
    return flushGate.promise;
  };
  const handoff = createPanelHandoff(deps);
  const opens = [];

  try {
    opens.push(handoff.open('target'));
    await waitFor(() => flushCalls === 1);

    opens.push(handoff.open('target'));
    await tick();
    assert.equal(capsCalls, 1, 'metadata pending 到 preview pending 期间不得重复 caps GET');
    assert.equal(actionsCalls, 1, 'metadata pending 到 preview pending 期间不得重复 actions GET');
    assert.equal(flushCalls, 1, '在途 preview 不得重复 flush');

    flushGate.resolve();
    await waitFor(() => agentsCalls === 1);

    opens.push(handoff.open('target'));
    await tick();
    assert.equal(capsCalls, 1, 'agents pending 期间再次 open 不得重复 caps GET');
    assert.equal(actionsCalls, 1, 'agents pending 期间再次 open 不得重复 actions GET');
    assert.equal(flushCalls, 1, 'agents pending 期间不得重复 flush');
    assert.equal(agentsCalls, 1, 'agents pending 期间不得重复 agents GET');

    agentsGate.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }, 200));
    await Promise.all(opens);
    assert.ok(currentDialog(deps), '单飞完成后必须保留当前预览');
  } finally {
    flushGate.resolve();
    agentsGate.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }, 200));
    await Promise.allSettled(opens);
    handoff.dispose();
  }
});

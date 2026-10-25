import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeSend } from '../ui/assets/panel-bridge-send.js';

function createMockDom() {
  const elements = new Map();
  function getOrCreate(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        disabled: false,
        readOnly: false,
        textContent: '',
        value: '',
        open: false,
        oninput: null,
        events: {},
        innerHTML: '',
        showModal() { this.open = true; },
        close() { this.open = false; },
        addEventListener(type, fn) { this.events[type] = fn; },
      });
    }
    return elements.get(id);
  }

  const documentRef = {
    getElementById: id => getOrCreate(id),
  };

  return { documentRef, elements, getOrCreate };
}

test('panel-bridge-send: updateBridgeSendControls and closeBridgeSendDialog states', () => {
  const { documentRef, getOrCreate } = createMockDom();
  let disposed = false;

  const bridge = createBridgeSend({
    documentRef,
    isDisposed: () => disposed,
    bridgeRequest: async () => { throw new Error('unexpected bridge request in control-state test'); },
  });

  const confirmBtn = getOrCreate('btn-bridge-send-confirm');
  const targetSel = getOrCreate('bridge-send-target');
  const textArea = getOrCreate('bridge-send-text');
  const openBtn = getOrCreate('btn-bridge-send');
  const dialog = getOrCreate('bridge-send-dialog');

  // 初始状态
  bridge.updateBridgeSendControls();
  assert.equal(confirmBtn.disabled, false);
  assert.equal(confirmBtn.textContent, '确认投递');
  assert.equal(targetSel.disabled, false);
  assert.equal(textArea.readOnly, false);
  assert.equal(openBtn.disabled, false);

  // 处于非 busy 时可以关闭 dialog
  dialog.open = true;
  bridge.closeBridgeSendDialog();
  assert.equal(dialog.open, false);

  // 销毁后不操作 DOM
  disposed = true;
  confirmBtn.textContent = 'changed';
  bridge.updateBridgeSendControls();
  assert.equal(confirmBtn.textContent, 'changed');
});

test('panel-bridge-send: selectedBridgeKind handles select value', () => {
  const { documentRef, getOrCreate } = createMockDom();
  const kindSelect = getOrCreate('bridge-kind-select');

  const bridge = createBridgeSend({
    documentRef,
    bridgeKindSelect: kindSelect,
    bridgeRequest: async () => { throw new Error('unexpected bridge request in kind test'); },
  });

  kindSelect.value = 'history';
  assert.equal(bridge.selectedBridgeKind(), 'history');

  kindSelect.value = 'tree-path';
  assert.equal(bridge.selectedBridgeKind(), 'tree-path');

  kindSelect.value = 'unknown';
  assert.equal(bridge.selectedBridgeKind(), 'history');
});

test('panel-bridge-send: openBridgeSendDialog initializes templates and honors targetSessionId', async () => {
  const { documentRef, getOrCreate } = createMockDom();
  const requests = [];
  const cards = [
    {
      id: 'c1',
      title: '架构设计讨论',
      messages: [
        { role: 'user', text: '提问' },
        { role: 'assistant', text: '建议采用模块化解耦方案。' },
      ],
    },
  ];

  const bridge = createBridgeSend({
    documentRef,
    getCards: () => cards,
    getSelectedCardId: () => 'c1',
    getBridgeTargetSessionId: () => 'sess-native',
    bridgeRequest: async (path) => {
      requests.push(path);
      return {
        sessions: [
          { sessionId: 'sess-other', title: '其他会话' },
          { sessionId: 'sess-native', title: '本体活跃会话' },
        ],
      };
    },
  });

  const dialog = getOrCreate('bridge-send-dialog');
  const targetSel = getOrCreate('bridge-send-target');
  const textArea = getOrCreate('bridge-send-text');

  await bridge.openBridgeSendDialog();

  assert.equal(dialog.open, true);
  assert.deepEqual(requests, ['/api/bridge/sessions']);
  assert.equal(targetSel.value, 'sess-native');
  assert.ok(textArea.value.includes('> 来自「分叉对话」的整理，原卡片：架构设计讨论'));
  assert.ok(textArea.value.includes('建议采用模块化解耦方案。'));
});

test('panel-bridge-send: confirmBridgeSend executes two-stage prepare and confirm', async () => {
  const { documentRef, getOrCreate } = createMockDom();
  const calls = [];
  const flashes = [];

  const bridge = createBridgeSend({
    documentRef,
    flashMessage: msg => flashes.push(msg),
    bridgeRequest: async (path, init) => {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      if (path.endsWith('/prepare')) {
        return { action: { actionId: 'act-123' } };
      }
      if (path.endsWith('/confirm')) {
        return { action: { actionId: 'act-123', state: 'accepted' } };
      }
      return {};
    },
  });

  const dialog = getOrCreate('bridge-send-dialog');
  const targetSel = getOrCreate('bridge-send-target');
  const textArea = getOrCreate('bridge-send-text');

  dialog.open = true;
  targetSel.value = 'sess-host';
  textArea.value = '要回传的核心摘要内容';

  await bridge.confirmBridgeSend();

  assert.equal(dialog.open, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/api/bridge/prepare');
  assert.deepEqual(calls[0].body, {
    sessionId: 'sess-host',
    kind: 'send-text',
    text: '要回传的核心摘要内容',
  });
  assert.equal(calls[1].path, '/api/bridge/confirm');
  assert.deepEqual(calls[1].body, { actionId: 'act-123' });
  assert.ok(flashes.some(f => f.includes('已投递给本体会话')));
});

test('panel-bridge-send: confirmBridgeSend with unknown status does not auto-retry and preserves actionId', async () => {
  const { documentRef, getOrCreate } = createMockDom();
  const calls = [];
  const flashes = [];

  const bridge = createBridgeSend({
    documentRef,
    flashMessage: msg => flashes.push(msg),
    bridgeRequest: async (path, init) => {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      if (path.endsWith('/prepare')) {
        return { action: { actionId: 'act-unknown-1' } };
      }
      if (path.endsWith('/confirm')) {
        return { action: { actionId: 'act-unknown-1', state: 'unknown' } };
      }
      if (path.includes('/actions/act-unknown-1')) {
        return { action: { actionId: 'act-unknown-1', state: 'prepared' } };
      }
      return {};
    },
  });

  const dialog = getOrCreate('bridge-send-dialog');
  const targetSel = getOrCreate('bridge-send-target');
  const textArea = getOrCreate('bridge-send-text');

  dialog.open = true;
  targetSel.value = 'sess-host';
  textArea.value = '测试 unknown 状态';

  // 首次提交得到 unknown
  await bridge.confirmBridgeSend();
  assert.equal(dialog.open, false);
  assert.ok(flashes.some(f => f.includes('投递状态：unknown。已保留原动作，不会自动重发。')));

  // 重新打开弹窗：必须冻结并提示
  const errEl = getOrCreate('bridge-send-error');
  await bridge.openBridgeSendDialog();
  assert.equal(targetSel.value, 'sess-host');
  assert.equal(textArea.value, '测试 unknown 状态');
  assert.ok(errEl.textContent.includes('目标与正文已冻结，只能核对/继续原动作，不会重新准备'));

  // 再次确认：必须先只读核对，而不是直接 prepare
  await bridge.confirmBridgeSend();
  assert.equal(calls.filter(c => c.path.endsWith('/prepare')).length, 1);
  assert.ok(calls.some(c => c.path.includes('/actions/act-unknown-1')));
});

test('panel-bridge-send: bind registers event listeners on elements', () => {
  const { documentRef, getOrCreate } = createMockDom();
  const listeners = [];
  const fakeListen = (target, type, handler) => {
    listeners.push({ target, type, handler });
  };

  const bridge = createBridgeSend({
    documentRef,
    listen: fakeListen,
    bridgeRequest: async () => { throw new Error('unexpected bridge request in bind test'); },
  });

  bridge.bind();

  const sendBtn = getOrCreate('btn-bridge-send');
  const closeBtn = getOrCreate('btn-bridge-send-close');
  const cancelBtn = getOrCreate('btn-bridge-send-cancel');
  const dialog = getOrCreate('bridge-send-dialog');
  const confirmBtn = getOrCreate('btn-bridge-send-confirm');

  assert.ok(listeners.some(l => l.target === sendBtn && l.type === 'click'));
  assert.ok(listeners.some(l => l.target === closeBtn && l.type === 'click'));
  assert.ok(listeners.some(l => l.target === cancelBtn && l.type === 'click'));
  assert.ok(listeners.some(l => l.target === dialog && l.type === 'cancel'));
  assert.ok(listeners.some(l => l.target === confirmBtn && l.type === 'click'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelSessionUi } from '../ui/assets/panel-session-ui.js';

/*
 * 配额错误的用户可读翻译（2.2 收尾）：
 * STORAGE_QUOTA_EXCEEDED 底层英文不直接展示，统一给泛化中文文案；
 * 其他错误仍走 safeDetail。状态行是用户感知保存失败的唯一通道。
 */

class FakeElement {
  constructor() { this.textContent = ''; this.title = ''; this.hidden = false; this.disabled = false; }
  classList = { add() {}, remove() {}, toggle() {} };
  appendChild() { return this; }
  querySelector() { return null; }
  addEventListener() {}
  showModal() {}
  close() {}
  open = false;
}

function makeHarness() {
  const nodes = new Map();
  for (const id of ['delete-session-dialog', 'delete-target-title', 'delete-dialog-error', 'delete-dialog-progress', 'btn-delete-confirm', 'btn-delete-cancel', 'session-status', 'btn-retry-save', 'btn-save-copy', 'btn-new-root', 'btn-empty-new-session']) {
    nodes.set(id, new FakeElement());
  }
  const documentRef = {
    nodes, activeElement: null,
    createElement: () => new FakeElement(),
    getElementById: id => nodes.get(id) || null,
    body: { appendChild() {} },
    addEventListener() {}, removeEventListener() {},
  };
  const flashed = [];
  const sessionController = { generation: 1 };
  const ui = createPanelSessionUi({
    hana: {}, sessionStore: { get() {} }, getSessionController: () => sessionController,
    bus: { postMessage() {} }, canvasId: 'canvas-test',
    safeDetail: v => String(v).slice(0, 400),
    initialSnapshot: () => ({}), publishSessionState() {}, renderCards() {}, listen() {},
    flashMessage: m => flashed.push(String(m)),
    deleteDialog: nodes.get('delete-session-dialog'),
    deleteTargetTitle: nodes.get('delete-target-title'),
    deleteDialogError: nodes.get('delete-dialog-error'),
    deleteDialogProgress: nodes.get('delete-dialog-progress'),
    btnDeleteConfirm: nodes.get('btn-delete-confirm'),
    btnDeleteCancel: nodes.get('btn-delete-cancel'),
    sessionStatusEl: nodes.get('session-status'),
    btnRetrySave: nodes.get('btn-retry-save'),
    btnSaveCopy: nodes.get('btn-save-copy'),
    btnNewRoot: nodes.get('btn-new-root'),
    btnEmptyNewSession: nodes.get('btn-empty-new-session'),
    documentRef: () => documentRef,
    isDisposed: () => false, hasActiveRequests: () => false,
  });
  return { ui, statusEl: nodes.get('session-status'), flashed };
}

test('STORAGE_QUOTA_EXCEEDED 显示中文泛化文案，不展示底层英文', () => {
  const h = makeHarness();
  h.ui.handleSessionStateChange({ ready: true, activeId: 's1', title: '会话', dirty: true, error: 'StorageError: STORAGE_QUOTA_EXCEEDED Cannot create session: maximum 100 reached' });
  const text = h.statusEl.textContent;
  assert.ok(text.includes('会话存储已达上限'), '中文文案出现');
  assert.ok(text.includes('未保存'), '标明未保存状态');
  assert.ok(text.includes('原有内容未被覆盖'), '安抚语义完整');
  assert.ok(!text.includes('maximum 100 reached'), '底层英文不直接暴露');
});

test('整库 12MiB 形态的配额错误同样走中文文案', () => {
  const h = makeHarness();
  h.ui.handleSessionStateChange({ ready: true, activeId: 's1', title: '会话', dirty: true, error: 'StorageError: STORAGE_QUOTA_EXCEEDED Session document size (12600000 bytes) exceeds 12MB limit' });
  assert.ok(h.statusEl.textContent.includes('会话存储已达上限'));
});

test('其他错误仍走 safeDetail 透传', () => {
  const h = makeHarness();
  h.ui.handleSessionStateChange({ ready: true, activeId: 's1', title: '会话', dirty: false, error: 'SESSION_CONFLICT: revision mismatch' });
  assert.ok(h.statusEl.textContent.includes('SESSION_CONFLICT'));
  assert.ok(!h.statusEl.textContent.includes('会话存储已达上限'));
});

test('无错误时状态行正常显示保存状态', () => {
  const h = makeHarness();
  h.ui.handleSessionStateChange({ ready: true, activeId: 's1', title: '我的会话', dirty: false, saving: false, error: null });
  assert.ok(h.statusEl.textContent.includes('已保存'));
});

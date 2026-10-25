import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionListController } from '../ui/assets/function-sessions.js';
import { createDocumentUi } from '../ui/assets/panel-document-ui.js';
import { createPanelSessionUi } from '../ui/assets/panel-session-ui.js';
import { writeRenameIntent, readRenameIntent } from '../ui/assets/fork-session-commands.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(TEST_DIR, '../ui/assets');
const ENTRY = path.join(ASSETS_DIR, 'panel.js');
const SESSION_UI = path.join(ASSETS_DIR, 'panel-session-ui.js');

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function source(file) {
  return readFile(file, 'utf8');
}

// Static guards deliberately do not depend on exported function names or line/layout counts.
function codeOnly(text) {
  return text
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '');
}

function localImports(text) {
  return [...text.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?['"](\.\/[^'"]+)['"]/g)]
    .map(match => match[1]);
}

async function assetGraph() {
  const graph = new Map();
  const files = ['panel.js', 'panel-session-ui.js'];
  for (const file of files) {
    const full = path.join(ASSETS_DIR, file);
    if (!await exists(full)) continue;
    const imports = (await source(full));
    graph.set(file, localImports(imports).map(specifier => path.basename(specifier)));
  }
  return graph;
}

function hasCycle(graph, start) {
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  return visit(start);
}

const phase1Present = await exists(SESSION_UI);

test('phase1 architecture: new session UI module exists before the entry-point cutover', () => {
  assert.equal(phase1Present, true,
    '阶段1必须先提供 ui/assets/panel-session-ui.js；缺失时不能把入口业务悄悄留在 panel.js');
});

test('phase1 architecture: session UI does not reverse-import panel.js or form an entry-point cycle', { skip: !phase1Present }, async () => {
  const ui = await source(SESSION_UI);
  assert.doesNotMatch(ui, /(?:from\s+|import\s*\()(['"])(?:\.\/)?panel\.js\1/,
    'panel-session-ui.js 不得反向导入 panel.js');
  const graph = await assetGraph();
  assert.equal(hasCycle(graph, 'panel-session-ui.js'), false,
    'session UI 与 composition root 之间不得形成依赖环');
});

test('phase1 architecture: session UI has no bare top-level DOM globals', { skip: !phase1Present }, async () => {
  const ui = codeOnly(await source(SESSION_UI));
  assert.doesNotMatch(ui, /\b(?:window|document)\b/,
    '新模块只能使用注入的 document/window 依赖；VM 白名单环境没有裸全局 DOM');
});

test('phase1 architecture: panel.js remains a composition root, not the session/document UI owner', async () => {
  const entry = codeOnly(await source(ENTRY));
  const forbidden = [
    ['renameSessionFromIntent', /\bfunction\s+renameSessionFromIntent\b/],
    ['openDeleteConfirmation', /\bfunction\s+openDeleteConfirmation\b/],
    ['dismissDeleteConfirmation', /\bfunction\s+dismissDeleteConfirmation\b/],
    ['createDocumentCard', /\bfunction\s+createDocumentCard\b/],
    ['flashMessage', /\bfunction\s+flashMessage\b/],
    ['rename-intent import/use', /\b(readRenameIntent|clearRenameIntent)\b/],
    ['session command routing', /FORK_SESSION_COMMAND/],
  ];
  const violations = forbidden.filter(([, pattern]) => pattern.test(entry)).map(([name]) => name);
  assert.deepEqual(violations, [], `入口仍持有阶段1业务：${violations.join(', ')}`);
  assert.match(entry, /__forkChat/,
    '入口必须继续保留 __forkChat 兼容面');
  assert.match(entry, /disposePanel|dispose\s*:/,
    '入口必须继续保留 dispose 生命周期出口');
});

test('phase1 architecture: the VM loader can map the new module through injected imports', { skip: !phase1Present }, async () => {
  const ui = await source(SESSION_UI);
  for (const specifier of localImports(ui)) {
    assert.match(specifier, /^\.\//);
    assert.ok(specifier.endsWith('.js'), `新模块本地依赖必须是可映射的 .js specifier: ${specifier}`);
  }
  assert.doesNotMatch(ui, /from\s+['"](?:node:|https?:)/,
    '集成 VM 不允许新模块绕过白名单注入加载外部模块');
});

test('phase1 architecture: integration VM must register the new module mapping', { skip: !phase1Present }, async () => {
  const integration = await source(path.join(TEST_DIR, 'integration.test.mjs'));
  assert.match(integration, /['"]\.\/panel-session-ui\.js['"]/, 'integration VM imports() 必须登记新模块映射');
});

class FakeElement {
  constructor(documentRef) {
    this.documentRef = documentRef;
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.open = false;
    this.value = '';
    this.textContent = '';
    this.disabled = false;
  }
  set id(value) { this.elementId = value; this.documentRef.nodes.set(value, this); }
  get id() { return this.elementId || ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'hidden') this.hidden = true; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'hidden') this.hidden = false; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, handler) { this.events[type] = handler; }
  appendChild(child) { this.children.push(child); return child; }
  contains(target) { return target === this || this.children.some(child => child.contains?.(target)); }
  focus() { this.documentRef.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  getBoundingClientRect() { return { right: 100, bottom: 100, width: 120, height: 80 }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelectorAll() { return this.children.flatMap(child => [child, ...(child.querySelectorAll?.() || [])]); }
}

function sessionUiHarness({ writeRenameIntent = async () => {}, canvas = {} } = {}) {
  const documentRef = {
    nodes: new Map(),
    activeElement: null,
    createElement: () => new FakeElement(documentRef),
    getElementById(id) { return this.nodes.get(id) || null; },
    addEventListener() {},
  };
  const ids = [
    'session-list', 'session-count', 'session-status', 'btn-new-session',
    'btn-refresh-sessions', 'session-context-menu', 'session-menu-rename',
    'session-menu-delete',
  ];
  for (const id of ids) { const node = new FakeElement(documentRef); node.id = id; }
  const messages = [];
  const channel = { postMessage(message) { messages.push(message); } };
  const sessions = [{ id: 'session-1', title: 'Original', cardCount: 2 }];
  const sessionStore = { async list() { return { sessions, activeId: 'session-1' }; } };
  const controller = createSessionListController({
    hana: {}, sessionStore, writeRenameIntent, panelId: 'panel-test', channel,
    getBoundCanvasId: () => 'canvas-test', setBoundCanvasId() {},
    getCanvasState: () => ({ ready: true, busy: false, activeId: 'session-1', ...canvas }),
    sendHello() {}, onAgentRestored() {},
    sessionListEl: documentRef.nodes.get('session-list'),
    sessionCountEl: documentRef.nodes.get('session-count'),
    sessionStatusEl: documentRef.nodes.get('session-status'),
    btnNewSession: documentRef.nodes.get('btn-new-session'),
    btnRefreshSessions: documentRef.nodes.get('btn-refresh-sessions'),
    sessionContextMenu: documentRef.nodes.get('session-context-menu'),
    btnMenuRename: documentRef.nodes.get('session-menu-rename'),
    btnMenuDelete: documentRef.nodes.get('session-menu-delete'),
    document: documentRef, window: null,
  });
  return { controller, documentRef, messages };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function panelSessionHarness({
  busy = false,
  getRecord = null,
  rename = null,
  remove = null,
  newSession = null,
  switchTo = null,
  refresh = null,
  init = null,
  flush = null,
  retrySave = null,
  saveCopy = null,
} = {}) {
  const documentRef = {
    nodes: new Map(),
    activeElement: null,
    createElement: () => new FakeElement(documentRef),
    getElementById(id) { return this.nodes.get(id) || null; },
  };
  documentRef.body = new FakeElement(documentRef);
  const ids = [
    'delete-session-dialog', 'delete-target-title', 'delete-dialog-error', 'delete-dialog-progress',
    'btn-delete-confirm', 'btn-delete-cancel', 'session-status', 'btn-retry-save',
    'btn-save-copy', 'btn-new-root', 'btn-empty-new-session',
  ];
  for (const id of ids) { const node = new FakeElement(documentRef); node.id = id; }
  const busMessages = [];
  const flashCalls = [];
  const storage = new Map();
  const hana = { storage: { global: {
    async get(key) { return storage.get(key); },
    async set(key, value) { storage.set(key, value); },
    async delete(key) { storage.delete(key); },
  } } };
  const getCalls = [];
  const record = getRecord || { id: 'session-1', title: 'Original', revision: 1 };
  const sessionController = {
    state: { ready: !busy, busy, activeId: record.id, activeRevision: record.revision },
    rename: rename || (async () => ({ ok: true })),
    remove: remove || (async () => ({ ok: true })),
    newSession: newSession || (async () => {}),
    switchTo: switchTo || (async () => {}),
    refresh: refresh || (async () => {}),
    init: init || (async () => {}),
    flush: flush || (async () => {}),
    retrySave: retrySave || (async () => {}),
    saveCopy: saveCopy || (async () => {}),
  };
  const sessionStore = { async get(id) { getCalls.push(id); return record; } };
  let disposed = false;
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    return () => {};
  };
  const ui = createPanelSessionUi({
    hana, sessionStore, getSessionController: () => sessionController,
    bus: { postMessage(message) { busMessages.push(message); } }, canvasId: 'canvas-test',
    safeDetail: value => String(value), initialSnapshot: () => ({ cards: [], view: { x: 0, y: 0, scale: 1 } }),
    publishSessionState() {}, renderCards() {}, listen,
    deleteDialog: documentRef.nodes.get('delete-session-dialog'),
    deleteTargetTitle: documentRef.nodes.get('delete-target-title'),
    deleteDialogError: documentRef.nodes.get('delete-dialog-error'),
    deleteDialogProgress: documentRef.nodes.get('delete-dialog-progress'),
    btnDeleteConfirm: documentRef.nodes.get('btn-delete-confirm'),
    btnDeleteCancel: documentRef.nodes.get('btn-delete-cancel'),
    sessionStatusEl: documentRef.nodes.get('session-status'),
    btnRetrySave: documentRef.nodes.get('btn-retry-save'),
    btnSaveCopy: documentRef.nodes.get('btn-save-copy'),
    btnNewRoot: documentRef.nodes.get('btn-new-root'),
    btnEmptyNewSession: documentRef.nodes.get('btn-empty-new-session'),
    documentRef: () => documentRef, later() {}, cancelLater() {},
    flashMessage: text => flashCalls.push(String(text)),
    isDisposed: () => disposed, hasActiveRequests: () => false,
  });
  return { ui, hana, storage, documentRef, busMessages, flashCalls, getCalls, sessionController, dispose() { disposed = true; ui.dispose(); } };
}

test('phase1 production session UI: construction is fail-fast but does not call late-bound getters', () => {
  let sessionReads = 0;
  const base = panelSessionHarness();
  const deps = {
    hana: base.hana, sessionStore: { get() {} }, getSessionController: () => { sessionReads++; return base.sessionController; },
    bus: { postMessage() {} }, canvasId: 'canvas-test', safeDetail: String,
    initialSnapshot: () => ({}), publishSessionState() {}, renderCards() {}, listen() {}, flashMessage() {},
    deleteDialog: base.documentRef.nodes.get('delete-session-dialog'),
    deleteTargetTitle: base.documentRef.nodes.get('delete-target-title'),
    deleteDialogError: base.documentRef.nodes.get('delete-dialog-error'),
    deleteDialogProgress: base.documentRef.nodes.get('delete-dialog-progress'),
    btnDeleteConfirm: base.documentRef.nodes.get('btn-delete-confirm'),
    btnDeleteCancel: base.documentRef.nodes.get('btn-delete-cancel'),
    sessionStatusEl: base.documentRef.nodes.get('session-status'),
    btnRetrySave: base.documentRef.nodes.get('btn-retry-save'),
    btnSaveCopy: base.documentRef.nodes.get('btn-save-copy'),
    btnNewRoot: base.documentRef.nodes.get('btn-new-root'),
    btnEmptyNewSession: base.documentRef.nodes.get('btn-empty-new-session'),
    documentRef: () => { throw new Error('document getter must be late-bound'); },
  };
  assert.doesNotThrow(() => createPanelSessionUi(deps));
  assert.equal(sessionReads, 0);
  for (const key of ['getSessionController', 'safeDetail', 'initialSnapshot', 'publishSessionState', 'renderCards', 'listen', 'flashMessage']) {
    const missing = { ...deps }; delete missing[key];
    assert.throws(() => createPanelSessionUi(missing), TypeError, `缺少 ${key} 必须构造失败`);
  }
});

test('phase2 production session UI: dispose closes an independent local gate and leaves actual methods callable but inert', async () => {
  const ui = panelSessionHarness();
  for (const method of ['handleSessionMessage', 'handleSessionStateChange', 'flashMessage', 'getDeleteIntent', 'hasDeleteIntent', 'dismissDeleteConfirmation', 'dispose']) {
    assert.equal(typeof ui.ui[method], 'function', `session UI 必须提供实际方法 ${method}`);
  }
  ui.ui.dispose();
  assert.equal(ui.ui.handleSessionMessage({ type: 'FORK_SESSION_COMMAND', command: 'rename', targetCanvasId: 'canvas-test', requestId: 'late', sessionId: 'session-1' }), false,
    'sessionUI.dispose 后必须由自身闸门拒绝迟到 command');
  ui.ui.flashMessage('late feedback');
  assert.equal(ui.documentRef.nodes.has('fork-flash'), false, 'dispose 后不得创建迟到 flash DOM');
  assert.equal(ui.ui.hasDeleteIntent(), false);
});

test('phase2 security: session commands require an exact targetCanvasId; missing/wrong targets have no domain side effects', async () => {
  const cases = [
    ['new', 'newSession'],
    ['switch', 'switchTo'],
    ['refresh', 'refresh'],
    ['rename', 'rename'],
    ['delete', 'remove'],
  ];

  for (const [command, method] of cases) {
    const calls = { newSession: 0, switchTo: 0, refresh: 0, rename: 0, remove: 0 };
    const ui = panelSessionHarness({
      newSession: async () => { calls.newSession++; },
      switchTo: async () => { calls.switchTo++; },
      refresh: async () => { calls.refresh++; },
      rename: async () => { calls.rename++; return { ok: true }; },
      remove: async () => { calls.remove++; return { ok: true }; },
    });
    const commandMessage = target => {
      const message = {
        type: 'FORK_SESSION_COMMAND', command, targetCanvasId: target,
        panelId: 'function-panel', requestId: `${command}-${target || 'missing'}`,
        sessionId: 'session-1',
      };
      if (target === undefined) delete message.targetCanvasId;
      return message;
    };

    for (const target of [undefined, 'canvas-other']) {
      assert.equal(ui.ui.handleSessionMessage(commandMessage(target)), false,
        `${command} 缺失或错 target 时必须被当前 canvas 拒绝`);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, { newSession: 0, switchTo: 0, refresh: 0, rename: 0, remove: 0 });
      assert.equal(ui.getCalls.length, 0, `${command} 被拒绝时不得读取 sessionStore`);
      assert.equal(ui.busMessages.length, 0, `${command} 被拒绝时不得回写 command result`);
      assert.equal(ui.documentRef.nodes.get('delete-session-dialog').open, false,
        `${command} 被拒绝时不得打开删除确认框`);
      assert.deepEqual(ui.flashCalls, [], `${command} 被拒绝时不得产生领域提示副作用`);
    }

    const exact = commandMessage('canvas-test');
    exact.requestId = `${command}-exact`;
    if (command === 'rename') {
      await writeRenameIntent(ui.hana, {
        requestId: exact.requestId, sessionId: 'session-1', title: 'new title', expectedTitle: 'Original',
      });
    }
    assert.equal(ui.ui.handleSessionMessage(exact), true, `${command} 准确 target 必须进入领域处理`);
    await new Promise(resolve => setImmediate(resolve));
    if (command === 'delete') {
      assert.equal(calls.remove, 0, '仅打开 delete 确认时不得提前删除');
      assert.equal(ui.getCalls.length, 1, '准确 target 的 delete 必须读取一次待确认会话');
      assert.equal(ui.documentRef.nodes.get('delete-session-dialog').open, true);
    } else {
      assert.equal(calls[method], 1, `${command} 准确 target 只能调用一次对应领域方法`);
    }
  }
});

test('phase2 behavior: retry button uses explicit retrySave and conflict copy wording', async () => {
  let retryCalls = 0;
  let flushCalls = 0;
  const ui = panelSessionHarness({
    flush: async () => { flushCalls++; },
    retrySave: async () => { retryCalls++; },
  });

  ui.ui.handleSessionStateChange({
    ready: true, busy: false, activeId: 'session-1', title: '会话', dirty: true,
    error: 'SESSION_CONFLICT: remote changed', conflict: 'modified',
  });
  assert.equal(ui.documentRef.nodes.get('btn-retry-save').hidden, false);
  assert.equal(ui.documentRef.nodes.get('btn-save-copy').hidden, false);
  assert.equal(ui.documentRef.nodes.get('btn-retry-save').textContent, '覆盖远端并保存');
  assert.match(ui.documentRef.nodes.get('session-status').textContent, /远端已修改/);

  await ui.documentRef.nodes.get('btn-retry-save').events.click();
  assert.equal(retryCalls, 1);
  assert.equal(flushCalls, 0, '冲突按钮不得退回普通 flush');

  ui.ui.handleSessionStateChange({
    ready: true, busy: false, activeId: 'session-1', title: '会话', dirty: true,
    error: 'SESSION_DELETED: gone', conflict: 'deleted',
  });
  assert.equal(ui.documentRef.nodes.get('btn-retry-save').hidden, true);
  assert.equal(ui.documentRef.nodes.get('btn-save-copy').hidden, false);
  assert.match(ui.documentRef.nodes.get('session-status').textContent, /会话已在别处删除，请另存副本/);

  ui.ui.handleSessionStateChange({
    ready: true, busy: false, activeId: 'session-1', title: '会话', dirty: true,
    error: 'SAVE_DENIED: disk unavailable', conflict: null,
  });
  assert.equal(ui.documentRef.nodes.get('btn-retry-save').textContent, '重试保存');
  await ui.documentRef.nodes.get('btn-retry-save').events.click();
  assert.equal(retryCalls, 2, '普通 I/O 错误也走统一 retrySave 入口');
});

test('phase2 lifecycle: disposed SessionUI button handlers cannot call controllers or mutate DOM', async () => {
  const calls = { newSession: 0, flush: 0, saveCopy: 0, remove: 0 };
  const ui = panelSessionHarness({
    newSession: async () => { calls.newSession++; },
    flush: async () => { calls.flush++; },
    saveCopy: async () => { calls.saveCopy++; },
    remove: async () => { calls.remove++; return { ok: true }; },
  });
  ui.ui.handleSessionMessage({
    type: 'FORK_SESSION_COMMAND', command: 'delete', targetCanvasId: 'canvas-test',
    panelId: 'function-panel', requestId: 'delete-dispose', sessionId: 'session-1',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.documentRef.nodes.get('delete-session-dialog').open, true);

  ui.ui.dispose();
  const ids = ['btn-empty-new-session', 'btn-retry-save', 'btn-save-copy', 'btn-delete-confirm'];
  const before = Object.fromEntries(ids.map(id => {
    const node = ui.documentRef.nodes.get(id);
    return [id, { textContent: node.textContent, disabled: node.disabled, hidden: node.hidden, open: node.open }];
  }));

  for (const id of ids) {
    const node = ui.documentRef.nodes.get(id);
    await node.events.click({ isTrusted: true });
  }

  assert.deepEqual(calls, { newSession: 0, flush: 0, saveCopy: 0, remove: 0 });
  assert.deepEqual(ui.flashCalls, []);
  const after = Object.fromEntries(ids.map(id => {
    const node = ui.documentRef.nodes.get(id);
    return [id, { textContent: node.textContent, disabled: node.disabled, hidden: node.hidden, open: node.open }];
  }));
  assert.deepEqual(after, before, 'dispose 后迟到按钮事件不得再修改 DOM');
});

test('phase2 security: root HELLO route remains target-optional and separate from session commands', async () => {
  const entry = await source(ENTRY);
  assert.match(entry, /FORK_SESSION_HELLO/);
  assert.match(entry, /publishSessionState\(message\.panelId\)/,
    'root 必须继续处理无 target 的 HELLO，并回发对应 panel 状态');
});

test('phase1 production session UI: rename command is locked, failures clear private intent, and late completion after dispose is inert', async () => {
  const renameGate = deferred();
  let renameCalls = 0;
  const ui = panelSessionHarness({ rename: async () => { renameCalls++; return renameGate.promise; } });
  await writeRenameIntent(ui.hana, { requestId: 'rename-1', sessionId: 'session-1', title: 'new title', expectedTitle: 'Original' });
  const command = { type: 'FORK_SESSION_COMMAND', command: 'rename', targetCanvasId: 'canvas-test', panelId: 'function-panel', requestId: 'rename-1', sessionId: 'session-1' };
  assert.equal(ui.ui.handleSessionMessage(command), true);
  assert.equal(ui.ui.handleSessionMessage(command), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renameCalls, 1, '同一 requestId 的 rename command 只能进入一次 session rename');
  ui.dispose();
  renameGate.resolve({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.busMessages.length, 0, '销毁后迟到 rename 完成不得回写结果');
  await assert.rejects(readRenameIntent(ui.hana, 'rename-1', 'session-1'), /过期/);

  const failed = panelSessionHarness({ rename: async () => { throw new Error('SAVE_DENIED'); } });
  await writeRenameIntent(failed.hana, { requestId: 'rename-2', sessionId: 'session-1', title: 'retry', expectedTitle: 'Original' });
  failed.ui.handleSessionMessage({ ...command, requestId: 'rename-2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.busMessages.at(-1).ok, false);
  await assert.rejects(readRenameIntent(failed.hana, 'rename-2', 'session-1'), /过期/);
});

test('phase1 production session UI: delete requires trusted confirmation, rejects busy/duplicate commands, and retries a failed removal', async () => {
  let removeCalls = 0;
  const ui = panelSessionHarness({ remove: async () => ({ ok: ++removeCalls > 1 }) });
  const command = { type: 'FORK_SESSION_COMMAND', command: 'delete', targetCanvasId: 'canvas-test', panelId: 'function-panel', requestId: 'delete-1', sessionId: 'session-1' };
  assert.equal(ui.ui.handleSessionMessage(command), true);
  await Promise.resolve();
  const confirm = ui.documentRef.nodes.get('btn-delete-confirm');
  assert.equal(ui.documentRef.nodes.get('delete-session-dialog').open, true);
  await confirm.events.click({ isTrusted: false });
  assert.equal(removeCalls, 0);
  assert.match(ui.documentRef.nodes.get('delete-dialog-error').textContent, /本人操作/);
  ui.ui.handleSessionMessage({ ...command, requestId: 'delete-duplicate' });
  assert.equal(ui.busMessages.at(-1).ok, false);
  assert.equal(ui.getCalls.length, 1, '已有确认框时重复 command 不得再次读取会话');

  await confirm.events.click({ isTrusted: true });
  assert.equal(removeCalls, 1);
  assert.equal(confirm.disabled, false, '失败后确认按钮必须恢复，允许重试');
  await confirm.events.click({ isTrusted: true });
  assert.equal(removeCalls, 2);
  assert.equal(ui.documentRef.nodes.get('delete-session-dialog').open, false);

  const busy = panelSessionHarness({ busy: true });
  busy.ui.handleSessionMessage(command);
  assert.equal(busy.documentRef.nodes.get('delete-session-dialog').open, false);
  assert.match(busy.busMessages.at(-1).error, /正忙/);
});

 test('phase1 behavior: rename is re-entry safe and a failed intent write clears the submitting latch', async () => {
  const gate = deferred();
  let writes = 0;
  const ui = sessionUiHarness({ writeRenameIntent: async () => { writes++; if (writes === 1) await gate.promise; } });
  await ui.controller.loadSessions();
  ui.controller.openSessionMenu('session-1', 0, 0, null);
  ui.documentRef.nodes.get('session-menu-rename').events.click();
  const input = ui.documentRef.nodes.get('session-rename-input');
  input.value = 'Renamed'; input.events.input({ target: input });
  const first = ui.controller.handleRenameSubmit();
  const second = ui.controller.handleRenameSubmit();
  await Promise.resolve();
  assert.equal(writes, 1, '重入提交不得写两份意图');
  assert.equal(ui.messages.filter(message => message.command === 'rename').length, 0,
    '意图写入未完成前不得发会话 command');
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(ui.messages.filter(message => message.command === 'rename').length, 1);

  const failing = sessionUiHarness({ writeRenameIntent: async () => { throw new Error('intent store down'); } });
  await failing.controller.loadSessions();
  failing.controller.openSessionMenu('session-1', 0, 0, null);
  failing.documentRef.nodes.get('session-menu-rename').events.click();
  const failedInput = failing.documentRef.nodes.get('session-rename-input');
  failedInput.value = 'Retry'; failedInput.events.input({ target: failedInput });
  await failing.controller.handleRenameSubmit();
  assert.match(failing.documentRef.nodes.get('session-status').textContent, /写入重命名意图失败/);
  assert.equal(failing.documentRef.nodes.get('session-rename-save').disabled, false,
    '失败后必须解除 submitting，允许用户重试');
});

test('phase1 behavior: session UI rejects busy/duplicate delete intents and resets cancellation/failure for retry', async () => {
  const ui = sessionUiHarness();
  await ui.controller.loadSessions();
  ui.controller.openSessionMenu('session-1', 0, 0, null);
  ui.documentRef.nodes.get('session-menu-delete').events.click();
  assert.equal(ui.messages.filter(message => message.command === 'delete').length, 1);
  ui.controller.handleDeleteFromMenu('session-1');
  assert.equal(ui.messages.filter(message => message.command === 'delete').length, 1,
    '重复确认窗口不得重复派发 delete command');

  const request = ui.messages.find(message => message.command === 'delete');
  ui.controller.handleSessionResult({ targetPanelId: 'panel-test', canvasId: 'canvas-test',
    command: 'delete', requestId: request.requestId, cancelled: true });
  assert.equal(ui.documentRef.nodes.get('session-status').textContent, '');

  ui.controller.openSessionMenu('session-1', 0, 0, null);
  ui.documentRef.nodes.get('session-menu-delete').events.click();
  const retry = ui.messages.at(-1);
  ui.controller.handleSessionResult({ targetPanelId: 'panel-test', canvasId: 'canvas-test',
    command: 'delete', requestId: retry.requestId, ok: false, error: 'SAVE_DENIED' });
  assert.match(ui.documentRef.nodes.get('session-status').textContent, /删除失败/);

  const busy = sessionUiHarness({ canvas: { busy: true } });
  await busy.controller.loadSessions();
  busy.controller.openSessionMenu('session-1', 0, 0, null);
  busy.controller.handleDeleteFromMenu('session-1');
  assert.equal(busy.messages.filter(message => message.command === 'delete').length, 0,
    '画布忙时不得发起删除确认');
});

test('phase1 behavior: document attachment keeps the complete schema and drops late generation results', async () => {
  let generation = 7;
  const card = { id: 'card-1', stagedAttachments: [] };
  let extract = async () => ({ ok: true, filename: 'report.md', size: 12, extension: '.md', charCount: 9, lineCount: 2, text: '正文', preview: '正文' });
  const deps = {
    extractDocumentFile: (...args) => extract(...args),
    flashMessage() {}, canMutateCanvas: token => token === undefined || token === generation,
    getCards: () => [card], getSession: () => ({ generation }), renderCards() {}, scheduleSave() {},
    createDocumentCard() {}, getView: () => null, getViewport: () => null, getDropIndicator: () => null,
    getIsDisposed: () => false, later() {}, cancelLater() {},
  };
  const ui = createDocumentUi(deps);
  assert.equal(await ui.attachFilesToCard(card, [{ name: 'report.md' }]), true);
  assert.deepEqual(card.stagedAttachments[0], {
    name: 'report.md', size: 12, extension: '.md', charCount: 9, lineCount: 2,
    content: '正文', preview: '正文',
  });

  let release;
  extract = () => new Promise(resolve => { release = resolve; });  const late = ui.attachFilesToCard(card, [{ name: 'old.md' }]);
  generation = 8;
  release({ ok: true, filename: 'old.md', size: 1, extension: '.md', charCount: 1, lineCount: 1, text: '迟到', preview: '迟到' });
  assert.equal(await late, false);
  assert.equal(card.stagedAttachments.some(item => item.name === 'old.md'), false,
    'generation 变化后迟到解析结果不得写入当前卡片');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { deriveCanvasPresentation, createPanelSessionUi } from '../ui/assets/panel-session-ui.js';
import { memoryHost } from './helpers/fork-memory.mjs';

/*
 * Task 1 - 统一空状态语义。
 *
 * 派生状态只回答一个问题：这一刻画布该显示哪种引导/内容。
 * 它不读 DOM 数量、不读 visibleCards、不根据 cards.length 猜有没有会话。
 * empty-session 才允许出现发射台；no-session 与 no-active 共用空状态节点，
 * 但两者的文案归属由 Task 2 的 HTML 决定，这里只保证互斥显示。
 */

const state = (overrides = {}) => ({
  ready: true,
  busy: false,
  saving: false,
  dirty: false,
  error: '',
  notice: '',
  conflict: null,
  activeId: 'session-1',
  activeRevision: 1,
  title: '会话一',
  sessions: [{ id: 'session-1', title: '会话一' }],
  generation: 1,
  ...overrides,
});

test('deriveCanvasPresentation: 七种状态各有唯一归属', () => {
  assert.equal(deriveCanvasPresentation(state({ ready: false }), 0), 'booting');
  assert.equal(deriveCanvasPresentation(state({ ready: false, error: 'SESSION_STORE_CORRUPT: bad' }), 0), 'restore-error');
  assert.equal(deriveCanvasPresentation(state({ busy: true }), 2), 'transitioning');
  assert.equal(deriveCanvasPresentation(state({ activeId: null, sessions: [] }), 0), 'no-session');
  assert.equal(deriveCanvasPresentation(state({ activeId: null }), 0), 'no-active');
  assert.equal(deriveCanvasPresentation(state(), 0), 'empty-session');
  assert.equal(deriveCanvasPresentation(state(), 3), 'content');
});

test('deriveCanvasPresentation: 缺省状态按未就绪处理，非数组 sessions 视为空', () => {
  assert.equal(deriveCanvasPresentation(undefined, 0), 'booting');
  assert.equal(deriveCanvasPresentation(null, 0), 'booting');
  assert.equal(deriveCanvasPresentation({}, 4), 'booting');
  assert.equal(deriveCanvasPresentation({ ready: false, error: 'BOOT_FAIL' }, 4), 'restore-error');
  assert.equal(deriveCanvasPresentation(state({ activeId: null, sessions: undefined }), 0), 'no-session');
  assert.equal(deriveCanvasPresentation(state({ activeId: null, sessions: null }), 0), 'no-session');
});

test('deriveCanvasPresentation: 保存错误与冲突是正交状态，不改变内容归属', () => {
  const conflict = state({ error: 'SESSION_CONFLICT: revision mismatch', conflict: 'modified', dirty: true });
  assert.equal(deriveCanvasPresentation(conflict, 2), 'content');
  assert.equal(deriveCanvasPresentation(conflict, 0), 'empty-session');

  const saveError = state({ error: 'SAVE_DENIED: disk unavailable', dirty: true });
  assert.equal(deriveCanvasPresentation(saveError, 1), 'content');

  // 未就绪 + 错误才是恢复失败；恢复失败优先级高于 busy/卡片数量。
  assert.equal(deriveCanvasPresentation(state({ ready: false, error: 'BOOT_FAIL', busy: true }), 5), 'restore-error');
});

test('deriveCanvasPresentation: 切换中的画布不落空引导，无活动会话优先于卡片数量', () => {
  assert.equal(deriveCanvasPresentation(state({ busy: true, activeId: 'session-2' }), 0), 'transitioning');
  assert.equal(deriveCanvasPresentation(state({ busy: true, activeId: null, sessions: [] }), 0), 'transitioning');
  // activeId 缺失时即使模型里还残留卡片也必须落在 no-active，不能宣称是空会话。
  assert.equal(deriveCanvasPresentation(state({ activeId: null }), 3), 'no-active');
  // cardCount 非法/缺省按空画布处理，不能因为 NaN 误判为 content。
  assert.equal(deriveCanvasPresentation(state(), undefined), 'empty-session');
  assert.equal(deriveCanvasPresentation(state(), Number.NaN), 'empty-session');
});

// ---------------------------------------------------------------------------
// syncCanvasPresentation：DOM 归属、保存指示灯、dispose 与晚绑定契约
// ---------------------------------------------------------------------------

class FakeNode {
  constructor() {
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = '';
    this.attributes = {};
    this.dataset = {};
    this.events = {};
  }
  classList = { add() {}, remove() {}, toggle() {} };
  addEventListener(type, handler) { this.events[type] = handler; }
  removeEventListener() {}
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'hidden') this.hidden = true; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'hidden') this.hidden = false; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

function presentationHarness({ onCount, onNode } = {}) {
  const nodes = new Map();
  const ids = [
    'delete-session-dialog', 'delete-target-title', 'delete-dialog-error', 'delete-dialog-progress',
    'btn-delete-confirm', 'btn-delete-cancel', 'session-status', 'btn-retry-save',
    'btn-save-copy', 'btn-new-root', 'btn-empty-new-session',
    'session-save-indicator', 'session-empty-state', 'canvas-launchpad',
    'canvas-loading-state', 'surface',
  ];
  for (const id of ids) { const node = new FakeNode(); nodes.set(id, node); }
  const documentRef = {
    nodes,
    activeElement: null,
    createElement: () => new FakeNode(),
    getElementById(id) { return nodes.get(id) || null; },
    body: new FakeNode(),
    addEventListener() {},
    removeEventListener() {},
  };
  const controllerState = { ...state() };
  const sessionController = { generation: 1, get state() { return controllerState; } };
  let cardCount = 0;
  let disposed = false;
  const rendered = [];
  const flashed = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    return () => {};
  };
  const countGetter = () => {
    if (onCount) onCount();
    return cardCount;
  };
  const lateNode = id => () => {
    if (onNode) onNode(id);
    return nodes.get(id);
  };
  const ui = createPanelSessionUi({
    hana: {}, sessionStore: { get() {} }, getSessionController: () => sessionController,
    bus: { postMessage() {} }, canvasId: 'canvas-test',
    safeDetail: value => String(value), initialSnapshot: () => ({}),
    publishSessionState() {}, renderCards: preserve => rendered.push(preserve), listen,
    flashMessage: message => flashed.push(String(message)),
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
    getCardCount: countGetter,
    sessionSaveIndicator: lateNode('session-save-indicator'),
    sessionEmptyState: lateNode('session-empty-state'),
    canvasLaunchpad: lateNode('canvas-launchpad'),
    canvasLoadingState: lateNode('canvas-loading-state'),
    canvasSurface: lateNode('surface'),
    documentRef: () => documentRef,
    isDisposed: () => disposed,
    hasActiveRequests: () => false,
  });
  return {
    ui, nodes, documentRef, rendered, flashed,
    setState(next) { Object.assign(controllerState, next); },
    setCardCount(next) { cardCount = next; },
    dispose() { disposed = true; ui.dispose(); },
  };
}

const indicatorState = node => node.dataset?.state ?? node.attributes?.['data-state'] ?? node.getAttribute?.('data-state');

test('syncCanvasPresentation: 构造期不调用卡片计数和晚绑定节点 getter', () => {
  let countReads = 0;
  const nodeReads = [];
  presentationHarness({ onCount: () => { countReads += 1; }, onNode: id => nodeReads.push(id) });
  assert.equal(countReads, 0, '构造期不得读取卡片数量');
  assert.deepEqual(nodeReads, [], '构造期不得解析晚绑定展示节点');
});

test('syncCanvasPresentation: booting 隐藏画布内容与卡片，用独立加载态占位', () => {
  const h = presentationHarness();
  h.setState({ ready: false, error: '', activeId: null, sessions: [] });
  assert.equal(h.ui.syncCanvasPresentation(), undefined, '同步函数返回 void');
  assert.equal(h.nodes.get('canvas-loading-state').hidden, false);
  assert.equal(indicatorState(h.nodes.get('canvas-loading-state')), 'booting');
  assert.equal(h.nodes.get('surface').hidden, true, '首次恢复未完成时不得闪现临时卡片');
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(h.nodes.get('session-empty-state').hidden, true);
  assert.equal(indicatorState(h.nodes.get('session-save-indicator')), 'booting');
});

test('syncCanvasPresentation: restore-error 展示独立错误态，首次未恢复不露出临时默认卡', () => {
  const h = presentationHarness();
  h.setState({ ready: false, error: 'SESSION_STORE_CORRUPT: bad doc', activeId: null, sessions: [] });
  h.ui.handleSessionStateChange(state({ ready: false, error: 'SESSION_STORE_CORRUPT: bad doc', activeId: null, sessions: [] }));
  assert.equal(h.nodes.get('canvas-loading-state').hidden, false);
  assert.equal(indicatorState(h.nodes.get('canvas-loading-state')), 'restore-error');
  assert.equal(h.nodes.get('surface').hidden, true, '首次恢复失败同样不能露出临时默认卡');
  assert.equal(indicatorState(h.nodes.get('session-save-indicator')), 'error');
  assert.match(h.nodes.get('session-status').textContent, /SESSION_STORE_CORRUPT/);
});

test('syncCanvasPresentation: 已就绪后的保存错误保留真实本地内容可见', () => {
  const h = presentationHarness();
  h.setCardCount(2);
  h.setState({ error: 'SAVE_DENIED: disk unavailable', dirty: true });
  h.ui.handleSessionStateChange(state({ error: 'SAVE_DENIED: disk unavailable', dirty: true }));
  assert.equal(h.nodes.get('surface').hidden, false, '已恢复内容不得因保存错误被藏起来');
  assert.equal(h.nodes.get('canvas-loading-state').hidden, true, '保存错误不是恢复失败占位');
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(h.nodes.get('session-empty-state').hidden, true);
  assert.equal(indicatorState(h.nodes.get('session-save-indicator')), 'error');
  assert.match(h.nodes.get('session-status').textContent, /SAVE_DENIED/);
});

test('syncCanvasPresentation: 切换中不闪空引导，也不显示加载占位', () => {
  const h = presentationHarness();
  h.setCardCount(0);
  h.setState({ busy: true, activeId: 'session-2' });
  h.ui.syncCanvasPresentation();
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(h.nodes.get('session-empty-state').hidden, true);
  assert.equal(h.nodes.get('canvas-loading-state').hidden, true);
  assert.equal(h.nodes.get('surface').hidden, false);
  assert.equal(indicatorState(h.nodes.get('session-save-indicator')), 'busy');
});

test('syncCanvasPresentation: 只有 empty-session 显示发射台，no-session/no-active 走空状态', () => {
  const h = presentationHarness();
  h.setCardCount(0);
  h.setState({ activeId: 'session-1', sessions: [{ id: 'session-1' }] });
  h.ui.syncCanvasPresentation();
  assert.equal(h.nodes.get('canvas-launchpad').hidden, false);
  assert.equal(h.nodes.get('session-empty-state').hidden, true);

  h.setState({ activeId: null, sessions: [{ id: 'session-1' }] });
  h.ui.syncCanvasPresentation();
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(h.nodes.get('session-empty-state').hidden, false);

  h.setState({ activeId: null, sessions: [] });
  h.ui.syncCanvasPresentation();
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(h.nodes.get('session-empty-state').hidden, false);
});

test('syncCanvasPresentation: 卡片数量变化后重新同步，content 收拢全部引导', () => {
  const h = presentationHarness();
  h.setCardCount(0);
  h.ui.syncCanvasPresentation();
  assert.equal(h.nodes.get('canvas-launchpad').hidden, false);

  h.setCardCount(2);
  h.ui.syncCanvasPresentation();
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(h.nodes.get('session-empty-state').hidden, true);
  assert.equal(h.nodes.get('canvas-loading-state').hidden, true);
  assert.equal(h.nodes.get('surface').hidden, false);
  assert.equal(indicatorState(h.nodes.get('session-save-indicator')), 'saved');
});

test('syncCanvasPresentation: 保存指示灯按 booting/busy/saving/dirty/saved/error 标注，文本错误详情保留', () => {
  const h = presentationHarness();
  const indicator = () => indicatorState(h.nodes.get('session-save-indicator'));
  const status = () => h.nodes.get('session-status').textContent;

  h.setState({ saving: true, dirty: true });
  h.ui.syncCanvasPresentation();
  assert.equal(indicator(), 'saving');

  h.setState({ saving: false, dirty: true });
  h.ui.syncCanvasPresentation();
  assert.equal(indicator(), 'dirty');

  h.setState({ dirty: false });
  h.ui.syncCanvasPresentation();
  assert.equal(indicator(), 'saved');

  h.setState({ error: 'SAVE_DENIED: disk unavailable', dirty: true });
  h.ui.handleSessionStateChange(state({ error: 'SAVE_DENIED: disk unavailable', dirty: true }));
  assert.equal(indicator(), 'error', '保存错误优先于 dirty 指示灯');
  assert.match(status(), /SAVE_DENIED/);
  assert.match(status(), /未保存/);
});

test('syncCanvasPresentation: 同步不重建卡片，dispose 后不留副作用', () => {
  const h = presentationHarness();
  h.ui.syncCanvasPresentation();
  assert.deepEqual(h.rendered, [], '展示同步不能触发卡片重绘');
  assert.deepEqual(h.flashed, [], '普通状态同步不能刷提示');

  h.dispose();
  const before = new Map([...h.nodes].map(([id, node]) => [id, { hidden: node.hidden, text: node.textContent, state: indicatorState(node) }]));
  h.setState({ activeId: null, sessions: [] });
  h.setCardCount(7);
  assert.equal(h.ui.syncCanvasPresentation(), undefined);
  const after = new Map([...h.nodes].map(([id, node]) => [id, { hidden: node.hidden, text: node.textContent, state: indicatorState(node) }]));
  assert.deepEqual(after, before, 'dispose 后迟到同步不得改动 DOM');
});

test('syncCanvasPresentation: 新展示节点缺省或 getter 返回 null 时安全跳过', () => {
  const h = presentationHarness();
  for (const id of ['session-save-indicator', 'session-empty-state', 'canvas-launchpad', 'canvas-loading-state']) {
    h.nodes.set(id, null);
  }
  assert.doesNotThrow(() => h.ui.syncCanvasPresentation());
  // 没有任何新节点时仍要保持既有状态文本与恢复按钮的行为。
  h.setState({ error: 'SAVE_DENIED: disk unavailable', dirty: true });
  h.ui.handleSessionStateChange(state({ error: 'SAVE_DENIED: disk unavailable', dirty: true }));
  assert.equal(h.nodes.get('btn-retry-save').hidden, false);
  assert.match(h.nodes.get('session-status').textContent, /SAVE_DENIED/);
});

test('handleSessionStateChange: 状态通知同步展示且沿用既有重绘闸门', () => {
  const h = presentationHarness();
  h.setCardCount(0);
  h.setState({ activeId: 'session-1', ready: true, busy: false });
  h.ui.handleSessionStateChange(state({ activeId: 'session-1', ready: true, busy: false }));
  assert.equal(h.nodes.get('canvas-launchpad').hidden, false);
  assert.ok(h.rendered.length >= 1, '阶段变化仍然触发既有 renderCards');

  const rendersBefore = h.rendered.length;
  h.setState({ busy: true });
  h.ui.handleSessionStateChange(state({ busy: true }));
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true, '切换中不得闪空引导');
  assert.equal(h.rendered.length, rendersBefore + 1, 'ready:busy 相位变化用既有重绘闸门');

  const rendersWhileBusy = h.rendered.length;
  h.nodes.get('canvas-launchpad').hidden = false;
  h.ui.handleSessionStateChange(state({ busy: true }));
  assert.equal(h.nodes.get('canvas-launchpad').hidden, true, '重复通知仍会同步展示');
  assert.equal(h.rendered.length, rendersWhileBusy, '相位不变的重复通知不应额外重绘');
});

// ---------------------------------------------------------------------------
// 真实入口：零卡片布局同步、默认初始卡与空状态归属
// ---------------------------------------------------------------------------

class Element {
  constructor(registry, document) {
    this.registry = registry;
    this.document = document;
    this.children = [];
    this.events = {};
    this.nodes = new Map();
    this.style = {};
    this.value = '';
    this.attributes = {};
    this.hidden = false;
    this.open = false;
    const classes = new Set();
    this.classList = {
      add(...tokens) { tokens.forEach(token => classes.add(token)); },
      remove(...tokens) { tokens.forEach(token => classes.delete(token)); },
      contains(token) { return classes.has(token); },
      toggle(token, force) {
        const shouldAdd = force === undefined ? !classes.has(token) : Boolean(force);
        if (shouldAdd) classes.add(token); else classes.delete(token);
        return classes.has(token);
      },
    };
  }
  set id(value) { this.elementId = value; this.registry?.set(value, this); }
  get id() { return this.elementId || ''; }
  focus() { if (this.document) this.document.activeElement = this; }
  blur() { if (this.document && this.document.activeElement === this) this.document.activeElement = null; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  select() { this.setSelectionRange(0, this.value.length); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 20, bottom: 20, width: 156, height: 80 }; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'hidden') this.hidden = false; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'hidden') this.hidden = true; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, handler) { this.events[type] = handler; }
  removeEventListener(type, handler) { if (this.events[type] === handler) delete this.events[type]; }
  querySelectorAll() {
    const descend = node => node.children.flatMap(child => [child, ...descend(child)]);
    return descend(this);
  }
  querySelector(selector) {
    if (!this.nodes.has(selector)) {
      const element = new Element(this.registry, this.document);
      if (/^#[\w-]+$/.test(selector)) element.id = selector.slice(1);
      this.nodes.set(selector, element);
    }
    return this.nodes.get(selector);
  }
}

function uiEnvironment() {
  const nodes = new Map();
  const windowEvents = {}, documentEvents = {};
  const localValues = new Map();
  const document = {
    addEventListener(type, callback) { documentEvents[type] = callback; },
    getElementById(id) {
      if (!nodes.has(id)) { const element = new Element(nodes, document); element.id = id; }
      return nodes.get(id);
    },
    createElement() { return new Element(nodes, document); },
    createElementNS() { return new Element(nodes, document); },
    querySelectorAll() { return []; },
  };
  document.body = new Element(nodes, document);
  const environment = {
    document,
    localStorage: { getItem(key) { return localValues.get(key) ?? null; }, setItem(key, value) { localValues.set(key, value); } },
    window: {
      innerWidth: 300, innerHeight: 800,
      addEventListener(type, handler) { windowEvents[type] = handler; },
      removeEventListener(type, handler) { if (windowEvents[type] === handler) delete windowEvents[type]; },
    },
    BroadcastChannel: class {
      constructor() { this.listeners = []; channels.push(this); }
      postMessage(message) { broadcasts.push(message); }
      addEventListener(type, callback) { if (type === 'message') this.listeners.push(callback); }
    },
  };
  const broadcasts = [];
  const channels = [];
  return { environment, nodes, windowEvents, documentEvents, broadcasts, channels,
    receive(message) {
      for (const channel of channels) {
        channel.onmessage?.({ data: message });
        for (const listener of channel.listeners) listener({ data: message });
      }
    } };
}

const MODULES = [
  'panel-layout.js', 'panel-shortcuts.js', 'panel-format.js', 'panel-documents.js',
  'panel-artifact-view.js', 'panel-artifact-panel.js', 'panel-chat-engine.js',
  'panel-battle-flow.js', 'panel-merge.js', 'panel-cards.js', 'panel-history.js',
  'panel-agents.js', 'panel-canvas-view.js', 'panel-canvas-actions.js',
  'panel-selection.js', 'panel-selection-popover.js', 'panel-topology-export.js',
  'panel-context-plan.js', 'panel-context-preview.js', 'panel-refs.js',
  'panel-history-controller.js', 'panel-bridge-send.js', 'panel-bridge-intents.js',
  'panel-handoff.js', 'panel-bridge.js', 'panel-document-ui.js', 'panel-card-gestures.js',
  'panel-card-events.js', 'panel-renderer.js', 'panel-render-diff.js',
  'panel-search-controller.js', 'panel-session-state.js', 'panel-session-ui.js',
  'panel-feedback.js', 'panel-search.js', 'panel-context.js', 'panel-messages.js',
  'panel-viewport.js', 'panel-battle.js', 'panel-connectors.js', 'function-agents.js',
  'function-sessions.js', 'panel-canvas-tools.js',
];
const assetModules = Object.fromEntries(await Promise.all(
  MODULES.map(async name => [name, await import(new URL(`../ui/assets/${name}`, import.meta.url))]),
));
const hostApi = await import('../ui/assets/host-api.js');
const chatClient = await import('../ui/assets/chat-client.js');
const assistantOutput = await import('../ui/assets/assistant-output.js');
const sessionStoreModule = await import('../ui/assets/fork-session-store.js');
const sessionControllerModule = await import('../ui/assets/fork-session-controller.js');
const sessionCommands = await import('../ui/assets/fork-session-commands.js');

function imports(hana, host) {
  const map = {
    './sdk.js': { hana },
    './host-api.js': hostApi,
    './chat-client.js': chatClient,
    './assistant-output.js': assistantOutput,
    './fork-session-store.js': {
      createForkSessionStore: sdk => sessionStoreModule.createForkSessionStore(sdk, { locks: host.locks }),
    },
    './fork-session-controller.js': sessionControllerModule,
    './fork-session-commands.js': sessionCommands,
  };
  for (const [name, namespace] of Object.entries(assetModules)) map[`./${name}`] = namespace;
  return map;
}

async function loadPanel(hana, host, environment) {
  const context = vm.createContext({
    console, Response, ReadableStream, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout, btoa, atob, ...environment,
  });
  const source = await readFile(new URL('../ui/assets/panel.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: '../ui/assets/panel.js' });
  const mapping = imports(hana, host);
  await module.link(async specifier => {
    const exports = mapping[specifier];
    assert.ok(exports, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module;
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const dataState = node => node.dataset?.state ?? node.attributes?.['data-state'] ?? node.getAttribute?.('data-state');

function emptySessionDocument(id = 'sess_empty') {
  return {
    version: 2,
    initialized: true,
    activeId: id,
    sessions: [{
      id, title: '空画布', revision: 1, createdAt: 1, updatedAt: 1, manualTitle: false,
      snapshot: { cards: [], view: { x: 60, y: 40, scale: 1 }, agent: { id: 'agent-a', name: 'A', model: 'm', provider: 'p' } },
    }],
  };
}

test('panel entry: 默认初始卡保持，内容态收拢引导', async () => {
  const hana = { ready() {} };
  const host = memoryHost();
  hana.storage = host.storage;
  const ui = uiEnvironment();
  await loadPanel(hana, host, ui.environment);
  await flush();
  assert.equal(ui.nodes.get('cards-layer').children.length, 1, '新会话仍带一张默认初始卡');
  assert.equal(ui.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(ui.nodes.get('session-empty-state').hidden, true);
  assert.equal(ui.nodes.get('surface').hidden, false);
  assert.equal(dataState(ui.nodes.get('session-save-indicator')), 'saved');
  ui.windowEvents.pagehide?.();
  await flush();
});

test('panel entry: 首次恢复失败不露出临时默认卡，恢复失败占位可见', async () => {
  const hana = { ready() {} };
  const host = memoryHost();
  const readError = Object.assign(new Error('bad doc'), { code: 'FORK_STORE_READ_FAILED' });
  hana.storage = {
    global: {
      async get() { throw readError; },
      async set() {},
      async delete() {},
      onChanged() { return () => {}; },
    },
  };
  const ui = uiEnvironment();
  await loadPanel(hana, host, ui.environment);
  await flush();

  assert.equal(ui.nodes.get('cards-layer').children.length, 1, '临时默认卡只在 DOM 里存在，不代表已恢复');
  assert.equal(ui.nodes.get('surface').hidden, true, '恢复失败时也不得露出临时默认卡');
  assert.equal(ui.nodes.get('canvas-loading-state').hidden, false);
  assert.equal(dataState(ui.nodes.get('canvas-loading-state')), 'restore-error');
  assert.equal(ui.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(ui.nodes.get('session-empty-state').hidden, true);
  assert.equal(dataState(ui.nodes.get('session-save-indicator')), 'error');
  assert.match(ui.nodes.get('session-status').textContent, /FORK_STORE_READ_FAILED/);

  ui.windowEvents.pagehide?.();
  await flush();
});

test('panel entry: 零卡片活动会话显示发射台，且零卡片布局调用后仍同步', async () => {
  const hana = { ready() {} };
  const host = memoryHost();
  hana.storage = host.storage;
  host.values.set(sessionStoreModule.FORK_SESSION_STORAGE_KEY, emptySessionDocument());
  const ui = uiEnvironment();
  await loadPanel(hana, host, ui.environment);
  await flush();

  assert.equal(ui.nodes.get('cards-layer').children.length, 0);
  assert.equal(ui.nodes.get('canvas-launchpad').hidden, false, '活动会话零卡片才是发射台的归属');
  assert.equal(ui.nodes.get('session-empty-state').hidden, true, '不得宣称所有会话已清空');
  assert.equal(ui.nodes.get('canvas-loading-state').hidden, true);

  // 布局专用重绘（renderer 早退路径）之后包装层仍须重新同步展示。
  ui.nodes.get('canvas-launchpad').hidden = true;
  ui.nodes.get('session-empty-state').hidden = false;
  ui.environment.window.__forkChat.renderCards(true, { layoutOnly: true });
  assert.equal(ui.nodes.get('canvas-launchpad').hidden, false);
  assert.equal(ui.nodes.get('session-empty-state').hidden, true);
  assert.equal(ui.nodes.get('cards-layer').children.length, 0, '布局重绘不得凭空建卡');

  ui.windowEvents.pagehide?.();
  await flush();
});

test('panel entry: 删掉最后一个会话后进入 no-session，不自动新建也不显示发射台', async () => {
  const hana = { ready() {} };
  const host = memoryHost();
  hana.storage = host.storage;
  const ui = uiEnvironment();
  await loadPanel(hana, host, ui.environment);
  await flush();
  const forkChat = ui.environment.window.__forkChat;
  const activeId = canvasState(ui).activeId;
  assert.ok(activeId);

  ui.receive({ type: 'FORK_SESSION_COMMAND', targetCanvasId: canvasState(ui).canvasId,
    command: 'delete', sessionId: activeId, panelId: 'test-panel', requestId: 'req-delete' });
  await flush();
  await ui.nodes.get('btn-delete-confirm').events.click({ isTrusted: true });
  await flush();

  assert.equal(canvasState(ui).activeId, null);
  assert.equal((await sessionStoreModule.createForkSessionStore(hana, { locks: host.locks }).list()).sessions.length, 0);
  assert.equal(ui.nodes.get('canvas-launchpad').hidden, true);
  assert.equal(ui.nodes.get('session-empty-state').hidden, false);
  assert.equal(forkChat.getCards().length, 0);
  ui.windowEvents.pagehide?.();
  await flush();
});

function canvasState(ui) {
  return ui.broadcasts.filter(message => message.type === 'FORK_SESSION_STATE').at(-1) || {};
}

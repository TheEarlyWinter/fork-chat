import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createCanvasActions } from '../ui/assets/panel-canvas-actions.js';
import { createBridge } from '../ui/assets/panel-bridge.js';
import { memoryHost } from './helpers/fork-memory.mjs';

/*
 * Task 1 - 宿主导入的安全边界。
 *
 * 没有活动会话时，宿主导入必须 fail-closed：
 * 不建内存孤卡、不标脏、不落盘、不 ACK；手动导入保留对话框并说明原因，
 * 自动 intent 释放已领取的凭条。活动会话路径保持既有的「先 flush 后 ACK」次序。
 */

const ACTIVE_REJECT = '请先新建画布会话，再导入本体内容。';

class FakeNode {
  constructor() {
    this.textContent = '';
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

function documentStub(ids) {
  const nodes = new Map();
  for (const id of ids) { const node = new FakeNode(); nodes.set(id, node); }
  return {
    nodes,
    getElementById(id) { return nodes.get(id) || null; },
    createElement: () => new FakeNode(),
    addEventListener() {},
    removeEventListener() {},
  };
}

const BRIDGE_NODE_IDS = [
  'bridge-dialog', 'bridge-session-select', 'bridge-kind-select', 'bridge-leaf-select',
  'bridge-leaf-field', 'bridge-preview', 'bridge-dialog-error', 'btn-bridge-import',
  'bridge-active-hint',
];

function canvasActionsHarness({ activeId = 'session-1', ready = true, busy = false } = {}) {
  const calls = { setCards: 0, render: 0, save: 0, snapshot: 0, select: 0, focus: 0, newSession: 0, flash: [] };
  let cards = [];
  const controller = {
    generation: 3,
    state: { ready, busy, activeId },
    async newSession() { calls.newSession += 1; },
  };
  const actions = createCanvasActions({
    getCards: () => cards,
    setCards: next => { calls.setCards += 1; cards = next; },
    getSelectedCardId: () => null,
    setSelectedCardId() {},
    canMutateCanvas: () => true,
    chainIsBusy: () => false,
    abortActiveRequest() {},
    abortDocumentTasksFor() {},
    calculateBranchYPositions: (_card, _count, x) => [0, x],
    renderCards: () => { calls.render += 1; },
    scheduleSave: () => { calls.save += 1; },
    recordSnapshot: () => { calls.snapshot += 1; },
    selectCard: () => { calls.select += 1; },
    focusCardInViewport: () => { calls.focus += 1; },
    getSessionController: () => controller,
    initialSnapshot: () => ({ cards: [], view: { x: 0, y: 0, scale: 1 } }),
    uniqueId: prefix => `${prefix}-test`,
    flashMessage: message => { calls.flash.push(String(message)); },
    isDisposed: () => false,
    extractDocumentFile: async () => ({ ok: false }),
  });
  return { actions, calls, getCards: () => cards };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const bridgePayload = {
  title: '本体会话',
  text: '# 本体会话\n\n【用户】问题',
  sourceRef: {
    version: 1, kind: 'hana-session', sessionId: 'sess-1', entryIds: ['e1'], leafId: 'e1',
    titleAtImport: '本体会话', importedAt: '2026-10-26T00:00:00.000Z', contentHash: 'hash-1', importKind: 'history',
  },
  messageCount: 1,
};

test('createBridgeDocCard: 无 activeId 直接拒绝，不建卡、不标脏、不落盘、不自动建会话', () => {
  const h = canvasActionsHarness({ activeId: null });
  const result = h.actions.createBridgeDocCard({ ...bridgePayload });
  assert.equal(result, null);
  assert.equal(h.getCards().length, 0, '不得生成内存孤卡');
  assert.deepEqual(h.calls.flash, [ACTIVE_REJECT]);
  assert.deepEqual(
    { setCards: h.calls.setCards, render: h.calls.render, save: h.calls.save, snapshot: h.calls.snapshot, select: h.calls.select, focus: h.calls.focus, newSession: h.calls.newSession },
    { setCards: 0, render: 0, save: 0, snapshot: 0, select: 0, focus: 0, newSession: 0 },
    '无活动会话时不得自动创建/切换目标，也不得产生任何画布副作用',
  );
});

test('createBridgeDocCard: 活动会话仍同步建卡并保存', () => {
  const h = canvasActionsHarness();
  const card = h.actions.createBridgeDocCard({ ...bridgePayload });
  assert.ok(card && card.isDoc);
  assert.equal(h.getCards().length, 1);
  assert.equal(h.calls.save, 1);
  assert.equal(h.calls.snapshot, 1);
  assert.deepEqual(h.calls.flash, []);
});

function bridgeHarness({ actions, preview = null, flushError = null, canMutate = null, onFlush = null } = {}) {
  const documentRef = documentStub(BRIDGE_NODE_IDS);
  documentRef.nodes.get('bridge-session-select').value = 'sess-1';
  const calls = [];
  const flashes = [];
  const releases = [];
  const order = [];
  const contact = { flush: 0 };
  const previewData = preview || {
    kind: 'history',
    session: { sessionId: 'sess-1', title: '本体会话' },
    messages: [{ role: 'user', text: '问题', entryId: 'e1' }],
    leafId: 'e1',
    status: {},
  };
  const bridge = createBridge({
    documentRef,
    hana: {},
    isDisposed: () => false,
    bridgeRequest: async (path, init) => {
      calls.push({ path, init });
      if (path === '/api/bridge/preview') return { preview: previewData };
      if (path.endsWith('/release')) return { released: true };
      if (path.endsWith('/ack')) { order.push('ack'); return { acknowledged: true }; }
      return {};
    },
    safeDetail: value => String(value),
    escapeHtml: value => String(value),
    flashMessage: message => { flashes.push(String(message)); },
    canMutateCanvas: generation => (typeof canMutate === 'function' ? canMutate(generation) : true),
    getGeneration: () => 3,
    createBridgeDocCard: payload => actions.createBridgeDocCard(payload),
    flushSession: async () => {
      contact.flush += 1;
      order.push('flush');
      if (onFlush) await onFlush();
      if (flushError) throw flushError;
    },
    getCanvasId: () => 'canvas-test',
    getOwnedClaims: () => new Set(),
    listen: (target, type, handler) => { target.addEventListener(type, handler); return () => {}; },
    bridgeDialogEl: documentRef.nodes.get('bridge-dialog'),
    bridgeSessionSelect: documentRef.nodes.get('bridge-session-select'),
    bridgeKindSelect: documentRef.nodes.get('bridge-kind-select'),
    bridgeLeafSelect: documentRef.nodes.get('bridge-leaf-select'),
    bridgeLeafField: documentRef.nodes.get('bridge-leaf-field'),
    bridgePreviewEl: documentRef.nodes.get('bridge-preview'),
    bridgeErrorEl: documentRef.nodes.get('bridge-dialog-error'),
    bridgeImportBtn: documentRef.nodes.get('btn-bridge-import'),
    bridgeActiveHint: documentRef.nodes.get('bridge-active-hint'),
  });
  return {
    bridge, documentRef, calls, flashes, releases, contact, order,
    routes: () => calls.map(call => call.path),
    error: () => documentRef.nodes.get('bridge-dialog-error').textContent,
    dialog: () => documentRef.nodes.get('bridge-dialog'),
    importBtn: () => documentRef.nodes.get('btn-bridge-import'),
  };
}

test('手动导入: 无 activeId 不建卡、不落盘，对话框保留并给出提示', async () => {
  const ctx = canvasActionsHarness({ activeId: null });
  const h = bridgeHarness({ actions: ctx.actions });
  await h.bridge.importBridgePreview();
  assert.equal(ctx.getCards().length, 0);
  assert.equal(h.dialog().open, false, '对话框本来就没打开；这里只要求不得主动关闭');
  assert.match(h.error(), /请先新建画布会话，再导入本体内容/, '失败原因必须可见');
  assert.equal(h.contact.flush, 0, '没有卡片就不该 flush');
  assert.equal(h.importBtn().disabled, false, '失败后导入按钮必须恢复可重试');
  assert.equal(h.importBtn().textContent, '导入到画布');
  assert.deepEqual(h.flashes, [], '手动导入用对话框报错，不额外刷提示');
});

test('手动导入: 失败时不关闭已打开的对话框', async () => {
  const ctx = canvasActionsHarness({ activeId: null });
  const h = bridgeHarness({ actions: ctx.actions });
  h.dialog().open = true;
  await h.bridge.importBridgePreview();
  assert.equal(h.dialog().open, true, '对话框必须保留让用户看到原因');
  assert.match(h.error(), /请先新建画布会话/);
});

test('手动导入: 活动会话成功建卡并关闭对话框', async () => {
  const ctx = canvasActionsHarness();
  const h = bridgeHarness({ actions: ctx.actions });
  h.dialog().open = true;
  await h.bridge.importBridgePreview();
  assert.equal(ctx.getCards().length, 1);
  assert.equal(h.dialog().open, false);
  assert.equal(h.error(), '');
});

function intentHarness({ actions, flushError = null, canMutate = null, onFlush = null } = {}) {
  const h = bridgeHarness({ actions, flushError, canMutate, onFlush });
  const release = async () => {
    h.order.push('release');
    h.releases.push(true);
  };
  return {
    ...h,
    release,
    deliver: (intent, context = {}) => {
      const messages = context.messages || [{ role: 'user', text: '问题', entryId: 'e1' }];
      const preview = context.preview || {
        session: { sessionId: 'sess-1', title: '本体会话' }, messages, leafId: 'e1',
      };
      return h.bridge.deliverIntent(intent, { preview, messages, generation: 3, release });
    },
    ackCalls: () => h.calls.filter(call => call.path.endsWith('/ack')),
  };
}

test('intent 导入: 无 activeId 释放已领取凭条，不建卡、不 flush、不 ACK', async () => {
  const ctx = canvasActionsHarness({ activeId: null });
  const h = intentHarness({ actions: ctx.actions });
  await h.deliver({ intentId: 'intent-1', sessionId: 'sess-1', title: '本体会话', messageId: 'e1' });
  assert.equal(ctx.getCards().length, 0);
  assert.deepEqual(h.releases, [true], '凭条必须释放，不能吞掉');
  assert.equal(h.ackCalls().length, 0, '没有落盘的内容绝不能 ACK');
  assert.equal(h.contact.flush, 0);
  assert.match(h.flashes.at(-1) || '', /请先新建画布会话，再导入本体内容/);
  assert.ok(!h.routes().some(path => path.endsWith('/release')), '释放由 intents 控制器负责，bridge 只调用回调');
});

test('intent 导入: 成功路径先建卡再 flush，flush 完成后才 ACK', async () => {
  const ctx = canvasActionsHarness();
  const h = intentHarness({ actions: ctx.actions });
  await h.deliver({ intentId: 'intent-2', sessionId: 'sess-1', title: '本体会话', messageId: 'e1' });
  assert.deepEqual(h.order, ['flush', 'ack'], 'ACK 必须晚于落盘');
  assert.deepEqual(h.releases, [], '成功路径不得释放凭条');
  assert.equal(ctx.getCards().length, 1);
  assert.equal(h.contact.flush, 1);
  assert.equal(h.ackCalls().length, 1);
});

test('intent 导入: flush 失败先释放凭条，不 ACK，并给出落盘提示', async () => {
  const ctx = canvasActionsHarness();
  const h = intentHarness({ actions: ctx.actions, flushError: new Error('disk unavailable') });
  await h.deliver({ intentId: 'intent-3', sessionId: 'sess-1', title: '本体会话', messageId: 'e1' });
  assert.deepEqual(h.order, ['flush', 'release'], 'flush 失败后先释放再返回');
  assert.equal(h.ackCalls().length, 0);
  assert.match(h.flashes.at(-1) || '', /落盘/);
  assert.match(h.flashes.at(-1) || '', /disk unavailable/);
  assert.equal(ctx.getCards().length, 1, '卡片在 flush 之前就已建立，符合既有次序');
});

test('intent 导入: flush 等待期间代际失效不 ACK，完成前必须释放凭条', async () => {
  const ctx = canvasActionsHarness();
  const gate = deferred();
  let validGeneration = 3;
  const h = intentHarness({
    actions: ctx.actions,
    canMutate: generation => generation === validGeneration,
    onFlush: () => gate.promise,
  });

  const pending = h.deliver({ intentId: 'switch-during-flush', sessionId: 'sess-1', title: '本体会话', messageId: 'e1' });
  while (h.contact.flush === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.getCards().length, 1, '建卡发生后才进入等待落盘');

  validGeneration = 4; // 用户在等待期间切换会话：旧代际的写入与 ACK 权限失效
  gate.resolve();
  await pending;

  assert.deepEqual(h.order, ['flush', 'release'], '落盘返回后先释放凭条');
  assert.deepEqual(h.releases, [true], '失效代际必须释放已领取凭条');
  assert.equal(h.ackCalls().length, 0, '切换后不得 ACK');
  assert.equal(h.flashes.some(message => /已自动从本体导入/.test(message)), false, '不得提示导入成功');
});

test('intent 导入: flush 等待期间画布销毁同样无 ACK 且释放凭条', async () => {
  const ctx = canvasActionsHarness();
  const gate = deferred();
  let disposed = false;
  const h = intentHarness({
    actions: ctx.actions,
    canMutate: generation => !disposed && generation === 3,
    onFlush: () => gate.promise,
  });

  const pending = h.deliver({ intentId: 'dispose-during-flush', sessionId: 'sess-1', title: '本体会话', messageId: 'e1' });
  while (h.contact.flush === 0) await new Promise(resolve => setImmediate(resolve));

  disposed = true; // disposePanel 关闭命令闸门
  gate.resolve();
  await pending;

  assert.deepEqual(h.order, ['flush', 'release']);
  assert.deepEqual(h.releases, [true], '销毁后迟到的落盘结果不得吞掉凭条');
  assert.equal(h.ackCalls().length, 0, '销毁后不得 ACK');
});

// ---------------------------------------------------------------------------
// 真实入口：删除最后一个会话后，intent 自动导入不得留下内存孤卡
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
    this.textContent = '';
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
  blur() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  select() { this.setSelectionRange(0, this.value.length); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 20, bottom: 20, width: 156, height: 80 }; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'hidden') this.hidden = false; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'hidden') this.hidden = true; }
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

function panelEnvironment() {
  const nodes = new Map();
  const windowEvents = {}, documentEvents = {};
  const localValues = new Map();
  const broadcasts = [], channels = [];
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
  return {
    environment, nodes, windowEvents, documentEvents, broadcasts, channels,
    receive(message) {
      for (const channel of channels) {
        channel.onmessage?.({ data: message });
        for (const listener of channel.listeners) listener({ data: message });
      }
    },
  };
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

async function loadPanel(hana, host, environment) {
  const mapping = {
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
  for (const [name, namespace] of Object.entries(assetModules)) mapping[`./${name}`] = namespace;
  const context = vm.createContext({
    console, Response, ReadableStream, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout, btoa, atob, ...environment,
  });
  const source = await readFile(new URL('../ui/assets/panel.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: '../ui/assets/panel.js' });
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
const canvasState = ui => ui.broadcasts.filter(message => message.type === 'FORK_SESSION_STATE').at(-1) || {};

test('panel entry: 删除最后一个会话后到达的 intent 释放凭条、不 ACK、不建孤卡', async () => {
  let intents = [];
  const calls = [];
  const hana = {
    ready() {},
    sessions: { onActiveChanged() { return () => {}; } },
    api: {
      async fetch(route, init = {}) {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ route, body });
        if (route === '/api/bridge/intents') return Response.json({ intents });
        if (route === '/api/bridge/sessions') return Response.json({ sessions: [] });
        if (route === '/api/bridge/actions') return Response.json({ actions: [] });
        if (route === '/api/bridge/preview') {
          return Response.json({ preview: {
            kind: 'history',
            session: { sessionId: 'sess-1', title: '本体会话' },
            messages: [{ role: 'user', text: '问题', entryId: 'e1' }],
            leafId: 'e1',
            status: {},
          } });
        }
        if (route.endsWith('/claim')) return Response.json({ claimed: true });
        if (route.endsWith('/release')) return Response.json({ released: true });
        if (route.endsWith('/ack')) return Response.json({ acknowledged: true });
        return Response.json({});
      },
    },
  };
  const host = memoryHost();
  hana.storage = host.storage;
  const ui = panelEnvironment();
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
  assert.equal(canvasState(ui).activeId, null, '会话已清空，画布进入无活动会话');
  assert.equal(forkChat.getCards().length, 0);

  const writesBefore = host.control.writes;
  intents = [{ intentId: 'late-intent', sessionId: 'sess-1', messageId: 'e1', title: '本体会话' }];
  ui.windowEvents.focus?.();
  const routes = () => calls.map(call => call.route.split('/').at(-1));
  const started = Date.now();
  while (!routes().includes('release')) {
    if (Date.now() - started > 2000) throw new Error(`等待 release 超时：${routes().join(',')}`);
    await flush();
  }
  await flush();

  assert.equal(routes().filter(route => route === 'ack').length, 0, '没有落盘的内容绝不能 ACK');
  assert.equal(routes().filter(route => route === 'release').length, 1, '已领取的凭条必须释放');
  assert.equal(forkChat.getCards().filter(card => card.isDoc).length, 0, '不得留下内存孤卡');
  assert.equal(forkChat.getCards().length, 0);
  assert.equal(host.control.writes, writesBefore, '拒绝导入不得标脏或写盘');
  assert.match(ui.nodes.get('fork-flash').textContent, /请先新建画布会话，再导入本体内容/);
  assert.equal(ui.nodes.get('session-empty-state').hidden, false);
  assert.equal(ui.nodes.get('canvas-launchpad').hidden, true);

  ui.windowEvents.pagehide?.();
  await flush();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { safeDetail, requestHost } from '../ui/assets/host-api.js';
import { runChat, ChatError } from '../ui/assets/chat-client.js';
import { parseAssistantOutput } from '../ui/assets/assistant-output.js';
import { createForkSessionStore } from '../ui/assets/fork-session-store.js';
import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { readRenameIntent, clearRenameIntent } from '../ui/assets/fork-session-commands.js';
import * as panelLayout from '../ui/assets/panel-layout.js';
import * as panelShortcuts from '../ui/assets/panel-shortcuts.js';
import * as panelFormat from '../ui/assets/panel-format.js';
import * as panelDocuments from '../ui/assets/panel-documents.js';
import * as panelArtifactView from '../ui/assets/panel-artifact-view.js';
import * as panelArtifactPanel from '../ui/assets/panel-artifact-panel.js';
import * as panelChatEngine from '../ui/assets/panel-chat-engine.js';
import * as panelBattleFlow from '../ui/assets/panel-battle-flow.js';
import * as panelMerge from '../ui/assets/panel-merge.js';
import * as panelCards from '../ui/assets/panel-cards.js';
import * as panelAgents from '../ui/assets/panel-agents.js';
import * as panelCanvasView from '../ui/assets/panel-canvas-view.js';
import * as panelCanvasActions from '../ui/assets/panel-canvas-actions.js';
import * as panelSelection from '../ui/assets/panel-selection.js';
import * as panelSelectionPopover from '../ui/assets/panel-selection-popover.js';
import * as panelTopologyExport from '../ui/assets/panel-topology-export.js';
import * as panelContextPlan from '../ui/assets/panel-context-plan.js';
import * as panelContextPreview from '../ui/assets/panel-context-preview.js';
import * as panelRefs from '../ui/assets/panel-refs.js';
import * as panelHistoryController from '../ui/assets/panel-history-controller.js';
import * as panelMessages from '../ui/assets/panel-messages.js';
import * as panelContext from '../ui/assets/panel-context.js';
import * as panelBridgeSend from '../ui/assets/panel-bridge-send.js';
import { createBridgeIntents } from '../ui/assets/panel-bridge-intents.js';
import * as panelBridgeIntents from '../ui/assets/panel-bridge-intents.js';
import * as panelHandoff from '../ui/assets/panel-handoff.js';
import * as panelBridge from '../ui/assets/panel-bridge.js';
import * as panelDocumentUi from '../ui/assets/panel-document-ui.js';
import * as panelCardGestures from '../ui/assets/panel-card-gestures.js';
import * as panelCardEvents from '../ui/assets/panel-card-events.js';
import * as panelRenderer from '../ui/assets/panel-renderer.js';
import * as panelRenderDiff from '../ui/assets/panel-render-diff.js';
import * as panelSearchController from '../ui/assets/panel-search-controller.js';
import * as panelSessionState from '../ui/assets/panel-session-state.js';
import * as panelSessionUi from '../ui/assets/panel-session-ui.js';
import * as panelFeedback from '../ui/assets/panel-feedback.js';
import * as panelSearch from '../ui/assets/panel-search.js';
import { memoryHost } from './helpers/fork-memory.mjs';

class Element {
  constructor(registry, document) {
    this.registry = registry;
    this.document = document;
    this.children = [];
    this.events = {};
    this.nodes = new Map();
    this.style = {};
    this.value = '';
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
  removeAttribute(key) { delete (this.attributes ||= {})[key]; if (key === 'hidden') this.hidden = false; }
  querySelectorAll(selector) {
    if (selector.includes('button.session-')) {
      const descend = node => node.children.flatMap(child => [child, ...descend(child)]);
      return descend(this).filter(node => node.className?.split(' ').some(name => name === 'session-item' || selector.includes('session-more') && name === 'session-more'));
    }
    return this.children.flatMap(child => [...child.nodes.values()]).filter(node => node.id.startsWith('input-'));
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, handler) { this.events[type] = handler; }
  removeEventListener(type, handler) { if (this.events[type] === handler) delete this.events[type]; }
  querySelector(selector) {
    if (!this.nodes.has(selector)) {
      const element = new Element(this.registry, this.document);
      if (/^#[\w-]+$/.test(selector)) element.id = selector.slice(1);
      this.nodes.set(selector, element);
      if (this.registry) {
        if (!this.registry.autoQuery) this.registry.autoQuery = new Set();
        this.registry.autoQuery.add(selector);
      }
    }
    return this.nodes.get(selector);
  }
  setAttribute(key, value) { (this.attributes ||= {})[key] = value; if (key === 'hidden') this.hidden = true; }
  getAttribute(key) { return this.attributes?.[key] ?? null; }
}

async function loadModule(relative, imports, extra = {}) {
  const context = vm.createContext({
    console, Response, ReadableStream, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout, btoa, atob, ...extra,
  });
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: relative });
  await module.link(async specifier => {
    const exports = imports[specifier];
    assert.ok(exports, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module;
}

function uiEnvironment() {
  const nodes = new Map();
  const windowEvents = {}, documentEvents = {};
  const localValues = new Map();
  const document = {
    addEventListener(type, callback) { documentEvents[type] = callback; },
    getElementById(id) {
      if (!nodes.has(id)) {
        const element = new Element(nodes, document);
        element.id = id;
      }
      return nodes.get(id);
    },
    createElement() { return new Element(nodes, document); },
    createElementNS() { return new Element(nodes, document); },
  };
  document.body = new Element(nodes, document);
  const environment = {
    document,
    localStorage: {
      getItem(key) { return localValues.get(key) ?? null; },
      setItem(key, value) { localValues.set(key, value); },
    },
    window: {
      innerWidth: 300,
      innerHeight: 800,
      addEventListener(type, handler) { windowEvents[type] = handler; },
      removeEventListener(type, handler) { if (windowEvents[type] === handler) delete windowEvents[type]; },
    },
    BroadcastChannel: class {
      constructor() { this.listeners = []; }
      postMessage() {}
      addEventListener(type, callback) { if (type === 'message') this.listeners.push(callback); }
    },
  };
  return { environment, nodes, windowEvents, documentEvents };
}

const hosts = new WeakMap();
function imports(hana) {
  if (!hosts.has(hana)) {
    const host = memoryHost();
    hana.storage ||= host.storage;
    hosts.set(hana, host);
  }
  const host = hosts.get(hana);
  return {
    './sdk.js': { hana },
    './host-api.js': { safeDetail, requestHost },
    './chat-client.js': { runChat, ChatError },
    './assistant-output.js': { parseAssistantOutput },
    './fork-session-store.js': { createForkSessionStore: sdk => createForkSessionStore(sdk, { locks: host.locks }) },
    './fork-session-controller.js': { createForkSessionController },
    './fork-session-commands.js': { readRenameIntent, clearRenameIntent },
    './panel-layout.js': panelLayout,
    './panel-shortcuts.js': panelShortcuts,
    './panel-format.js': panelFormat,
    './panel-documents.js': panelDocuments,
    './panel-artifact-view.js': panelArtifactView,
    './panel-artifact-panel.js': panelArtifactPanel,
    './panel-chat-engine.js': panelChatEngine,
    './panel-battle-flow.js': panelBattleFlow,
    './panel-merge.js': panelMerge,
    './panel-cards.js': panelCards,
    './panel-agents.js': panelAgents,
    './panel-canvas-view.js': panelCanvasView,
    './panel-canvas-actions.js': panelCanvasActions,
    './panel-selection.js': panelSelection,
    './panel-selection-popover.js': panelSelectionPopover,
    './panel-topology-export.js': panelTopologyExport,
    './panel-context-plan.js': panelContextPlan,
    './panel-context-preview.js': panelContextPreview,
    './panel-refs.js': panelRefs,
    './panel-history-controller.js': panelHistoryController,
    './panel-messages.js': panelMessages,
    './panel-context.js': panelContext,
    './panel-bridge-send.js': panelBridgeSend,
    './panel-bridge-intents.js': panelBridgeIntents,
    './panel-handoff.js': panelHandoff,
    './panel-bridge.js': panelBridge,
    './panel-document-ui.js': panelDocumentUi,
    './panel-card-gestures.js': panelCardGestures,
    './panel-card-events.js': panelCardEvents,
    './panel-renderer.js': panelRenderer,
    './panel-render-diff.js': panelRenderDiff,
    './panel-search-controller.js': panelSearchController,
    './panel-session-state.js': panelSessionState,
    './panel-session-ui.js': panelSessionUi,
    './panel-feedback.js': panelFeedback,
    './panel-search.js': panelSearch,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, label, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function makeIntent(intentId, sessionId, messageId = 'entry-1') {
  return { intentId, sessionId, messageId, title: `标题-${intentId}` };
}

function previewFor(sessionId, entryId = 'entry-1', text = '同一段快照') {
  return {
    session: { sessionId, title: `本体-${sessionId}` },
    messages: [{ role: 'assistant', text, entryId }],
    leafId: entryId,
  };
}

async function loadBridgePanel({ intents = [], preview = previewFor('session-a'), onRequest = async () => Response.json({}), apiOverrides = {} } = {}) {
  const ui = uiEnvironment();
  ui.environment.document.querySelectorAll = () => [];
  ui.environment.Blob = Blob;
  const calls = [];
  const hana = {
    ready() {},
    sessions: { onActiveChanged() { return () => {}; } },
    api: {
      async fetch(route, init = {}) {
        const body = init.body ? JSON.parse(init.body) : null;
        const call = { route, init, body };
        calls.push(call);
        if (route === '/api/bridge/intents') {
          const next = typeof intents === 'function' ? await intents(call) : intents;
          return Response.json({ intents: next });
        }
        if (route === '/api/bridge/sessions') return Response.json({ sessions: [] });
        if (route === '/api/bridge/actions') return Response.json({ actions: [] });
        if (apiOverrides[route]) return apiOverrides[route](route, init, call);
        if (route === '/api/bridge/preview') {
          const value = typeof preview === 'function' ? await preview(call) : preview;
          return Response.json({ preview: value });
        }
        if (route.endsWith('/claim')) return Response.json({ claimed: true });
        if (route.endsWith('/release')) return Response.json({ released: true });
        if (route.endsWith('/ack')) return Response.json({ acknowledged: true });
        return onRequest(route, init, call);
      },
    },
  };
  const dependencies = imports(hana);
  const host = hosts.get(hana);
  await loadModule('../ui/assets/panel.js', dependencies, ui.environment);
  return { ui, hana, host, calls, panel: ui.environment.window.__forkChat };
}

async function disposePanel(harness) {
  await harness.panel.dispose().catch(() => {});
}

function bridgeCalls(harness, suffix) {
  return harness.calls.filter(call => call.route.endsWith(suffix));
}

// 凭条认领不带 panelAbort：面板取消后，迟到的 claim 仍须完成并随后释放所有权。
test('bridge intents: cancellation does not abort claim, and late claim is released', async () => {
  const claimGate = deferred();
  const intent = makeIntent('cancel-claim', 'session-a');
  const harness = await loadBridgePanel({
    intents: [intent],
    apiOverrides: {
      [`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/claim`]: () => claimGate.promise,
    },
  });
  await waitFor(() => bridgeCalls(harness, '/claim').length === 1, 'claim request');
  const claim = bridgeCalls(harness, '/claim')[0];
  assert.equal(claim.init.signal, undefined, 'claim must not inherit panelAbort.signal');

  const closing = harness.panel.dispose();
  claimGate.resolve(Response.json({ claimed: true }));
  await closing.catch(() => {});
  await waitFor(() => bridgeCalls(harness, '/release').length === 1, 'late release');
  assert.equal(bridgeCalls(harness, '/ack').length, 0);
  await disposePanel(harness);
});

// releaseBridgeClaim 的所有权集合先删后请求：重复取消不会重复释放；请求必须 keepalive。
test('bridge intents: release is idempotent under repeated cancellation and uses keepalive', async () => {
  const intent = makeIntent('release-once', 'session-a');
  const previewGate = deferred();
  const releaseGate = deferred();
  const harness = await loadBridgePanel({
    intents: [intent],
    apiOverrides: {
      '/api/bridge/preview': () => previewGate.promise,
      [`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/release`]: () => releaseGate.promise,
    },
  });
  await waitFor(() => bridgeCalls(harness, '/preview').length === 1, 'preview after claim');
  await disposePanel(harness);
  // pagehide and a second dispose are duplicate cancellation signals.
  harness.ui.windowEvents.pagehide?.();
  await disposePanel(harness);
  previewGate.resolve(Response.json({ preview: previewFor('session-a') }));
  await waitFor(() => bridgeCalls(harness, '/release').length === 1, 'one release');
  const release = bridgeCalls(harness, '/release')[0];
  assert.equal(release.init.keepalive, true);
  releaseGate.resolve(Response.json({ released: true }));
  await waitFor(() => bridgeCalls(harness, '/release').length === 1, 'release completion');

  const directCalls = [];
  const controller = createBridgeIntents({
    hana: { name: 'fake-hana' },
    getCanvasId: () => 'canvas-direct',
    // 这几个是轮询路径才用得到的依赖，但模块要求构造时就齐全：
    // 缺了就该当场报错，而不是靠默认值放行。这条测试要的只是 release。
    canMutateCanvas: () => true,
    getGeneration: () => 1,
    deliverIntent: async () => {},
    requestHost: async (_hana, route, init) => {
      directCalls.push({ route, init });
      return Response.json({ released: true });
    },
  });
  controller.getOwnedClaims().add('direct-release');
  await Promise.all([
    controller.releaseBridgeClaim('direct-release'),
    controller.releaseBridgeClaim('direct-release'),
  ]);
  assert.equal(directCalls.length, 1, 'releasing the same owned claim twice sends one request');
  assert.equal(directCalls[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(directCalls[0].init.body), { claimer: 'canvas-direct' });
});

// 画布失效发生在 claim 完成后时，不得继续 preview 或 ACK，必须释放已抢到的凭条。
test('bridge intents: invalid canvas after claim releases without preview or ack', async () => {
  const intent = makeIntent('canvas-invalid', 'session-a');
  const claimGate = deferred();
  const harness = await loadBridgePanel({
    intents: [intent],
    apiOverrides: {
      [`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/claim`]: () => claimGate.promise,
    },
  });
  await waitFor(() => bridgeCalls(harness, '/claim').length === 1, 'claim request');
  await harness.panel.dispose().catch(() => {});
  claimGate.resolve(Response.json({ claimed: true }));
  await waitFor(() => bridgeCalls(harness, '/release').length === 1, 'release after invalidation');
  assert.equal(bridgeCalls(harness, '/preview').length, 0);
  assert.equal(bridgeCalls(harness, '/ack').length, 0);
  await disposePanel(harness);
});

// 有 messageId 却在预览中找不到时，必须释放并提示，不能扩大成全历史导入。
test('bridge intents: missing messageId does not create a card and flashes a precise warning', async () => {
  const intent = makeIntent('missing-message', 'session-a', 'not-in-preview');
  const harness = await loadBridgePanel({
    intents: [intent],
    preview: previewFor('session-a', 'different-entry', '别的消息'),
  });
  await waitFor(() => bridgeCalls(harness, '/release').length === 1, 'release for missing message');
  assert.equal(harness.panel.getCards().filter(card => card.isDoc).length, 0);
  assert.equal(bridgeCalls(harness, '/ack').length, 0);
  assert.match(harness.ui.nodes.get('fork-flash').textContent, /没有导入/);
  assert.match(harness.ui.nodes.get('fork-flash').textContent, /不在这次能读到的范围/);
  await disposePanel(harness);
});

// 建卡后 flush 失败必须在 ACK 前释放凭条，且用户能看到可重试提示。
test('bridge intents: flush failure releases before ack and reports the save error', async () => {
  const intent = makeIntent('flush-fails', 'session-a');
  const harness = await loadBridgePanel({ intents: [intent] });
  await waitFor(() => bridgeCalls(harness, '/ack').length === 1, 'successful baseline import');
  await disposePanel(harness);

  // 每个面板实例只能消费一轮凭条；用同一 harness 不能重新激活已关闭的会话。
  // 本测试重新装载一个面板，并在自动导入已经建卡后让 durable store 拒绝写入。
  const failing = await loadBridgePanel({ intents: [makeIntent('flush-fails-2', 'session-a')] });
  failing.host.control.failWrites = true;
  await waitFor(() => bridgeCalls(failing, '/release').length === 1, 'release after flush failure');
  assert.equal(bridgeCalls(failing, '/ack').length, 0);
  assert.equal(failing.panel.getCards().filter(card => card.isDoc).length, 1, 'card is built before flush is attempted');
  assert.match(failing.ui.nodes.get('fork-flash').textContent, /落盘/);
  assert.match(failing.ui.nodes.get('fork-flash').textContent, /disk unavailable/);
  const routes = failing.calls.filter(call => /\/(?:claim|preview|release|ack)$/.test(call.route)).map(call => call.route.split('/').at(-1));
  assert.deepEqual(routes, ['claim', 'preview', 'release']);
  await disposePanel(failing);
});

// 两个不同 sessionId 的相同快照只允许一张卡：去重键必须是 contentHash + importKind。
test('bridge intents: identical content from another session deduplicates without sessionId in the key', async () => {
  const first = makeIntent('dedupe-a', 'session-a');
  const second = makeIntent('dedupe-b', 'session-b');
  const harness = await loadBridgePanel({
    intents: [first, second],
    preview: call => previewFor(call.body.sessionId, 'entry-1', '完全相同的正文'),
  });
  await waitFor(() => bridgeCalls(harness, '/ack').length === 2, 'both intents acknowledged');
  const docs = harness.panel.getCards().filter(card => card.isDoc);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].sourceRef.sessionId, 'session-a');
  assert.equal(bridgeCalls(harness, '/release').length, 0);
  await disposePanel(harness);
});

// 成功路径同样固定为 claim → preview → 建卡/flush → ACK，防止回执先于落盘。
test('bridge intents: successful import acknowledges only after the card exists and flush completes', async () => {
  const intent = makeIntent('ordered-success', 'session-a');
  const harness = await loadBridgePanel({ intents: [intent] });
  await waitFor(() => bridgeCalls(harness, '/ack').length === 1, 'ack after import');
  const ack = bridgeCalls(harness, '/ack')[0];
  assert.equal(harness.panel.getCards().filter(card => card.isDoc).length, 1);
  const routes = harness.calls.filter(call => /\/(?:intents|claim|preview|ack)$/.test(call.route)).map(call => call.route);
  assert.deepEqual(routes, [
    '/api/bridge/intents',
    `/api/bridge/intents/${encodeURIComponent(intent.intentId)}/claim`,
    '/api/bridge/preview',
    `/api/bridge/intents/${encodeURIComponent(intent.intentId)}/ack`,
  ]);
  assert.equal(ack.init.keepalive, undefined, 'ACK is not the cancellation-resistant operation');
  await disposePanel(harness);
});

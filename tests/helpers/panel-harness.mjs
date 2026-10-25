import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { safeDetail, requestHost } from '../../ui/assets/host-api.js';
import { runChat, ChatError } from '../../ui/assets/chat-client.js';
import { parseAssistantOutput } from '../../ui/assets/assistant-output.js';
import { createForkSessionStore } from '../../ui/assets/fork-session-store.js';
import { createForkSessionController } from '../../ui/assets/fork-session-controller.js';
import { readRenameIntent, clearRenameIntent } from '../../ui/assets/fork-session-commands.js';
import * as panelLayout from '../../ui/assets/panel-layout.js';
import * as panelShortcuts from '../../ui/assets/panel-shortcuts.js';
import * as panelFormat from '../../ui/assets/panel-format.js';
import * as panelDocuments from '../../ui/assets/panel-documents.js';
import * as panelArtifactView from '../../ui/assets/panel-artifact-view.js';
import * as panelArtifactPanel from '../../ui/assets/panel-artifact-panel.js';
import * as panelChatEngine from '../../ui/assets/panel-chat-engine.js';
import * as panelBattleFlow from '../../ui/assets/panel-battle-flow.js';
import * as panelMerge from '../../ui/assets/panel-merge.js';
import * as panelCards from '../../ui/assets/panel-cards.js';
import * as panelAgents from '../../ui/assets/panel-agents.js';
import * as panelCanvasView from '../../ui/assets/panel-canvas-view.js';
import * as panelCanvasActions from '../../ui/assets/panel-canvas-actions.js';
import * as panelSelection from '../../ui/assets/panel-selection.js';
import * as panelSelectionPopover from '../../ui/assets/panel-selection-popover.js';
import * as panelTopologyExport from '../../ui/assets/panel-topology-export.js';
import * as panelContextPlan from '../../ui/assets/panel-context-plan.js';
import * as panelContextPreview from '../../ui/assets/panel-context-preview.js';
import * as panelRefs from '../../ui/assets/panel-refs.js';
import * as panelHistoryController from '../../ui/assets/panel-history-controller.js';
import * as panelMessages from '../../ui/assets/panel-messages.js';
import * as panelContext from '../../ui/assets/panel-context.js';
import * as panelBridgeSend from '../../ui/assets/panel-bridge-send.js';
import * as panelBridgeIntents from '../../ui/assets/panel-bridge-intents.js';
import * as panelHandoff from '../../ui/assets/panel-handoff.js';
import * as panelBridge from '../../ui/assets/panel-bridge.js';
import * as panelDocumentUi from '../../ui/assets/panel-document-ui.js';
import * as panelCardGestures from '../../ui/assets/panel-card-gestures.js';
import * as panelCardEvents from '../../ui/assets/panel-card-events.js';
import * as panelRenderer from '../../ui/assets/panel-renderer.js';
import * as panelRenderDiff from '../../ui/assets/panel-render-diff.js';
import * as panelSearchController from '../../ui/assets/panel-search-controller.js';
import * as panelSessionState from '../../ui/assets/panel-session-state.js';
import * as panelSessionUi from '../../ui/assets/panel-session-ui.js';
import * as panelFeedback from '../../ui/assets/panel-feedback.js';
import * as panelSearch from '../../ui/assets/panel-search.js';
import { memoryHost } from './fork-memory.mjs';

function matchesSelector(node, selector) {
  if (!node || typeof selector !== 'string') return false;
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  if (selector.startsWith('[')) {
    const m = selector.match(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/);
    if (!m) return false;
    const attr = m[1];
    const val = m[2];
    if (val === undefined) return node.hasAttribute(attr);
    return node.getAttribute(attr) === val;
  }
  return (node.tagName || '').toLowerCase() === selector.toLowerCase();
}

class MockElement {
  constructor(registry, document, tagName = 'div') {
    this.registry = registry;
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.events = {};
    this.style = {};
    this.value = '';
    this.attributes = {};
    this.dataset = {};
    this.open = false;
    this.disabled = false;
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
    const res = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) res.push(child);
        walk(child);
      }
    };
    walk(this);
    return res;
  }
  querySelector(selector) {
    const list = this.querySelectorAll(selector);
    return list[0] || null;
  }
  set innerHTML(value) {
    this.html = value;
    this.children = [];
    // 简单解析常见关键节点
    if (typeof value === 'string') {
      const idMatches = value.matchAll(/id="([^"]+)"/g);
      for (const m of idMatches) {
        const el = new MockElement(this.registry, this.document);
        el.id = m[1];
        this.appendChild(el);
      }
      const btnMatches = value.matchAll(/data-action="([^"]+)"/g);
      for (const m of btnMatches) {
        const btn = new MockElement(this.registry, this.document, 'button');
        btn.setAttribute('data-action', m[1]);
        this.appendChild(btn);
      }
    }
  }
  get innerHTML() { return this.html || ''; }
  set textContent(v) { this._textContent = String(v ?? ''); }
  get textContent() { return this._textContent ?? this.html ?? ''; }
  appendChild(child) {
    if (child) {
      child.parentNode = this;
      this.children.push(child);
    }
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(type, handler) {
    if (!this.events[type]) this.events[type] = [];
    this.events[type].push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.events[type];
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }
  dispatchEvent(event) {
    const list = this.events[event.type] || [];
    for (const h of list) h(event);
  }
  setAttribute(key, value) {
    (this.attributes ||= {})[key] = String(value);
    if (key.startsWith('data-')) {
      const prop = key.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      this.dataset[prop] = String(value);
    }
    if (key === 'hidden') this.hidden = true;
  }
  getAttribute(key) { return this.attributes?.[key] ?? null; }
  hasAttribute(key) { return Boolean(this.attributes && key in this.attributes); }
}

function uiEnvironment() {
  const nodes = new Map();
  const windowEvents = {}, documentEvents = {};
  const localValues = new Map();
  const document = {
    addEventListener(type, callback) { documentEvents[type] = callback; },
    getElementById(id) {
      if (!nodes.has(id)) {
        const element = new MockElement(nodes, document);
        element.id = id;
        document.body.appendChild(element);
      }
      return nodes.get(id);
    },
    createElement(tag) { return new MockElement(nodes, document, tag); },
    createElementNS(_ns, tag) { return new MockElement(nodes, document, tag); },
    querySelector(selector) { return document.body?.querySelector(selector) || null; },
    querySelectorAll(selector) { return document.body?.querySelectorAll(selector) || []; },
  };
  document.body = new MockElement(nodes, document, 'body');
  const environment = {
    document,
    localStorage: {
      getItem(key) { return localValues.get(key) ?? null; },
      setItem(key, value) { localValues.set(key, value); },
    },
    window: {
      innerWidth: 800,
      innerHeight: 600,
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

const hosts = new WeakMap();
function createImports(hana, flashes, captures = { handoff: [], documents: [] }) {
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
    './panel-documents.js': {
      ...panelDocuments,
      createDocumentPipeline(deps) {
        const pipeline = panelDocuments.createDocumentPipeline(deps);
        captures.documents.push({ pipeline, deps });
        return pipeline;
      },
    },
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
    './panel-handoff.js': {
      ...panelHandoff,
      createPanelHandoff(deps) {
        captures.handoff.push(deps);
        return panelHandoff.createPanelHandoff(deps);
      },
    },
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

export async function loadPanel({
  onRequest = async () => Response.json({}),
  agents = [{ id: 'agent-sol', name: 'Sol Architect' }],
} = {}) {
  const ui = uiEnvironment();
  ui.environment.Blob = Blob;
  const calls = [];
  const flashes = [];
  const captures = { handoff: [], documents: [] };
  const firstAgent = agents[0];
  if (firstAgent?.id) ui.environment.localStorage.setItem('fork_chat_active_agent_id', firstAgent.id);
  if (firstAgent?.name) ui.environment.localStorage.setItem('fork_chat_active_agent_name', firstAgent.name);
  if (firstAgent?.model) ui.environment.localStorage.setItem('fork_chat_active_agent_model', firstAgent.model);
  if (firstAgent?.provider) ui.environment.localStorage.setItem('fork_chat_active_agent_provider', firstAgent.provider);
  const hana = {
    ready() {},
    sessions: { onActiveChanged() { return () => {}; }, focus: async () => ({ ok: true }) },
    api: {
      async fetch(route, init = {}) {
        const body = init.body ? JSON.parse(init.body) : null;
        const call = { route, init, body };
        calls.push(call);
        if (route === '/api/agents') return Response.json({ ok: true, agents });
        if (route === '/api/bridge/intents') return Response.json({ intents: [] });
        if (route === '/api/bridge/sessions') return Response.json({ sessions: [] });
        if (route === '/api/bridge/actions') return Response.json({ actions: [] });
        return onRequest(route, init, call);
      },
    },
  };
  const dependencies = createImports(hana, flashes, captures);
  const host = hosts.get(hana);
  await loadModule('../../ui/assets/panel.js', dependencies, ui.environment);
  return {
    ui,
    hana,
    host,
    calls,
    flashes,
    panel: ui.environment.window.__forkChat,
    handoffCompositions: captures.handoff,
    documentPipelines: captures.documents,
  };
}

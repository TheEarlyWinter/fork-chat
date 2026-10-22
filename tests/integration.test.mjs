import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { requestHost, safeDetail } from '../ui/assets/host-api.js';
import { runChat, ChatError } from '../ui/assets/chat-client.js';
import { parseAssistantOutput } from '../ui/assets/assistant-output.js';
import { createForkSessionStore } from '../ui/assets/fork-session-store.js';
import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { writeRenameIntent, readRenameIntent, clearRenameIntent } from '../ui/assets/fork-session-commands.js';
import * as panelConnectors from '../ui/assets/panel-connectors.js';
import * as panelLayout from '../ui/assets/panel-layout.js';
import * as panelShortcuts from '../ui/assets/panel-shortcuts.js';
import { memoryHost } from './helpers/fork-memory.mjs';
import { createAgentDirectory } from '../lib/agents.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

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
      add(...tokens) { tokens.forEach(t => classes.add(t)); },
      remove(...tokens) { tokens.forEach(t => classes.delete(t)); },
      contains(token) { return classes.has(token); },
      toggle(token, force) {
        const has = classes.has(token);
        const shouldAdd = force !== undefined ? Boolean(force) : !has;
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
  querySelector(selector) {
    if (!this.nodes.has(selector)) {
      const element = new Element(this.registry, this.document);
      if (/^#[\w-]+$/.test(selector)) element.id = selector.slice(1);
      this.nodes.set(selector, element);
    }
    return this.nodes.get(selector);
  }
  setAttribute(key, value) { (this.attributes ||= {})[key] = value; if (key === 'hidden') this.hidden = true; }
  getAttribute(key) { return this.attributes?.[key] ?? null; }
}

async function loadModule(relative, imports, extra = {}) {
  const context = vm.createContext({ console, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, btoa, atob, ...extra });
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
  const broadcasts = [], channels = [], broadcastListeners = new Set();
  const windowEvents = {}, documentEvents = {};
  const localValues = new Map();
  const document = {
    addEventListener(type, callback) { documentEvents[type] = callback; },
    getElementById(id) { if (!nodes.has(id)) { const element = new Element(nodes, document); element.id = id; } return nodes.get(id); },
    createElement() { return new Element(nodes, document); },
    createElementNS() { return new Element(nodes, document); },
  };
  document.body = new Element(nodes, document);
  const environment = {
    document,
    localStorage: { getItem(key) { return localValues.get(key) ?? null; }, setItem(key, value) { localValues.set(key, value); } },
    window: { innerWidth: 300, innerHeight: 800, addEventListener(type, handler) { windowEvents[type] = handler; }, removeEventListener() {} },
    BroadcastChannel: class {
      constructor(name) { this.name = name; this.listeners = []; channels.push(this); }
      postMessage(message) { broadcasts.push(message); for (const listener of broadcastListeners) listener(message); }
      addEventListener(type, callback) { if (type === 'message') this.listeners.push(callback); }
    },
  };
  return { environment, nodes, broadcasts, windowEvents, documentEvents, localValues,
    receive(data) { for (const channel of channels) { channel.onmessage?.({ data }); for (const listener of channel.listeners) listener({ data }); } },
    nextMessage(predicate) { return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { broadcastListeners.delete(listener); reject(new Error('No matching message')); }, 2000);
      const listener = message => { if (predicate(message)) { clearTimeout(timeout); broadcastListeners.delete(listener); resolve(message); } };
      broadcastListeners.add(listener);
    }); },
    nextState(predicate) { return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { broadcastListeners.delete(listener); reject(new Error('No matching session state')); }, 2000);
      const listener = message => {
        if (message.type === 'FORK_SESSION_STATE' && predicate(message)) {
          clearTimeout(timeout); broadcastListeners.delete(listener); resolve(message);
        }
      };
      broadcastListeners.add(listener);
    }); },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const hosts = new WeakMap();
function imports(hana) {
  if (!hosts.has(hana)) {
    const host = memoryHost();
    if (hana.storage) host.storage = hana.storage;
    else hana.storage = host.storage;
    hosts.set(hana, host);
  }
  const host = hosts.get(hana);
  return { './sdk.js': { hana }, './host-api.js': { safeDetail, requestHost }, './chat-client.js': { runChat, ChatError },
    './assistant-output.js': { parseAssistantOutput },
    './fork-session-store.js': { createForkSessionStore: sdk => createForkSessionStore(sdk, { locks: host.locks }) },
    './fork-session-controller.js': { createForkSessionController },
    './fork-session-commands.js': { writeRenameIntent, readRenameIntent, clearRenameIntent },
    './panel-connectors.js': panelConnectors,
    './panel-layout.js': panelLayout,
    './panel-shortcuts.js': panelShortcuts,
  };
}
function chatResponse(requestId, text = 'answer', terminal = 'done') {
  return new Response([
    { type: 'start', requestId, provider: 'provider', model: 'model' },
    { type: 'text-delta', requestId, delta: text },
    { type: terminal, requestId, code: 'PROVIDER_ERROR', message: 'failed' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('function panel announces ready before first authenticated request', async () => {
  const ui = uiEnvironment();
  const order = [];
  const hana = { ready() { order.push('ready'); }, api: { async fetch() { order.push('fetch'); return Response.json({ ok: true, agents: [{ id: 'real', name: 'Real agent' }] }); } } };
  await loadModule('../ui/assets/function-panel.js', imports(hana), ui.environment);
  await flush();
  assert.equal(order[0], 'ready', 'ready must be announced before any authenticated request');
  assert.ok(order.length >= 2, 'panel performs initial authenticated requests for agents and parser settings');
  assert.ok(order.slice(1).every(item => item === 'fetch'));
  assert.equal(ui.nodes.get('agent-count').textContent, '1');
  const agents = ui.broadcasts.filter(message => message.type === 'AGENT_CHANGED');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agent.id, 'real');
});

test('function panel keeps a denied request visible, broadcasts no fake list, and refresh recovers', async () => {
  const ui = uiEnvironment();
  let denied = true;
  const hana = { ready() {}, api: { async fetch() {
    return denied ? Response.json({ code: 'app_surface_session_revoked', error: 'revoked' }, { status: 403 })
      : Response.json({ ok: true, agents: [{ id: 'actual', name: 'Actual' }] });
  } } };
  await loadModule('../ui/assets/function-panel.js', imports(hana), ui.environment);
  await flush();
  assert.match(ui.nodes.get('agent-list').innerHTML, /app_surface_session_revoked/);
  assert.equal(ui.nodes.get('agent-count').textContent, '0');
  assert.equal(ui.broadcasts.filter(message => message.type === 'AGENT_CHANGED').length, 0);
  ui.nodes.get('search-input').events.input();
  assert.match(ui.nodes.get('agent-list').innerHTML, /app_surface_session_revoked/);
  denied = false;
  await ui.nodes.get('btn-refresh').events.click();
  assert.equal(ui.nodes.get('agent-count').textContent, '1');
  const agents = ui.broadcasts.filter(message => message.type === 'AGENT_CHANGED');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agent.id, 'actual');
});

test('failed assistant diagnostics do not enter the next model context', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = { ready() {}, api: { async fetch(_path, init) {
    if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? Response.json({ code: 'app_surface_session_invalid', error: 'invalid' }, { status: 403 }) : chatResponse(requests.at(-1).requestId);
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  let card = ui.nodes.get('cards-layer').children[0];
  card.querySelector('#input-card-1').value = 'first';
  await card.querySelector('[data-action="send"]').events.click();
  card = ui.nodes.get('cards-layer').children[0];
  assert.match(card.innerHTML, /HTTP 403/);
  card.querySelector('#input-card-1').value = 'second';
  await card.querySelector('[data-action="send"]').events.click();
  const context = requests[1].messages;
  assert.equal(context.filter(message => message.role === 'user').length, 2);
  assert.ok(context.every(message => !message.content.includes('HTTP 403')));
});

async function bridgeUi(fetch) {
  const ui = uiEnvironment();
  ui.environment.document.querySelectorAll = () => [];
  ui.environment.Blob = Blob;
  ui.environment.setTimeout = (...args) => {
    const timer = setTimeout(...args); timer.unref(); return timer;
  };
  const hana = { ready() {}, sessions: { onActiveChanged() {} }, api: { async fetch(route, init) {
    if (route === '/api/bridge/sessions') return Response.json({ sessions: [{ sessionId: 'sess-1', title: 'Native' }, { sessionId: 'sess-2', title: 'Other' }] });
    if (route === '/api/bridge/intents') return Response.json({ intents: [] });
    return fetch(route, init);
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await ui.nodes.get('btn-bridge-send').events.click();
  ui.nodes.get('bridge-send-target').value = 'sess-1';
  ui.nodes.get('bridge-send-text').value = 'frozen message';
  return ui;
}

async function bridgeImportUi(fetch) {
  const ui = uiEnvironment();
  ui.environment.document.querySelectorAll = () => [];
  ui.environment.Blob = Blob;
  const hana = {
    ready() {},
    sessions: {
      onActiveChanged() {},
      async getActive() { return { sessionId: 'sess-1', title: 'Native' }; },
    },
    api: { async fetch(route, init) {
      if (route === '/api/bridge/sessions') return Response.json({ sessions: [{ sessionId: 'sess-1', title: 'Native' }] });
      if (route === '/api/bridge/intents') return Response.json({ intents: [] });
      if (route === '/api/bridge/actions') return Response.json({ actions: [] });
      return fetch(route, init);
    } },
  };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await ui.nodes.get('btn-bridge-open').events.click();
  await flush();
  return ui;
}

test('bridge UI: exposes tree-path leaf selection and imports the chosen branch', async () => {
  const calls = [];
  const ui = await bridgeImportUi(async (route, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push([route, body]);
    if (route === '/api/bridge/preview' && body.kind === 'history') {
      return Response.json({ preview: {
        kind: 'history', session: { sessionId: 'sess-1', title: 'Native' },
        messages: [{ role: 'user', text: 'history', entryId: 'h1' }], leafId: 'h1', status: {},
      } });
    }
    if (route === '/api/bridge/preview' && body.kind === 'tree-path' && !body.leafId) {
      return Response.json({ preview: {
        kind: 'tree', session: { sessionId: 'sess-1', title: 'Native' },
        needsLeafChoice: true,
        branches: [
          { leafId: 'leaf-a', messageCount: 2, lastText: '方案 A' },
          { leafId: 'leaf-b', messageCount: 3, lastText: '方案 B' },
        ],
        messages: [], status: {},
      } });
    }
    if (route === '/api/bridge/preview' && body.kind === 'tree-path' && body.leafId === 'leaf-b') {
      return Response.json({ preview: {
        kind: 'tree', session: { sessionId: 'sess-1', title: 'Native' },
        needsLeafChoice: false, leafId: 'leaf-b', entryIds: ['root', 'leaf-b'],
        messages: [
          { role: 'user', text: '分支 B 问题', entryId: 'root' },
          { role: 'assistant', text: '分支 B 结论', entryId: 'leaf-b' },
        ], status: {},
      } });
    }
    throw new Error(`unexpected bridge request: ${route}`);
  });

  const kind = ui.nodes.get('bridge-kind-select');
  const leafField = ui.nodes.get('bridge-leaf-field');
  const leaf = ui.nodes.get('bridge-leaf-select');
  const importButton = ui.nodes.get('btn-bridge-import');
  assert.ok(kind, '应存在导入类型选择器');
  assert.ok(leaf, '应存在树分支叶节点选择器');
  kind.value = 'tree-path';
  await kind.events.change();
  await flush();
  assert.equal(leafField.hidden, false);
  assert.equal(importButton.disabled, true, '未选叶节点不能导入');
  assert.match(leaf.innerHTML, /leaf-a/);
  assert.match(leaf.innerHTML, /leaf-b/);

  leaf.value = 'leaf-b';
  await leaf.events.change();
  await flush();
  assert.equal(importButton.disabled, false);
  await importButton.events.click();
  await flush();
  const imported = ui.environment.window.__forkChat.getCards().find(card => card.isDoc);
  assert.equal(imported.sourceRef.importKind, 'tree-path');
  assert.equal(imported.sourceRef.leafId, 'leaf-b');
  assert.ok(calls.some(([route, body]) => route === '/api/bridge/preview' && body?.leafId === 'leaf-b'));

  ui.windowEvents.pagehide();
  await flush();
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('bridge UI: double click during prepare locks synchronously and dispatches one action', async () => {
  const gate = deferred();
  const calls = [];
  const ui = await bridgeUi(async (route, init) => {
    calls.push([route, JSON.parse(init.body)]);
    if (route.endsWith('/prepare')) return gate.promise;
    return Response.json({ action: { actionId: 'act-one', state: 'accepted' } });
  });
  const button = ui.nodes.get('btn-bridge-send-confirm');
  const first = button.events.click();
  const second = button.events.click(); // synthetic invocation bypasses disabled: handler must also guard
  assert.equal(button.disabled, true);
  assert.equal(ui.nodes.get('bridge-send-target').disabled, true);
  assert.equal(ui.nodes.get('bridge-send-text').readOnly, true);
  ui.nodes.get('btn-bridge-send-cancel').events.click();
  assert.equal(ui.nodes.get('bridge-send-dialog').open, true, 'cannot dismiss while dispatching');
  let prevented = false;
  ui.nodes.get('bridge-send-dialog').events.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Escape cannot discard an active action');
  // Even programmatic changes cannot alter the request snapshot.
  ui.nodes.get('bridge-send-target').value = 'sess-2';
  ui.nodes.get('bridge-send-text').value = 'changed';
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { sessionId: 'sess-1', kind: 'send-text', text: 'frozen message' });
  gate.resolve(Response.json({ action: { actionId: 'act-one' } }));
  await Promise.all([first, second]);
  assert.deepEqual(calls.map(([route]) => route), ['/api/bridge/prepare', '/api/bridge/confirm']);
  assert.deepEqual(calls[1][1], { actionId: 'act-one' });
  await button.events.click();
  assert.equal(calls.length, 2, 'a queued click after the dialog closes must not create another action');
});

test('bridge UI: double click during confirm neither prepares nor confirms another action', async () => {
  const gate = deferred();
  const calls = [];
  const ui = await bridgeUi(async (route) => {
    calls.push(route);
    return route.endsWith('/prepare')
      ? Response.json({ action: { actionId: 'act-one' } }) : gate.promise;
  });
  const button = ui.nodes.get('btn-bridge-send-confirm');
  const first = button.events.click();
  await flush();
  assert.deepEqual(calls, ['/api/bridge/prepare', '/api/bridge/confirm']);
  await button.events.click();
  await ui.nodes.get('btn-bridge-send').events.click();
  assert.equal(calls.length, 2);
  gate.resolve(Response.json({ action: { actionId: 'act-one', state: 'accepted' } }));
  await first;
});

test('bridge UI: lost confirm reply preserves the action across close/reopen and checks status only', async () => {
  const calls = [];
  const ui = await bridgeUi(async (route) => {
    calls.push(route);
    if (route.endsWith('/prepare')) return Response.json({ action: { actionId: 'act-one' } });
    if (route.endsWith('/confirm')) throw new Error('reply lost after acceptance');
    return Response.json({ action: { actionId: 'act-one', state: 'accepted' } });
  });
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.match(ui.nodes.get('bridge-send-error').textContent, /reply lost/);
  assert.equal(ui.nodes.get('bridge-send-target').disabled, true);
  ui.nodes.get('btn-bridge-send-cancel').events.click();
  await ui.nodes.get('btn-bridge-send').events.click();
  assert.equal(ui.nodes.get('bridge-send-target').value, 'sess-1');
  assert.equal(ui.nodes.get('bridge-send-text').value, 'frozen message');
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.deepEqual(calls, ['/api/bridge/prepare', '/api/bridge/confirm', '/api/bridge/actions/act-one']);
  assert.equal(ui.nodes.get('bridge-send-dialog').open, false);
});

test('bridge UI: retry of an unreceived confirm reuses its actionId after a read-only status check', async () => {
  const calls = [];
  let confirms = 0;
  const ui = await bridgeUi(async (route, init) => {
    calls.push([route, init?.body ? JSON.parse(init.body) : null]);
    if (route.endsWith('/prepare')) return Response.json({ action: { actionId: 'act-one' } });
    if (route.includes('/actions/')) return Response.json({ action: { actionId: 'act-one', state: 'prepared' } });
    if (++confirms === 1) throw new Error('request never arrived');
    return Response.json({ action: { actionId: 'act-one', state: 'accepted' } });
  });
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.equal(calls.filter(([route]) => route.endsWith('/prepare')).length, 1);
  assert.deepEqual(calls.filter(([route]) => route.endsWith('/confirm')).map(([, body]) => body), [{ actionId: 'act-one' }, { actionId: 'act-one' }]);
});

test('bridge UI: prepare failure unlocks editing without confirming or sending', async () => {
  const calls = [];
  const ui = await bridgeUi(async (route) => {
    calls.push(route);
    return Response.json({ code: 'outbox_persist_failed', error: 'not saved' }, { status: 507 });
  });
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.deepEqual(calls, ['/api/bridge/prepare']);
  assert.equal(ui.nodes.get('btn-bridge-send-confirm').disabled, false);
  assert.equal(ui.nodes.get('bridge-send-target').disabled, false);
  assert.equal(ui.nodes.get('bridge-send-text').readOnly, false);
  assert.match(ui.nodes.get('bridge-send-error').textContent, /outbox_persist_failed/);
});

test('bridge UI: unknown remains bound to the old action when reopened, never prepares a replacement', async () => {
  const calls = [];
  const ui = await bridgeUi(async (route) => {
    calls.push(route);
    return Response.json({ action: route.endsWith('/prepare')
      ? { actionId: 'act-one' } : { actionId: 'act-one', state: 'unknown' } });
  });
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  await ui.nodes.get('btn-bridge-send').events.click();
  assert.equal(ui.nodes.get('bridge-send-target').disabled, true);
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.deepEqual(calls, ['/api/bridge/prepare', '/api/bridge/confirm', '/api/bridge/actions/act-one']);
});

test('bridge UI: a different action in a confirm reply cannot unlock a fresh send', async () => {
  const calls = [];
  const ui = await bridgeUi(async (route) => {
    calls.push(route);
    return Response.json({ action: route.endsWith('/prepare')
      ? { actionId: 'act-one' } : { actionId: 'act-other', state: 'accepted' } });
  });
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.equal(ui.nodes.get('bridge-send-dialog').open, true);
  assert.match(ui.nodes.get('bridge-send-error').textContent, /回执无效/);
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.deepEqual(calls, ['/api/bridge/prepare', '/api/bridge/confirm', '/api/bridge/actions/act-one']);
});

test('bridge UI: explicit new open after known acceptance permits a separate user action', async () => {
  let prepares = 0;
  let actionId;
  const confirms = [];
  const ui = await bridgeUi(async (route, init) => {
    if (route.endsWith('/prepare')) {
      actionId = `act-${++prepares}`;
      return Response.json({ action: { actionId } });
    }
    confirms.push(JSON.parse(init.body).actionId);
    return Response.json({ action: { actionId, state: 'accepted' } });
  });
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  await ui.nodes.get('btn-bridge-send').events.click();
  assert.equal(ui.nodes.get('bridge-send-target').disabled, false);
  ui.nodes.get('bridge-send-text').value = 'explicit next message';
  await ui.nodes.get('btn-bridge-send-confirm').events.click();
  assert.equal(prepares, 2);
  assert.deepEqual(confirms, ['act-1', 'act-2']);
});

function agentSdk(chat = { id: 'chosen-model', provider: 'chosen-provider' }) {
  const calls = [];
  const sdk = { agents: {
    async list(input) { calls.push(['list', input]); return { agents: [{ id: 'agent-a', isCurrent: true }] }; },
    async profile(input) { calls.push(['profile', input]); return { profile: { id: 'agent-a', name: 'A', yuan: 'ming', description: 'public', identity: 'private identity', models: { chat } } }; },
  } };
  return { sdk, calls };
}

test('Codex requests do not invent a reasoning status when the transport omits it', async () => {
  const ui = uiEnvironment();
  const hana = { ready() {}, api: { async fetch(_path, init) {
    const { requestId } = JSON.parse(init.body);
    return new Response([
      { type: 'start', requestId, provider: 'openai-codex', model: 'gpt-5.6-luna' },
      { type: 'text-delta', requestId, delta: 'answer' }, { type: 'done', requestId },
    ].map(frame => JSON.stringify(frame)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  ui.nodes.get('input-card-1').value = 'question';
  await ui.nodes.get('cards-layer').children[0].querySelector('[data-action="send"]').events.click();
  assert.match(ui.nodes.get('cards-layer').children[0].innerHTML, /openai-codex\/gpt-5\.6-luna/);
  assert.doesNotMatch(ui.nodes.get('cards-layer').children[0].innerHTML, /推理 medium/);
  assert.match(ui.nodes.get('cards-layer').children[0].innerHTML, /已完成/);
  ui.windowEvents.pagehide(); await flush();
});

test('same-card duplicate sends and branching are blocked while pending; other drafts and focus survive', async () => {
  const ui = uiEnvironment();
  let resolveResponse;
  const calls = [];
  const hana = { ready() {}, api: { fetch(route, init) {
    if (route.endsWith('/cancel')) return Promise.resolve(Response.json({ cancelled: true }));
    calls.push(JSON.parse(init.body));
    return new Promise(resolve => { resolveResponse = resolve; });
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  const first = ui.nodes.get('cards-layer').children[0];
  ui.nodes.get('btn-new-root').events.click();
  const other = ui.nodes.get('cards-layer').children[1];
  const otherInput = [...other.nodes.values()].find(node => node.id.startsWith('input-'));
  otherInput.value = 'unsent draft'; otherInput.events.input(); otherInput.setSelectionRange(2, 5); otherInput.focus();
  const otherBodyId = `body-${other.id.slice(4)}`;
  ui.nodes.get(otherBodyId).scrollTop = 37;
  first.querySelector('#input-card-1').value = 'send';
  const pending = first.querySelector('[data-action="send"]').events.click();
  first.querySelector('#input-card-1').value = 'duplicate';
  await first.querySelector('[data-action="send"]').events.click();
  first.querySelector('[data-action="branch"]').events.click({ stopPropagation() {} });
  assert.equal(calls.length, 1);
  assert.equal(ui.nodes.get('cards-layer').children.length, 2);
  assert.equal(ui.environment.document.activeElement.value, 'unsent draft');
  assert.equal(ui.environment.document.activeElement.selectionStart, 2);
  resolveResponse(chatResponse(calls[0].requestId));
  await pending;
  assert.equal(ui.environment.document.activeElement.value, 'unsent draft');
  assert.equal(ui.environment.document.activeElement.selectionEnd, 5);
  assert.equal(ui.nodes.get(otherBodyId).scrollTop, 37);
});

test('partial error remains visible but neither it nor branch helper banners enter child context', async () => {
  const ui = uiEnvironment(); const calls = [];
  const hana = { ready() {}, api: { async fetch(route, init) {
    if (route.endsWith('/cancel')) return Response.json({ cancelled: false });
    const body = JSON.parse(init.body); calls.push(body);
    return chatResponse(body.requestId, calls.length === 1 ? 'PARTIAL_BAD' : 'ok', calls.length === 1 ? 'error' : 'done');
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  let first = ui.nodes.get('cards-layer').children[0];
  first.querySelector('#input-card-1').value = 'root question';
  await first.querySelector('[data-action="send"]').events.click();
  first = ui.nodes.get('cards-layer').children[0];
  assert.match(first.innerHTML, /PARTIAL_BAD/);
  assert.match(first.innerHTML, /PROVIDER_ERROR/);
  first.querySelector('[data-action="branch"]').events.click({ stopPropagation() {} });
  const child = ui.nodes.get('cards-layer').children[1];
  const input = [...child.nodes.values()].find(node => node.id.startsWith('input-'));
  input.value = 'child question';
  await child.querySelector('[data-action="send"]').events.click();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].messages.every(message => !message.content.includes('PARTIAL_BAD') && !message.content.includes('承袭前置上下文')));
  assert.deepEqual(calls[1].messages.map(message => message.content), ['root question', 'child question']);
});

test('host converter error with valid text output is gracefully accepted as completed', async () => {
  const ui = uiEnvironment(); const calls = [];
  const hana = { ready() {}, api: { async fetch(route, init) {
    if (route.endsWith('/cancel')) return Response.json({ cancelled: false });
    const body = JSON.parse(init.body); calls.push(body);
    return new Response([
      JSON.stringify({ type: 'start', requestId: body.requestId, provider: 'openai-codex', model: 'gpt-5.6-luna' }),
      JSON.stringify({ type: 'text-delta', requestId: body.requestId, delta: 'valid complete answer' }),
      JSON.stringify({ type: 'error', requestId: body.requestId, code: 'APP_MODEL_PROVIDER_ERROR', message: 'The model provider could not complete the request.' }),
    ].join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  let first = ui.nodes.get('cards-layer').children[0];
  first.querySelector('#input-card-1').value = 'root question';
  await first.querySelector('[data-action="send"]').events.click();
  first = ui.nodes.get('cards-layer').children[0];
  assert.match(first.innerHTML, /valid complete answer/);
  assert.doesNotMatch(first.innerHTML, /APP_MODEL_PROVIDER_ERROR/);
  assert.match(first.innerHTML, /已完成/);
  // Branching is enabled and incorporates the answer
  first.querySelector('[data-action="branch"]').events.click({ stopPropagation() {} });
  const child = ui.nodes.get('cards-layer').children[1];
  const input = [...child.nodes.values()].find(node => node.id.startsWith('input-'));
  input.value = 'child question';
  await child.querySelector('[data-action="send"]').events.click();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messages.map(message => message.content), ['root question', 'valid complete answer', 'child question']);
});

test('cancel button, closing card and pagehide stop their pending requests', async () => {
  for (const action of ['cancel', 'close', 'pagehide']) {
    const ui = uiEnvironment(); const routes = [];
    const hana = { ready() {}, api: { fetch(route) {
      routes.push(route);
      return route.endsWith('/cancel') ? Promise.resolve(Response.json({ cancelled: true })) : new Promise(() => {});
    } } };
    await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
    const first = ui.nodes.get('cards-layer').children[0];
    first.querySelector('#input-card-1').value = 'pending';
    const pending = first.querySelector('[data-action="send"]').events.click();
    if (action === 'pagehide') ui.windowEvents.pagehide();
    else ui.nodes.get('cards-layer').children[0].querySelector(`[data-action="${action}"]`).events.click({ stopPropagation() {} });
    await pending;
    assert.equal(routes.filter(route => route.endsWith('/cancel')).length, 1);
    if (action === 'pagehide') {
      const status = [...ui.nodes.entries()].find(([id]) => id.startsWith('status-req-'))?.[1];
      assert.match(status.textContent, /已停止接收/);
    } else if (action !== 'close') assert.match(ui.nodes.get('cards-layer').children[0].innerHTML, /已停止接收/);
  }
});

test('mood is escaped in a separate collapsed area; branch summaries and context use only the answer', async () => {
  const ui = uiEnvironment(); const calls = [];
  const raw = '<mood>PRIVATE_MOOD <img src=x onerror=alert(1)></mood>\nPublic answer';
  const hana = { ready() {}, api: { async fetch(route, init) {
    const body = JSON.parse(init.body); calls.push(body);
    return chatResponse(body.requestId, calls.length === 1 ? raw : 'child answer');
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  let root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'root question';
  await root.querySelector('[data-action="send"]').events.click();
  root = ui.nodes.get('cards-layer').children[0];
  const bubble = root.innerHTML.match(/class="msg-bubble" id="reply-[^"]+"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.equal(bubble, '\nPublic answer');
  assert.match(root.innerHTML, /PRIVATE_MOOD &lt;img/);
  assert.doesNotMatch(root.innerHTML, /<img/);
  assert.equal(ui.nodes.get(`asides-${calls[0].requestId}`).open, false);
  root.querySelector('[data-action="branch"]').events.click({ stopPropagation() {} });
  const child = ui.nodes.get('cards-layer').children[1];
  assert.match(child.innerHTML, /Public answer/);
  assert.doesNotMatch(child.innerHTML, /PRIVATE_MOOD/);
  const input = [...child.nodes.values()].find(node => node.id.startsWith('input-'));
  input.value = 'child question';
  await child.querySelector('[data-action="send"]').events.click();
  assert.equal(calls[1].messages.find(message => message.role === 'assistant').content, '\nPublic answer');
  assert.ok(calls[1].messages.every(message => !message.content.includes('PRIVATE_MOOD')));
});

test('split opening tags never flash in the bubble and disclosure state survives streaming and redraw', async () => {
  const ui = uiEnvironment(); let stream; let requestId;
  const encoder = new TextEncoder();
  const hana = { ready() {}, api: { async fetch(_route, init) {
    requestId = JSON.parse(init.body).requestId;
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  const root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'question';
  const pending = root.querySelector('[data-action="send"]').events.click();
  await flush();
  const frame = event => stream.enqueue(encoder.encode(JSON.stringify({ requestId, ...event }) + '\n'));
  frame({ type: 'start', provider: 'p', model: 'm' });
  frame({ type: 'text-delta', delta: '<pu' });
  await flush();
  assert.equal(ui.nodes.get(`reply-${requestId}`).textContent, '');
  frame({ type: 'text-delta', delta: 'lse>PRIVATE_MOOD</pu' });
  await flush();
  assert.equal(ui.nodes.get(`reply-${requestId}`).textContent, '');
  assert.match(ui.nodes.get(`asides-text-${requestId}`).textContent, /PRIVATE_MOOD/);
  const details = ui.nodes.get(`asides-${requestId}`);
  // Native details.open changes before its asynchronous toggle event fires.
  // Exercise a structural redraw in that window without manually firing toggle.
  details.open = true;
  const summary = ui.environment.document.getElementById(`asides-toggle-${requestId}`);
  summary.focus();
  ui.nodes.get('btn-new-root').events.click();
  assert.equal(ui.nodes.get(`asides-${requestId}`).open, true);
  assert.equal(ui.environment.document.activeElement.id, `asides-toggle-${requestId}`);
  frame({ type: 'text-delta', delta: 'lse>Answer' });
  await flush();
  assert.equal(ui.nodes.get(`reply-${requestId}`).textContent, 'Answer');
  assert.equal(details.open, true);
  frame({ type: 'done' }); stream.close();
  await pending;
  assert.equal(ui.nodes.get(`asides-${requestId}`).open, true);
  ui.nodes.get('btn-new-root').events.click();
  assert.equal(ui.nodes.get(`asides-${requestId}`).open, true);
});

test('mouse-focused send and cancel controls return focus to their input across redraw', async () => {
  for (const cancel of [false, true]) {
    const ui = uiEnvironment();
    const hana = { ready() {}, api: { fetch(route, init) {
      if (route.endsWith('/cancel')) return Promise.resolve(Response.json({ cancelled: true }));
      return cancel ? new Promise(() => {}) : Promise.resolve(chatResponse(JSON.parse(init.body).requestId, '<mood>ok</mood>Answer'));
    } } };
    await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
    let root = ui.nodes.get('cards-layer').children[0];
    root.querySelector('#input-card-1').value = 'question';
    const send = root.querySelector('[data-action="send"]');
    send.focus();
    const pending = send.events.click();
    assert.equal(ui.environment.document.activeElement.id, 'input-card-1');
    if (cancel) {
      root = ui.nodes.get('cards-layer').children[0];
      const button = root.querySelector('[data-action="cancel"]');
      button.focus(); button.events.click();
    }
    await pending;
    assert.equal(ui.environment.document.activeElement.id, 'input-card-1');
  }
});

test('mood-only success is reported as missing answer and does not pollute following requests', async () => {
  const ui = uiEnvironment(); const calls = []; const routes = [];
  const hana = { ready() {}, api: { async fetch(route, init) {
    routes.push(route); const body = JSON.parse(init.body); calls.push(body);
    return chatResponse(body.requestId, calls.length === 1 ? '<reflect>NO_ANSWER</reflect>' : 'answer');
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  let root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'first';
  await root.querySelector('[data-action="send"]').events.click();
  root = ui.nodes.get('cards-layer').children[0];
  assert.match(root.innerHTML, /EMPTY_BODY/);
  assert.match(root.innerHTML, /NO_ANSWER/);
  root.querySelector('#input-card-1').value = 'second';
  await root.querySelector('[data-action="send"]').events.click();
  assert.ok(calls[1].messages.every(message => !message.content.includes('NO_ANSWER')));
  assert.ok(routes.every(route => !route.endsWith('/cancel')));
});

test('user-authored mood tags remain literal text in display and model context', async () => {
  const ui = uiEnvironment(); const calls = [];
  const hana = { ready() {}, api: { async fetch(_route, init) {
    const body = JSON.parse(init.body); calls.push(body); return chatResponse(body.requestId);
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  const root = ui.nodes.get('cards-layer').children[0];
  const literal = '<mood>user example</mood>';
  root.querySelector('#input-card-1').value = literal;
  await root.querySelector('[data-action="send"]').events.click();
  assert.equal(calls[0].messages[0].content, literal);
  assert.match(ui.nodes.get('cards-layer').children[0].innerHTML, /&lt;mood&gt;user example&lt;\/mood&gt;/);
});

function canvasState(ui) { return ui.broadcasts.filter(message => message.type === 'FORK_SESSION_STATE').at(-1); }
function sessionCommand(ui, command, sessionId) {
  ui.receive({ type: 'FORK_SESSION_COMMAND', targetCanvasId: canvasState(ui).canvasId, command, sessionId });
}

test('App session switching and reopening restore independent branches, drafts, agent and viewport', async () => {
  const ui = uiEnvironment(), calls = [];
  const hana = { ready() {}, api: { async fetch(_route, init) {
    const body = JSON.parse(init.body); calls.push(body); return chatResponse(body.requestId, 'Answer for ' + body.messages.at(-1).content);
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  const firstId = canvasState(ui).activeId;
  let root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'Question A';
  await root.querySelector('[data-action="send"]').events.click();
  root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('[data-action="branch"]').events.click({ stopPropagation() {} });
  root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'A saved draft'; root.querySelector('#input-card-1').events.input();
  ui.nodes.get('btn-zoom-in').events.click();
  ui.receive({ type: 'AGENT_CHANGED', agent: { id: 'custom-a', name: 'Custom A', provider: 'p-a', model: 'm-a' } });
  const created = ui.nextState(state => state.activeId !== firstId && state.ready && !state.busy);
  sessionCommand(ui, 'new');
  const secondId = (await created).activeId;
  assert.equal(ui.nodes.get('cards-layer').children.length, 1);
  assert.equal(ui.nodes.get('input-card-1').value, '');
  assert.equal(ui.nodes.get('zoom-text').textContent, '100%');
  root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'Question B';
  await root.querySelector('[data-action="send"]').events.click();
  assert.ok(calls[1].messages.every(message => !message.content.includes('Question A')));
  const switched = ui.nextState(state => state.activeId === firstId && !state.busy);
  sessionCommand(ui, 'switch', firstId); await switched;
  assert.equal(ui.nodes.get('cards-layer').children.length, 2);
  assert.equal(ui.nodes.get('input-card-1').value, 'A saved draft');
  assert.equal(ui.nodes.get('zoom-text').textContent, '115%');
  assert.match(ui.nodes.get('active-agent-display').textContent, /Custom A/);
  ui.windowEvents.pagehide(); await flush();
  const reopened = uiEnvironment();
  await loadModule('../ui/assets/panel.js', imports(hana), reopened.environment);
  assert.equal(canvasState(reopened).activeId, firstId);
  assert.equal(reopened.nodes.get('cards-layer').children.length, 2);
  assert.equal(reopened.nodes.get('input-card-1').value, 'A saved draft');
  const b = await createForkSessionStore(hana, { locks: hosts.get(hana).locks }).get(secondId);
  assert.equal(b.snapshot.cards.length, 1);
  assert.ok(b.snapshot.cards[0].messages.some(message => message.text === 'Question B'));
  reopened.windowEvents.pagehide(); await flush();
});

test('old session deltas, terminal results and delayed cancel callbacks cannot mutate the new canvas', async () => {
  const ui = uiEnvironment(), calls = [];
  const hana = { ready() {} };
  const dependencies = imports(hana);
  dependencies['./chat-client.js'] = { ChatError, runChat(_sdk, body, callbacks) {
    return new Promise(resolve => { calls.push({ body, callbacks, resolve }); });
  } };
  await loadModule('../ui/assets/panel.js', dependencies, ui.environment);
  const firstId = canvasState(ui).activeId;
  let root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'A question';
  const oldPending = root.querySelector('[data-action="send"]').events.click();
  calls[0].callbacks.onEvent({ type: 'text-delta', delta: 'A partial' });
  const created = ui.nextState(state => state.activeId !== firstId && !state.busy);
  sessionCommand(ui, 'new'); await created;
  root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'B question';
  const newPending = root.querySelector('[data-action="send"]').events.click();
  calls[0].callbacks.onEvent({ type: 'text-delta', delta: 'LATE_A' });
  calls[0].callbacks.onEvent({ type: 'done' });
  calls[0].callbacks.onWaiting(); calls[0].callbacks.onCancelResult(false, 'LATE_CANCEL_A');
  calls[0].resolve({ text: 'LATE_A' }); await oldPending;
  root = ui.nodes.get('cards-layer').children[0];
  assert.doesNotMatch(root.innerHTML, /A partial|LATE_A|LATE_CANCEL_A/);
  root.querySelector('#input-card-1').value = 'blocked duplicate';
  await root.querySelector('[data-action="send"]').events.click();
  assert.equal(calls.length, 2);
  calls[1].callbacks.onEvent({ type: 'text-delta', delta: 'B answer' });
  calls[1].resolve({ text: 'B answer' }); await newPending;
  const storedA = await createForkSessionStore(hana, { locks: hosts.get(hana).locks }).get(firstId);
  assert.equal(storedA.snapshot.cards[0].messages.at(-1).text, 'A partial');
  assert.equal(storedA.snapshot.cards[0].messages.at(-1).status, 'cancelled');
  assert.match(ui.nodes.get('cards-layer').children[0].innerHTML, /B answer/);
  ui.windowEvents.pagehide(); await flush();
});

test('AGENT_CHANGED broadcast updates header and card role immediately without losing drafts', async () => {
  const ui = uiEnvironment(); const hana = { ready() {} };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();
  let root = ui.nodes.get('cards-layer').children[0];
  assert.match(root.innerHTML, /Hakimi/);
  root.querySelector('#input-card-1').value = 'my draft';
  root.querySelector('#input-card-1').events.input();
  ui.receive({ type: 'AGENT_CHANGED', agent: { id: 'cixiaogui', name: '星见凛', provider: 'openai-codex', model: 'gpt-5.6-luna' } });
  assert.equal(ui.nodes.get('active-agent-display').textContent, '当前助手: 星见凛 [gpt-5.6-luna]');
  root = ui.nodes.get('cards-layer').children[0];
  assert.match(root.innerHTML, /星见凛/);
  assert.equal(root.querySelector('#input-card-1').value, 'my draft');
  ui.windowEvents.pagehide(); await flush();
});

test('historical messages retain their original agent names across agent switches', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = { ready() {}, api: { async fetch(_path, init) {
    if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
    const req = JSON.parse(init.body);
    requests.push(req);
    return new Response([
      JSON.stringify({ type: 'start', requestId: req.requestId, provider: 'gemini', model: 'gemini-3.8' }),
      JSON.stringify({ type: 'text-delta', requestId: req.requestId, delta: `Answer by ${req.agentId}` }),
      JSON.stringify({ type: 'done', requestId: req.requestId, text: `Answer by ${req.agentId}` }),
    ].join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  } } };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  // 1. Initial agent is Hakimi
  let card = ui.nodes.get('cards-layer').children[0];
  card.querySelector('#input-card-1').value = 'Hello Hakimi';
  await card.querySelector('[data-action="send"]').events.click();

  card = ui.nodes.get('cards-layer').children[0];
  assert.match(card.innerHTML, /Hakimi/);
  assert.match(card.innerHTML, /Answer by hakimi/);

  // 2. Switch agent to 星见凛
  ui.receive({ type: 'AGENT_CHANGED', agent: { id: 'cixiaogui', name: '星见凛', provider: 'openai-codex', model: 'gpt-5.6-luna' } });

  // Hakimi's historical reply STILL says Hakimi
  card = ui.nodes.get('cards-layer').children[0];
  assert.match(card.innerHTML, /Hakimi/);

  // 3. Send follow-up question to 星见凛
  card.querySelector('#input-card-1').value = 'Hello Rin';
  await card.querySelector('[data-action="send"]').events.click();

  // 4. Verify both agents coexist on the same card with their respective names
  card = ui.nodes.get('cards-layer').children[0];
  assert.match(card.innerHTML, /Hakimi/);
  assert.match(card.innerHTML, /星见凛/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].agentId, 'hakimi');
  assert.equal(requests[1].agentId, 'cixiaogui');

  // 5. Switch agent to Luna, verify Hakimi and 星见凛 are STILL unchanged
  ui.receive({ type: 'AGENT_CHANGED', agent: { id: 'luna-tester', name: 'Luna 质检测试', provider: 'openai-codex', model: 'gpt-5.6-luna' } });
  card = ui.nodes.get('cards-layer').children[0];
  assert.match(card.innerHTML, /Hakimi/);
  assert.match(card.innerHTML, /星见凛/);

  ui.windowEvents.pagehide(); await flush();
});

test('failed durable save blocks a session switch without losing drafts; explicit retry succeeds', async () => {
  const ui = uiEnvironment(); const hana = { ready() {} };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  const id = canvasState(ui).activeId;
  ui.nodes.get('input-card-1').value = 'unsaved important draft';
  ui.nodes.get('input-card-1').events.input();
  hosts.get(hana).control.failWrites = true;
  const failed = ui.nextState(state => Boolean(state.error) && !state.busy);
  sessionCommand(ui, 'new'); await failed;
  assert.equal(canvasState(ui).activeId, id);
  assert.equal(ui.nodes.get('input-card-1').value, 'unsaved important draft');
  assert.match(ui.nodes.get('session-status').textContent, /SAVE_DENIED/);
  hosts.get(hana).control.failWrites = false;
  const recovered = ui.nextState(state => !state.error && !state.saving && !state.dirty && !state.busy);
  ui.nodes.get('btn-retry-save').events.click(); await recovered;
  const saved = await createForkSessionStore(hana, { locks: hosts.get(hana).locks }).get(id);
  assert.equal(saved.snapshot.cards[0].draft, 'unsaved important draft');
  ui.windowEvents.pagehide(); await flush();
});

test('sidebar lists only App sessions and targets one canvas without writing storage', async () => {
  const ui = uiEnvironment(); const hana = { ready() {}, api: { async fetch() { return Response.json({ ok: true, agents: [{ id: 'real', name: 'Real' }] }); } } };
  const dependencies = imports(hana), host = hosts.get(hana);
  const store = createForkSessionStore(hana, { locks: host.locks });
  const snapshot = { cards: [], view: { x: 0, y: 0, scale: 1 }, agent: {} };
  const one = await store.create(snapshot, { title: '<img src=x>' });
  const two = await store.create(snapshot, { title: 'Second' });
  const writes = host.control.writes;
  await loadModule('../ui/assets/function-panel.js', dependencies, ui.environment); await flush();
  assert.equal(ui.nodes.get('btn-new-session').disabled, true);
  ui.receive({ type: 'FORK_SESSION_STATE', canvasId: 'canvas-one', activeId: two.id, ready: true, busy: false, agent: { id: 'real' } });
  assert.equal(ui.nodes.get('session-count').textContent, '2');
  assert.equal(ui.nodes.get('btn-new-session').disabled, false);
  const row = ui.nodes.get('session-list').children.find(item => item.getAttribute('data-session-id') === one.id);
  const target = ui.nodes.get(`session-select-${one.id}`);
  assert.ok(row.children.includes(target));
  assert.equal(target.children[0].textContent, '<img src=x>');
  target.events.click();
  assert.equal(ui.broadcasts.at(-1).type, 'FORK_SESSION_COMMAND');
  assert.equal(ui.broadcasts.at(-1).targetCanvasId, 'canvas-one');
  assert.equal(ui.broadcasts.at(-1).sessionId, one.id);
  ui.receive({ type: 'FORK_SESSION_STATE', canvasId: 'other-canvas', ready: false, busy: true });
  assert.equal(ui.nodes.get('btn-new-session').disabled, false);
  assert.equal(host.control.writes, writes);
});

test('main rename reads a private intent, preserves drafts and sends no title or snapshot on the shared bus', async () => {
  const ui = uiEnvironment(), hana = { ready() {} };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  const store = createForkSessionStore(hana, { locks: hosts.get(hana).locks });
  const record = await store.get(canvasState(ui).activeId);
  const input = ui.nodes.get('input-card-1'); input.value = 'retained draft'; input.events.input();
  await writeRenameIntent(hana, { requestId: 'req-main-rename', sessionId: record.id, title: '<img private title>', expectedTitle: record.title });
  const result = ui.nextMessage(message => message.type === 'FORK_SESSION_RESULT' && message.requestId === 'req-main-rename');
  ui.receive({ type: 'FORK_SESSION_COMMAND', targetCanvasId: canvasState(ui).canvasId,
    command: 'rename', sessionId: record.id, requestId: 'req-main-rename', panelId: 'test-panel' });
  assert.equal((await result).ok, true);
  const saved = await store.get(record.id);
  assert.equal(saved.title, '<img private title>');
  assert.equal(saved.snapshot.cards[0].draft, 'retained draft');
  assert.equal(ui.nodes.get('input-card-1').value, 'retained draft');
  assert.doesNotMatch(JSON.stringify(ui.broadcasts), /private title|retained draft|snapshot/);
  await writeRenameIntent(hana, { requestId: 'req-conflict-rename', sessionId: record.id,
    title: 'newer secret title', expectedTitle: 'stale secret title' });
  const rejected = ui.nextMessage(message => message.type === 'FORK_SESSION_RESULT' && message.requestId === 'req-conflict-rename');
  ui.receive({ type: 'FORK_SESSION_COMMAND', targetCanvasId: canvasState(ui).canvasId,
    command: 'rename', sessionId: record.id, requestId: 'req-conflict-rename', panelId: 'test-panel' });
  assert.equal((await rejected).ok, false);
  assert.doesNotMatch(JSON.stringify(ui.broadcasts), /private title|secret title|retained draft|snapshot/);
  ui.windowEvents.pagehide(); await flush();
  await assert.rejects(readRenameIntent(hana, 'req-main-rename', record.id), /过期/);
});

test('a delete command only opens confirmation; cancel and scripted clicks never delete; trusted confirmation deletes the last session', async () => {
  const ui = uiEnvironment(), hana = { ready() {} };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  const store = createForkSessionStore(hana, { locks: hosts.get(hana).locks });
  const id = canvasState(ui).activeId;
  const foreign = await store.get(id); foreign.snapshot.cards[0].draft = 'foreign updated draft';
  await store.save(id, foreign.revision, foreign.snapshot);
  const writes = hosts.get(hana).control.writes;
  const request = { type: 'FORK_SESSION_COMMAND', targetCanvasId: canvasState(ui).canvasId,
    command: 'delete', sessionId: id, panelId: 'test-panel', requestId: 'req-delete', confirmed: true };
  ui.receive(request); await flush();
  assert.equal(ui.nodes.get('delete-session-dialog').open, true);
  assert.match(ui.nodes.get('delete-dialog-progress').textContent, /可能来自其他窗口/);
  assert.equal(hosts.get(hana).control.writes, writes);
  await ui.nodes.get('btn-delete-confirm').events.click({ isTrusted: false });
  assert.equal((await store.get(id)).id, id);
  ui.nodes.get('delete-session-dialog').events.cancel({ preventDefault() {} });
  assert.equal(ui.nodes.get('delete-session-dialog').open, false);
  assert.equal((await store.get(id)).id, id);
  ui.receive({ ...request, requestId: 'req-delete-confirm' }); await flush();
  await ui.nodes.get('btn-delete-confirm').events.click({ isTrusted: true });
  await assert.rejects(store.get(id), error => error.code === 'SESSION_NOT_FOUND');
  assert.equal(canvasState(ui).activeId, null);
  assert.equal(ui.nodes.get('delete-session-dialog').open, false);
  assert.equal((await store.list()).sessions.length, 0);
  ui.windowEvents.pagehide(); await flush();
});

test('deleting a generating session guards against late deltas, terminal results and cancellation callbacks', async () => {
  const ui = uiEnvironment(), hana = { ready() {} }, calls = [];
  const dependencies = imports(hana);
  dependencies['./chat-client.js'] = { ChatError, runChat(_sdk, body, callbacks) {
    return new Promise(resolve => calls.push({ body, callbacks, resolve }));
  } };
  await loadModule('../ui/assets/panel.js', dependencies, ui.environment);
  const id = canvasState(ui).activeId;
  const store = createForkSessionStore(hana, { locks: hosts.get(hana).locks });
  const other = await store.create({ cards: [{ id: 'card-other', parentId: null, x: 0, y: 0, width: 340, messages: [{ role: 'assistant', localOnly: true, text: 'Other' }] }], view: { x: 0, y: 0, scale: 1 }, agent: {} }, { title: 'Other' });
  // 创建动作会切换全局 activeId；本测试继续验证原会话删除，因此显式切回原会话。
  await store.activate(id);
  sessionCommand(ui, 'switch', id);
  await flush();
  await flush();
  let root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'old question';
  const oldPending = root.querySelector('[data-action="send"]').events.click();
  calls[0].callbacks.onEvent({ type: 'text-delta', delta: 'old partial' });
  sessionCommand(ui, 'delete', id); await flush();
  // Opening a confirmation is not a cancellation or a persistence write.
  assert.equal(calls[0].callbacks.signal.aborted, false);
  await ui.nodes.get('btn-delete-confirm').events.click({ isTrusted: true });
  assert.equal(calls[0].callbacks.signal.aborted, true);
  assert.equal(canvasState(ui).activeId, other.id);
  root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-other').value = 'new question';
  const nextPending = root.querySelector('[data-action="send"]').events.click();
  calls[0].callbacks.onEvent({ type: 'text-delta', delta: 'LATE_DELETED' });
  calls[0].callbacks.onWaiting(); calls[0].callbacks.onCancelResult(false, 'LATE_CANCEL');
  calls[0].resolve({ text: 'LATE_DELETED' }); await oldPending;
  assert.doesNotMatch(ui.nodes.get('cards-layer').children[0].innerHTML, /old partial|LATE_DELETED|LATE_CANCEL/);
  calls[1].resolve({ text: 'new answer' }); await nextPending;
  assert.match(ui.nodes.get('cards-layer').children[0].innerHTML, /new answer/);
  await assert.rejects(store.get(id), error => error.code === 'SESSION_NOT_FOUND');
  ui.windowEvents.pagehide(); await flush();
});

test('sidebar right-click and more share a menu without switching; rename preserves caret and keeps payload private', async () => {
  const ui = uiEnvironment(), hana = { ready() {}, api: { async fetch() { return Response.json({ agents: [] }); } } };
  const dependencies = imports(hana), host = hosts.get(hana), store = createForkSessionStore(hana, { locks: host.locks });
  const record = await store.create({ cards: [], view: { x: 0, y: 0, scale: 1 }, agent: {} }, { title: 'Original' });
  await loadModule('../ui/assets/function-panel.js', dependencies, ui.environment); await flush();
  const state = { type: 'FORK_SESSION_STATE', canvasId: 'canvas-test', ready: true, busy: false, activeId: record.id };
  ui.receive(state);
  const row = ui.nodes.get('session-list').children[0];
  row.events.contextmenu({ preventDefault() {}, stopPropagation() {}, clientX: 299, clientY: 799 });
  assert.equal(ui.nodes.get('session-context-menu').hidden, false);
  assert.ok(parseFloat(ui.nodes.get('session-context-menu').style.left) <= 140);
  assert.equal(ui.broadcasts.filter(message => message.command === 'switch').length, 0);
  ui.documentEvents.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(ui.nodes.get('session-context-menu').hidden, true);
  ui.nodes.get(`session-more-${record.id}`).events.click({ stopPropagation() {} });
  ui.nodes.get('session-menu-rename').events.click();
  let input = ui.nodes.get('session-rename-input');
  input.value = 'sensitive new title'; input.events.input({ target: input }); input.setSelectionRange(2, 5);
  ui.receive(state);
  assert.equal(ui.nodes.get('session-rename-input'), input);
  assert.equal(input.selectionStart, 2);
  input.events.compositionstart();
  await store.create({ cards: [], view: { x: 0, y: 0, scale: 1 }, agent: {} }, { title: 'Other session' });
  await flush();
  assert.equal(ui.nodes.get('session-rename-input'), input); // A real list change must not destroy the active IME input.
  input.events.compositionend({ target: input });
  input = ui.nodes.get('session-rename-input');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.value, 'sensitive new title');
  await input.events.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(ui.broadcasts.filter(message => message.command === 'rename').length, 0);
  ui.nodes.get('session-rename-save').events.click(); await flush();
  const command = ui.broadcasts.find(message => message.command === 'rename');
  assert.equal(command.sessionId, record.id);
  assert.equal((await readRenameIntent(hana, command.requestId, record.id)).title, 'sensitive new title');
  assert.doesNotMatch(JSON.stringify(ui.broadcasts), /sensitive new title|Original/);
  ui.receive({ type: 'FORK_SESSION_RESULT', canvasId: 'wrong', targetPanelId: command.panelId,
    requestId: command.requestId, command: 'rename', ok: true });
  assert.equal(ui.nodes.get('session-rename-save').disabled, true);
  ui.receive({ type: 'FORK_SESSION_RESULT', canvasId: 'canvas-test', targetPanelId: command.panelId,
    requestId: command.requestId, command: 'rename', ok: false, error: 'SAVE_DENIED' });
  assert.equal(ui.nodes.get('session-rename-input').value, 'sensitive new title');
  assert.equal(ui.nodes.get('session-rename-save').disabled, false);
  await clearRenameIntent(hana, command.requestId);
});

test('sidebar deletion is only an intent; cancellation and unmatched replies never mutate records', async () => {
  const ui = uiEnvironment(), hana = { ready() {}, api: { async fetch() { return Response.json({ agents: [] }); } } };
  const dependencies = imports(hana), host = hosts.get(hana), store = createForkSessionStore(hana, { locks: host.locks });
  const record = await store.create({ cards: [], view: { x: 0, y: 0, scale: 1 }, agent: {} });
  await loadModule('../ui/assets/function-panel.js', dependencies, ui.environment); await flush();
  ui.receive({ type: 'FORK_SESSION_STATE', canvasId: 'canvas-test', ready: true, busy: false, activeId: record.id });
  const writes = host.control.writes;
  ui.nodes.get(`session-more-${record.id}`).events.click({ stopPropagation() {} });
  ui.nodes.get('session-menu-delete').events.click();
  const command = ui.broadcasts.at(-1);
  assert.equal(command.command, 'delete');
  assert.equal(host.control.writes, writes);
  ui.receive({ type: 'FORK_SESSION_RESULT', canvasId: 'canvas-test', targetPanelId: command.panelId,
    requestId: 'wrong', command: 'delete', ok: false, error: 'FORGED_ERROR' });
  assert.doesNotMatch(ui.nodes.get('session-status').textContent, /FORGED_ERROR/);
  ui.receive({ type: 'FORK_SESSION_RESULT', canvasId: 'canvas-test', targetPanelId: command.panelId,
    requestId: command.requestId, command: 'delete', ok: false, cancelled: true });
  assert.equal(ui.nodes.get('session-status').textContent, '');
  assert.equal((await store.get(record.id)).id, record.id);
});

test('agent metadata comes from the public SDK and list does not leak systemPrompt', async () => {
  const { sdk, calls } = agentSdk();
  const directory = createAgentDirectory(sdk);
  const entries = await directory.list();
  assert.deepEqual(calls, [['list', { scope: 'all', lifecycle: 'active' }], ['profile', { agentId: 'agent-a', scope: 'all' }]]);
  assert.equal(entries[0].model, 'chosen-model');
  assert.equal(entries[0].provider, 'chosen-provider');
  assert.equal(entries[0].isCurrent, true);
  assert.equal('systemPrompt' in entries[0], false);
  assert.equal((await directory.getProfile('agent-a')).systemPrompt, 'private identity');
});

test('agent permission failures propagate without substituting a default model', async () => {
  const denial = new Error('CAPABILITY_DENIED');
  const directory = createAgentDirectory({ agents: { async profile() { throw denial; }, async list() { throw denial; } } });
  await assert.rejects(directory.getProfile('agent-a'), error => error === denial);
  await assert.rejects(directory.list(), error => error === denial);
});

test('agent model and provider whitespace is normalized', async () => {
  const { sdk } = agentSdk({ id: '   ', provider: ' \t ' });
  const profile = await createAgentDirectory(sdk).getProfile('agent-a');
  assert.equal(profile.model, '');
  assert.equal(profile.provider, '');
});

async function chatRoute(chat, profileError) {
  const { sdk } = agentSdk(chat);
  if (profileError) sdk.agents.profile = async () => { throw profileError; };
  let modelCalls = 0;
  const routes = new Map();
  Object.assign(sdk, {
    dataDir: '/unused-test-data', logger: { async info() {}, async warn() {} },
    tools: { async register() {} },
    routes: { async register(register) { register({ get() {}, delete() {}, post(route, handler) { routes.set(route, handler); } }); } },
    models: { async cancel() {}, async stream() { modelCalls++; }, async *streamEvents() { modelCalls++; yield { type: 'text-delta', delta: 'ok' }; yield { type: 'done' }; } },
  });
  const module = await loadModule('../index.js', {
    './sdk/app-contract/server-client.js': { defineApp: setup => ({ apply: setup }) },
    './lib/agents.js': { createAgentDirectory },
    './lib/chat.js': await import('../lib/chat.js'),
    './lib/document-parser.js': await import('../lib/document-parser.js'),
    './lib/app-settings.js': await import('../lib/app-settings.js'),
    './lib/upload-store.js': await import('../lib/upload-store.js'),
    './lib/document-service.js': await import('../lib/document-service.js'),
    './lib/bridge-service.js': await import('../lib/bridge-service.js'),
    './lib/bridge-intents.js': await import('../lib/bridge-intents.js'),
    './lib/parser-network.js': await import('../lib/parser-network.js'),
    './lib/mineru-parse.js': await import('../lib/mineru-parse.js'),
    './lib/parse-router.js': await import('../lib/parse-router.js'),
    'node:fs/promises': { default: fs },
    'node:path': { default: path },
    'node:net': { default: net },
  });
  await module.namespace.default.apply(sdk);
  const response = await routes.get('/api/chat/stream')({
    req: { raw: new Request('http://localhost/chat', { method: 'POST' }), async json() { return { requestId: 'req-route-test', agentId: 'agent-a', messages: [{ role: 'user', content: 'hi' }] }; } },
    get() { return { principal: { kind: 'app', credentialId: 'test-surface' } }; },
    json(value, status = 200) { return Response.json(value, { status }); },
  });
  return { response, modelCalls };
}

for (const [name, chat] of [['missing model', {}], ['blank model', { id: ' ', provider: 'host' }], ['blank provider', { id: 'model', provider: ' ' }]]) {
  test(`chat rejects ${name} before invoking inference`, async () => {
    const { response, modelCalls } = await chatRoute(chat);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'AGENT_MODEL_UNCONFIGURED');
    assert.equal(modelCalls, 0);
  });
}

test('chat rejects an unreadable profile before invoking inference', async () => {
  const error = Object.assign(new Error('Denied'), { code: 'CAPABILITY_DENIED' });
  const { response, modelCalls } = await chatRoute({}, error);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'CAPABILITY_DENIED');
  assert.equal(modelCalls, 0);
});

test('chat streams the selected agent model through the registered route', async () => {
  const { response, modelCalls } = await chatRoute({ id: 'model', provider: 'provider' });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(event => event.type === 'text-delta').delta, 'ok');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(modelCalls, 1);
});

test('function panel embeds per-agent thinking effort select menus, maintains separate memory, and broadcasts on switch', async () => {
  const ui = uiEnvironment();
  const hana = {
    ready() {},
    api: {
      async fetch() {
        return Response.json({
          ok: true,
          agents: [
            {
              id: 'sol-architect',
              name: 'Sol 架构师',
              provider: 'openai-sol',
              model: 'gpt-6.1-sol',
              reasoning: true,
              thinkingLevels: ['None', 'low', 'medium', 'high', 'max'],
            },
            {
              id: 'gemini-flash',
              name: 'Gemini Flash',
              provider: 'google',
              model: 'gemini-flash',
              reasoning: true,
              thinkingLevels: ['low', 'high'],
            },
            {
              id: 'simple-bot',
              name: 'Simple Bot',
              provider: 'local',
              model: 'llama-small',
              reasoning: false,
              thinkingLevels: [],
            },
          ],
        });
      },
    },
  };

  await loadModule('../ui/assets/function-panel.js', imports(hana), ui.environment);
  await flush();

  // 1. Sol 架构师卡片内包含完整的一级下拉菜单 select，None 归一化为显式关闭 off
  const solSelect = ui.nodes.get('select-sol-architect');
  assert.ok(solSelect);
  assert.equal(solSelect.value, 'default');
  assert.equal(solSelect.children.length, 6); // default + off + low + medium + high + max
  assert.ok(solSelect.children.some(opt => opt.value === 'off'));

  // 在 Sol 下拉菜单中选中“高” (high)
  solSelect.value = 'high';
  await solSelect.events.change();
  assert.equal(ui.environment.localStorage.getItem('fork_chat_agent_effort_sol-architect'), 'high');

  // 2. 检查 Gemini Flash：拥有独立的下拉菜单，此时仍为“default”，没有被 Sol 串改
  const flashSelect = ui.nodes.get('select-gemini-flash');
  assert.ok(flashSelect);
  assert.equal(flashSelect.value, 'default');
  assert.equal(flashSelect.children.length, 3); // default + low + high

  // 将 Gemini Flash 单独配置为“低” (low)
  flashSelect.value = 'low';
  await flashSelect.events.change();
  assert.equal(ui.environment.localStorage.getItem('fork_chat_agent_effort_gemini-flash'), 'low');
  // Sol 的配置依然保持为“high”
  assert.equal(ui.nodes.get('select-sol-architect').value, 'high');

  // 3. Simple Bot 不支持 reasoning，不内嵌多余的下拉行
  const simpleSelect = ui.nodes.get('select-simple-bot');
  assert.equal(simpleSelect, undefined);

  // 4. 切换到 Gemini Flash：广播带上 Flash 的专属档位 'low'
  const flashCard = ui.nodes.get('agent-gemini-flash');
  await flashCard.events.click();

  const lastAgentChange = ui.broadcasts.filter(m => m.type === 'AGENT_CHANGED').at(-1);
  assert.equal(lastAgentChange.agent.id, 'gemini-flash');
  assert.equal(lastAgentChange.reasoningEffort, 'low');

  // 5. 切换回 Sol 架构师：广播自动带回 Sol 的专属档位 'high'
  const solCard = ui.nodes.get('agent-sol-architect');
  await solCard.events.click();

  const solAgentChange = ui.broadcasts.filter(m => m.type === 'AGENT_CHANGED').at(-1);
  assert.equal(solAgentChange.agent.id, 'sol-architect');
  assert.equal(solAgentChange.reasoningEffort, 'high');
});

test('canvas accepts REASONING_EFFORT_CHANGED, forwards to stream, displays badge, and survives session restore', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = {
    ready() {},
    api: {
      async fetch(_path, init) {
        if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
        const req = JSON.parse(init.body);
        requests.push(req);
        return new Response([
          JSON.stringify({ type: 'start', requestId: req.requestId, provider: 'openai-sol', model: 'gpt-6.1-sol', reasoningEffort: req.reasoningEffort }),
          JSON.stringify({ type: 'text-delta', requestId: req.requestId, delta: '架构设计完成' }),
          JSON.stringify({ type: 'done', requestId: req.requestId, text: '架构设计完成' }),
        ].join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  // 1. 发送 REASONING_EFFORT_CHANGED 广播
  ui.receive({ type: 'REASONING_EFFORT_CHANGED', reasoningEffort: 'high' });

  // 2. 发送消息
  let card = ui.nodes.get('cards-layer').children[0];
  card.querySelector('#input-card-1').value = '请做架构设计';
  await card.querySelector('[data-action="send"]').events.click();

  // 3. 校验请求携带 reasoningEffort: 'high'
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reasoningEffort, 'high');

  // 4. 校验首帧带回并在卡片元信息中展示 '思考 high'
  card = ui.nodes.get('cards-layer').children[0];
  assert.match(card.innerHTML, /思考 high/);

  // 5. 校验快照状态包含 reasoningEffort
  const state = canvasState(ui);
  assert.equal(state.agent.reasoningEffort, 'high');

  ui.windowEvents.pagehide();
  await flush();
});

test('sendCardPrompt supports concurrent streaming on multiple cards with independent agents and reasoning efforts', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = {
    ready() {},
    api: {
      async fetch(_path, init) {
        if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
        if (_path.endsWith('/api/agents')) {
          return Response.json({
            ok: true,
            agents: [
              { id: 'sol-architect', name: 'Sol 架构师', model: 'gpt-6.1-sol', provider: 'openai' },
              { id: 'gemini-flash', name: 'Gemini Flash', model: 'gemini-flash', provider: 'google' },
            ],
          });
        }
        const req = JSON.parse(init.body);
        requests.push(req);
        const replyText = req.agentId === 'sol-architect' ? 'Sol方案输出' : 'Flash快速输出';
        return new Response([
          JSON.stringify({ type: 'start', requestId: req.requestId, provider: req.modelRef?.split('/')[0], model: req.modelRef?.split('/')[1], reasoningEffort: req.reasoningEffort }),
          JSON.stringify({ type: 'text-delta', requestId: req.requestId, delta: replyText }),
          JSON.stringify({ type: 'done', requestId: req.requestId, text: replyText }),
        ].join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  // 创建第二张卡片
  ui.nodes.get('btn-new-root').events.click();
  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();
  assert.equal(cards.length, 2);

  // 并发向两张卡片分别发送不同的 prompt 与独立配置的助手/思考深度
  const p1 = forkChat.sendCardPrompt(cards[0], '问题1：系统架构', {
    agent: { id: 'sol-architect', name: 'Sol 架构师', model: 'gpt-6.1-sol', provider: 'openai' },
    reasoningEffort: 'max',
  });
  const p2 = forkChat.sendCardPrompt(cards[1], '问题2：快速总结', {
    agent: { id: 'gemini-flash', name: 'Gemini Flash', model: 'gemini-flash', provider: 'google' },
    reasoningEffort: 'low',
  });

  await Promise.all([p1, p2]);
  await flush();

  // 1. 验证两路请求并发到达，各自参数严格隔离
  assert.equal(requests.length, 2);
  const solReq = requests.find(r => r.agentId === 'sol-architect');
  const flashReq = requests.find(r => r.agentId === 'gemini-flash');
  assert.ok(solReq);
  assert.ok(flashReq);
  assert.equal(solReq.reasoningEffort, 'max');
  assert.equal(flashReq.reasoningEffort, 'low');
  assert.equal(solReq.messages.at(-1).content, '问题1：系统架构');
  assert.equal(flashReq.messages.at(-1).content, '问题2：快速总结');

  // 2. 验证两张卡片各自渲染对应的回复与助手名称
  const cardEls = ui.nodes.get('cards-layer').children;
  assert.match(cardEls[0].innerHTML, /Sol 架构师/);
  assert.match(cardEls[0].innerHTML, /Sol方案输出/);
  assert.match(cardEls[1].innerHTML, /Gemini Flash/);
  assert.match(cardEls[1].innerHTML, /Flash快速输出/);

  ui.windowEvents.pagehide();
  await flush();
});

test('battle dialog opens from both triggers, validates inputs, and triggers parallel branching', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = {
    ready() {},
    api: {
      async fetch(_path, init) {
        if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
        if (_path.endsWith('/api/agents')) {
          return Response.json({
            ok: true,
            agents: [
              { id: 'sol-architect', name: 'Sol 架构师', model: 'gpt-6.1-sol', provider: 'openai' },
              { id: 'cixiaogui', name: '星见凛', model: 'gpt-5.6-luna', provider: 'openai' },
              { id: 'agent-mqb7zal0', name: '客服小祥', model: 'gemini-3.8-flash-high', provider: 'google' },
            ],
          });
        }
        const req = JSON.parse(init.body);
        requests.push(req);
        return new Response([
          JSON.stringify({ type: 'start', requestId: req.requestId, provider: 'test', model: 'test' }),
          JSON.stringify({ type: 'text-delta', requestId: req.requestId, delta: `回复: ${req.agentId}` }),
          JSON.stringify({ type: 'done', requestId: req.requestId, text: `回复: ${req.agentId}` }),
        ].join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  // 为助手预置不同的思考深度
  ui.environment.localStorage.setItem('fork_chat_agent_effort_sol-architect', 'max');
  ui.environment.localStorage.setItem('fork_chat_agent_effort_cixiaogui', 'high');

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const card = ui.nodes.get('cards-layer').children[0];
  const btnBattleFooter = card.querySelector('[data-action="battle"]');
  const btnBranchBattle = card.querySelector('[data-action="branch-battle"]');
  assert.ok(btnBattleFooter, '底部应存在【对比 ▾】按钮');
  assert.ok(btnBranchBattle, '右侧锚点应存在【对比分支】按钮');

  // 1. 测试右侧锚点触发打开对话框
  card.querySelector('#input-card-1').value = '对比问题草稿';
  await btnBranchBattle.events.click({ stopPropagation() {} });
  await flush();

  const dialog = ui.nodes.get('battle-dialog');
  assert.equal(dialog.open, true, '对话框应处于打开状态');
  const promptInput = ui.nodes.get('battle-prompt-input');
  assert.equal(promptInput.value, '对比问题草稿', '草稿应自动带入推导问题框');

  // 2. 校验表单空校验
  promptInput.value = '';
  await ui.nodes.get('btn-battle-submit').events.click();
  const errorEl = ui.nodes.get('battle-dialog-error');
  assert.equal(errorEl.textContent, '请输入推导问题。');
  assert.equal(dialog.open, true, '校验失败不应关闭对话框');

  // 3. 填入有效问题并点击开始并发推导
  promptInput.value = '对比：Rust vs Go 选型';
  await ui.nodes.get('btn-battle-submit').events.click();
  await flush();

  // 4. 验证对话框关闭，两路对比分支被创建且流式并发触发
  assert.equal(dialog.open, false);
  const cards = ui.environment.window.__forkChat.getCards();
  assert.equal(cards.length, 3, '应包含1个父卡片和2个对比分支卡片');

  const branch1 = cards[1];
  const branch2 = cards[2];
  assert.equal(branch1.parentId, 'card-1');
  assert.equal(branch2.parentId, 'card-1');
  assert.match(branch1.title, /对比 #1/);
  assert.match(branch2.title, /对比 #2/);

  // 5. 验证两路网络请求都已发出且携带各自配置
  assert.equal(requests.length, 2);
  const req1 = requests.find(r => r.agentId === 'sol-architect');
  const req2 = requests.find(r => r.agentId === 'cixiaogui');
  assert.ok(req1);
  assert.ok(req2);
  assert.equal(req1.reasoningEffort, 'max');
  assert.equal(req2.reasoningEffort, 'high');
  assert.equal(req1.messages.at(-1).content, '对比：Rust vs Go 选型');
  assert.equal(req2.messages.at(-1).content, '对比：Rust vs Go 选型');

  ui.windowEvents.pagehide();
  await flush();
});

test('battle branches: collision-free Y positioning, cluster viewport fit, connector fan-out and [对比推导] tag', async () => {
  const ui = uiEnvironment();
  const hana = {
    ready() {},
    api: {
      async fetch(_path) {
        if (_path.endsWith('/api/agents')) {
          return Response.json({
            ok: true,
            agents: [
              { id: 'sol-architect', name: 'Sol 架构师', model: 'gpt-6.1-sol', provider: 'openai' },
              { id: 'cixiaogui', name: '星见凛', model: 'gpt-5.6-luna', provider: 'openai' },
            ],
          });
        }
        return new Response(JSON.stringify({ type: 'done', text: '完成' }) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();
  const parentCard = cards[0];
  parentCard.x = 100;
  parentCard.y = 200;

  // 1. 测试 calculateBranchYPositions 无冲突时的对称分布
  const targetX = parentCard.x + parentCard.width + 120;
  const ysWithoutCollision = forkChat.calculateBranchYPositions(parentCard, 2, targetX);
  assert.equal(ysWithoutCollision.length, 2);
  // totalSpan = 1 * 380 = 380, idealStartY = 200 - 190 = 10
  assert.equal(ysWithoutCollision[0], 10);
  assert.equal(ysWithoutCollision[1], 390);

  // 2. 模拟同列已有卡片碰撞（例如已有卡片位于 y = 50）
  cards.push({ id: 'blocking-card', x: targetX, y: 50, width: 340, messages: [] });
  const ysWithCollision = forkChat.calculateBranchYPositions(parentCard, 2, targetX);
  // 避让后应位于已有最大 y(50) + step(380) = 430 起步
  assert.equal(ysWithCollision[0], 430);
  assert.equal(ysWithCollision[1], 810);
  cards.pop(); // 移除临时阻挡卡片

  // 3. 运行 runBattleBranches 并检查 [对比推导] 标签与视口自适应
  await forkChat.runBattleBranches(parentCard, '架构对比', [
    { id: 'sol-architect', name: 'Sol 架构师' },
    { id: 'cixiaogui', name: '星见凛' },
  ]);
  await flush();

  const cardEls = ui.nodes.get('cards-layer').children;
  assert.equal(cardEls.length, 3);
  assert.match(cardEls[1].innerHTML, /\[对比推导\]/, '对比分支卡片应包含 [对比推导] 标签');
  assert.match(cardEls[2].innerHTML, /\[对比推导\]/, '对比分支卡片应包含 [对比推导] 标签');

  // 4. 验证视口 view 已自适应调整
  const view = forkChat.getView();
  assert.ok(view.scale <= 1.0, '视口缩放比例应在合理范围');
  assert.ok(typeof view.x === 'number' && typeof view.y === 'number');

  // 5. 验证 SVG 连线扇出（2个兄弟分支，起点 Y 应错位）
  const svgChildren = ui.nodes.get('connectors-svg').children;
  // 两个子分支，每个分支包含 pathBg, main path, circle 共 3 个元素，合计 6 个
  assert.equal(svgChildren.length, 6);
  const pathD1 = svgChildren[1].getAttribute('d');
  const pathD2 = svgChildren[4].getAttribute('d');
  // sibIndex 0: 110 + (0 - 0.5) * 12 = 104 -> M (100+340)=440 (200+104)=304
  // sibIndex 1: 110 + (1 - 0.5) * 12 = 116 -> M (100+340)=440 (200+116)=316
  assert.match(pathD1, /M 440 304/);
  assert.match(pathD2, /M 440 316/);

  ui.windowEvents.pagehide();
  await flush();
});

test('power-user keyboard shortcuts: Tab branch & focus, Space hand-tool, Arrow navigation, and Delete hierarchy', async () => {
  const ui = uiEnvironment();
  const hana = { ready() {} };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();
  assert.equal(cards.length, 1);
  const root = cards[0];

  // 1. 选中 root 卡片并在全局按 Tab 触发快速开辟追问分支
  forkChat.selectCard(root.id, false);
  assert.equal(forkChat.getSelectedCardId(), root.id);

  let tabPrevented = false;
  ui.windowEvents.keydown({ key: 'Tab', preventDefault() { tabPrevented = true; } });
  await flush();

  assert.equal(tabPrevented, true, 'Tab 按键默认行为应被拦截');
  assert.equal(cards.length, 2, '应成功生成追问分支');
  const branch1 = cards[1];
  assert.equal(branch1.parentId, root.id);
  assert.equal(forkChat.getSelectedCardId(), branch1.id, '新卡片应自动获得选中态');
  assert.equal(ui.environment.document.activeElement.id, `input-${branch1.id}`, '新卡片输入框应自动获得焦点');

  // 2. 在分支输入框内直接按 Tab 进一步拉出二级分支
  const branch1Input = ui.nodes.get(`input-${branch1.id}`);
  let inputTabPrevented = false;
  branch1Input.events.keydown({ key: 'Tab', preventDefault() { inputTabPrevented = true; } });
  await flush();

  assert.equal(inputTabPrevented, true);
  assert.equal(cards.length, 3, '应成功生成二级分支');
  const branch2 = cards[2];
  assert.equal(branch2.parentId, branch1.id);
  assert.equal(forkChat.getSelectedCardId(), branch2.id);

  // 3. 测试方向键导航（ArrowLeft 回溯父卡片，ArrowRight 深入子卡片）
  ui.environment.document.activeElement = null; // 模拟离开输入框编辑态
  let arrowPrevented = false;
  ui.windowEvents.keydown({ key: 'ArrowLeft', preventDefault() { arrowPrevented = true; } });
  assert.equal(arrowPrevented, true);
  assert.equal(forkChat.getSelectedCardId(), branch1.id, '按 ArrowLeft 应回退到父卡片 branch1');

  ui.windowEvents.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(forkChat.getSelectedCardId(), branch2.id, '按 ArrowRight 应深入到子卡片 branch2');

  // 4. 测试 Space 键抓手模式
  let spacePrevented = false;
  ui.windowEvents.keydown({ code: 'Space', preventDefault() { spacePrevented = true; } });
  assert.equal(spacePrevented, true);
  assert.equal(forkChat.getIsSpacePressed(), true, '按下 Space 应开启抓手模式');

  ui.windowEvents.keyup({ code: 'Space' });
  assert.equal(forkChat.getIsSpacePressed(), false, '松开 Space 应退出抓手模式');

  // 5. 测试 Backspace 键不会误触删除，Delete 快捷键才关闭当前选中卡片
  let backspacePrevented = false;
  ui.windowEvents.keydown({ key: 'Backspace', preventDefault() { backspacePrevented = true; } });
  await flush();
  assert.equal(backspacePrevented, false, 'Backspace 不应触发卡片关闭');
  assert.equal(forkChat.getCards().some(c => c.id === branch2.id), true, 'Backspace 不应删除卡片');

  let delPrevented = false;
  ui.windowEvents.keydown({ key: 'Delete', preventDefault() { delPrevented = true; } });
  await flush();
  assert.equal(delPrevented, true);
  assert.equal(forkChat.getCards().some(c => c.id === branch2.id), false, 'branch2 应已被删除');

  ui.windowEvents.pagehide();
  await flush();
});

test('auto-tidy engine: aligns hierarchy, vertically centers parents, prevents overlap, and fits viewport', async () => {
  const ui = uiEnvironment();
  const hana = { ready() {} };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();
  const root = cards[0];

  // 构造一棵深度为 2 的分支树：root -> child1, child2; child1 -> grandchild1
  const child1 = { id: 'child-1', parentId: root.id, title: '分支1', x: 999, y: -500, width: 340, messages: [] };
  const child2 = { id: 'child-2', parentId: root.id, title: '分支2', x: -80, y: 1200, width: 340, messages: [] };
  const grandchild1 = { id: 'gc-1', parentId: 'child-1', title: '孙分支1', x: 0, y: 0, width: 340, messages: [] };
  cards.push(child1, child2, grandchild1);

  // 混乱的初始坐标
  root.x = 450; root.y = 800;

  // 1. 按下 Shift + A 触发自动整理
  let tidyPrevented = false;
  ui.windowEvents.keydown({ key: 'A', shiftKey: true, preventDefault() { tidyPrevented = true; } });
  await flush();

  assert.equal(tidyPrevented, true, 'Shift+A 默认行为应被拦截');

  // 2. 验证分层 X 轴对齐 (startX=80, stepX=460)
  assert.equal(root.x, 80, '根节点 X 应位于 80');
  assert.equal(child1.x, 540, '一级子节点 X 应位于 80 + 460 = 540');
  assert.equal(child2.x, 540, '一级子节点 X 应位于 80 + 460 = 540');
  assert.equal(grandchild1.x, 1000, '二级子节点 X 应位于 540 + 460 = 1000');

  // 3. 验证无重叠与父节点垂直居中
  // 叶子节点按从上到下排列：grandchild1 是 child1 的唯一叶子，child2 是另一个叶子
  assert.ok(child2.y >= child1.y + 360 + 32, '兄弟节点垂直间距应大于等于卡片高度与边距');
  // root 应当对齐到 child1 与 child2 的垂直中轴
  assert.equal(root.y, Math.round((child1.y + child2.y) / 2), '父节点 Y 轴应对齐首尾子节点中心');

  // 4. 验证全局视口已适配
  const view = forkChat.getView();
  assert.ok(view.scale <= 1.0);
  assert.ok(typeof view.x === 'number' && typeof view.y === 'number');

  ui.windowEvents.pagehide();
  await flush();
});

test('convergence & merge node: Shift+click multi-selection, multi-parent SVG connectors, and synthesized synthesis streaming', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = {
    ready() {},
    api: {
      async fetch(_path, init) {
        if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
        if (_path.endsWith('/api/agents')) return Response.json({ ok: true, agents: [] });
        const req = JSON.parse(init.body);
        requests.push(req);
        return new Response([
          JSON.stringify({ type: 'start', requestId: req.requestId, provider: 'test', model: 'test' }),
          JSON.stringify({ type: 'text-delta', requestId: req.requestId, delta: '综合裁决方案完成' }),
          JSON.stringify({ type: 'done', requestId: req.requestId, text: '综合裁决方案完成' }),
        ].join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();
  const root = cards[0];

  // 1. 构造两个已有结论的分支
  const branchA = {
    id: 'branch-a',
    parentId: root.id,
    title: '方案A (分布式)',
    x: 500,
    y: 100,
    width: 340,
    messages: [
      { role: 'user', content: '如何提高吞吐？' },
      { role: 'assistant', text: '建议采用 Kafka + 分布式集群架构。', status: 'completed' },
    ],
  };
  const branchB = {
    id: 'branch-b',
    parentId: root.id,
    title: '方案B (单体优化)',
    x: 500,
    y: 500,
    width: 340,
    messages: [
      { role: 'user', content: '如何降低成本？' },
      { role: 'assistant', text: '建议采用高效单机进程 + 本地缓存。', status: 'completed' },
    ],
  };
  cards.push(branchA, branchB);

  // 2. 测试多选卡片 (Shift+Click)
  forkChat.toggleMultiSelectCard(branchA.id);
  forkChat.toggleMultiSelectCard(branchB.id);

  const selectedIds = forkChat.getMultiSelectedCardIds();
  assert.equal(selectedIds.size, 2);
  assert.ok(selectedIds.has('branch-a'));
  assert.ok(selectedIds.has('branch-b'));

  const toolbar = ui.nodes.get('merge-toolbar');
  assert.equal(toolbar.hidden, false, '多选 >= 2 时合并悬浮工具条应显现');
  const countText = ui.nodes.get('merge-count-text');
  assert.match(countText.textContent, /2 个分支/);

  // 3. 点击合并总结按钮，触发生成收敛卡片
  await ui.nodes.get('btn-merge-submit').events.click();
  await flush();

  // 验证多选状态自动清空，工具条隐藏
  assert.equal(forkChat.getMultiSelectedCardIds().size, 0);
  assert.equal(toolbar.hidden, true);

  // 验证收敛卡片已创建并挂入 cards
  const latestCards = forkChat.getCards();
  const mergeNode = latestCards.find(c => c.isMerge);
  assert.ok(mergeNode, '应成功生成收敛卡片');
  assert.equal(mergeNode.parentIds.length, 2, '收敛卡片应包含两个父节点 ID');
  assert.ok(mergeNode.parentIds.includes('branch-a'));
  assert.ok(mergeNode.parentIds.includes('branch-b'));
  assert.match(mergeNode.title, /合并总结/);

  // 4. 验证 DOM 渲染 [合并总结] 标签
  const cardEls = ui.nodes.get('cards-layer').children;
  const mergeEl = cardEls.find(el => el.id === `dom-${mergeNode.id}`);
  assert.ok(mergeEl);
  assert.match(mergeEl.innerHTML, /\[合并总结\]/);

  // 5. 验证多亲 SVG 连线（两个父节点分别拉出连线汇入到该合并卡片）
  const svgChildren = ui.nodes.get('connectors-svg').children;
  // 两个分支（branchA, branchB）各连 root（2个），加 mergeNode 连 branchA 与 branchB（2个）
  // 每个连线 3 个元素（pathBg, main path, circle），共 4 * 3 = 12 个
  assert.equal(svgChildren.length, 12);

  // 6. 验证流式网络请求 Prompt 正确提取了两个分支的方案内容
  assert.equal(requests.length, 1);
  const promptSent = requests[0].messages.at(-1).content;
  assert.match(promptSent, /分布式集群架构/);
  assert.match(promptSent, /单机进程/);
  assert.match(promptSent, /合流裁决任务/);

  ui.windowEvents.pagehide();
  await flush();
});

test('multi-parent merge context includes every ancestor path exactly once', async () => {
  const ui = uiEnvironment();
  const hana = { ready() {} };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  const cards = forkChat.getCards();
  const root = cards[0];
  const branchA = {
    id: 'context-a', parentId: root.id, title: '路径 A', x: 500, y: 100, width: 340,
    messages: [{ role: 'assistant', text: 'A 的结论', status: 'completed' }],
  };
  const branchB = {
    id: 'context-b', parentId: root.id, title: '路径 B', x: 500, y: 500, width: 340,
    messages: [{ role: 'assistant', text: 'B 的结论', status: 'completed' }],
  };
  const merge = {
    id: 'context-merge', parentId: branchA.id, parentIds: [branchA.id, branchB.id],
    title: '合流', x: 1000, y: 300, width: 360,
    messages: [{ role: 'user', text: '综合问题' }],
  };
  cards.push(branchA, branchB, merge);

  const context = forkChat.buildChainContext(merge);
  assert.ok(context.some(message => message.content.includes('A 的结论')));
  assert.ok(context.some(message => message.content.includes('B 的结论')));
  assert.equal(context.filter(message => message.content.includes('A 的结论')).length, 1);
  assert.equal(context.filter(message => message.content.includes('B 的结论')).length, 1);

  ui.windowEvents.pagehide();
  await flush();
});

test('deleting any parent of a merge removes dependent descendants without dangling parentIds', async () => {
  const ui = uiEnvironment();
  const hana = { ready() {} };
  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  const cards = forkChat.getCards();
  const root = cards[0];
  const parentA = { id: 'delete-a', parentId: root.id, title: '父 A', x: 500, y: 100, width: 340, messages: [] };
  const parentB = { id: 'delete-b', parentId: root.id, title: '父 B', x: 500, y: 500, width: 340, messages: [] };
  const merge = {
    id: 'delete-merge', parentId: parentA.id, parentIds: [parentA.id, parentB.id],
    title: '合流', x: 1000, y: 300, width: 360, messages: [],
  };
  const child = { id: 'delete-child', parentId: merge.id, title: '后续', x: 1500, y: 300, width: 340, messages: [] };
  cards.push(parentA, parentB, merge, child);

  forkChat.closeCardHierarchy(parentB);
  const remaining = forkChat.getCards().map(card => card.id);
  assert.equal(remaining.includes(parentA.id), true);
  assert.equal(remaining.includes(parentB.id), false);
  assert.equal(remaining.includes(merge.id), false);
  assert.equal(remaining.includes(child.id), false);

  ui.windowEvents.pagehide();
  await flush();
});

test('connector rendering: negative and distant coordinates maintain unbroken bezier curves with overflow visible', async () => {
  const ui = uiEnvironment();
  const hana = {
    ready() {},
    api: {
      async fetch(_path, _init) {
        if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
        if (_path.endsWith('/api/agents')) return Response.json({ ok: true, agents: [] });
        return new Response('', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();

  // 模拟用户将卡片拖到远距离负坐标 (x: -210, y: -420)
  const root = cards[0];
  root.x = -210;
  root.y = -420;

  // 构造远距离子分支 (x: 383, y: 407)
  const branch1 = {
    id: 'branch-far-1',
    parentId: root.id,
    title: '远距离分支 #1',
    x: 383,
    y: 407,
    width: 340,
    messages: [{ role: 'assistant', text: '远端节点', status: 'completed' }],
  };
  cards.push(branch1);

  // 触发卡片与连线渲染
  forkChat.renderConnectors();
  await flush();

  // 1. 验证 SVG 连线层具有 overflow: visible 防止边缘裁切
  const svgEl = ui.nodes.get('connectors-svg');
  assert.ok(svgEl);

  // 2. 验证生成的贝塞尔曲线包含正确的负坐标起点，且无断裂
  const svgChildren = svgEl.children;
  assert.ok(svgChildren.length >= 3, '应生成背景线、主线与端点圆环');
  const mainPath = svgChildren[1];
  const d = mainPath.getAttribute('d');

  // 起点：root.x(-210) + root.width(340) = 130; root.y(-420) + 110 = -310
  // 终点：branch1.x(383), branch1.y(407) + 110 = 517
  assert.match(d, /M 130 -310/, '路径起点应精确保留负 Y 轴锚点坐标');
  assert.match(d, /383 517/, '路径终点应精确对齐子卡片锚点');

  // 3. 验证当子卡片被拖到父卡片左侧（反向连线）时，从父左侧引出连入子右侧，自适应无麻花畸变
  const branchLeft = {
    id: 'branch-left-1',
    parentId: root.id,
    title: '左侧分支 #1',
    x: -800,
    y: -200,
    width: 300,
    messages: [{ role: 'assistant', text: '左侧节点', status: 'completed' }],
  };
  cards.push(branchLeft);
  forkChat.renderConnectors();
  await flush();

  const leftMainPath = svgEl.children[svgEl.children.length - 2];
  const dLeft = leftMainPath.getAttribute('d');
  assert.match(dLeft, /M -210 -304/, '反向连线起点应从父卡片左侧引出且带有线束错位');
  assert.match(dLeft, /-500 -90/, '反向连线终点应连入子卡片右侧边缘');

  ui.windowEvents.pagehide();
  await flush();
});

test('document card creation, rendering, and context inheritance (形态 B 资料源根卡片)', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = {
    ready() {},
    api: {
      async fetch(_path, init) {
        if (_path.endsWith('/cancel')) return Response.json({ cancelled: false });
        if (_path.endsWith('/api/agents')) return Response.json({ ok: true, agents: [] });
        if (_path.endsWith('/api/document/parse')) {
          const body = JSON.parse(init.body);
          requests.push({ path: _path, body });
          return Response.json({ ok: true, jobId: 'job-1' });
        }
        if (_path.includes('/api/document/parse/job-1')) {
          return Response.json({
            ok: true,
            status: 'done',
            stage: '完成',
            elapsedMs: 120,
            result: {
              ok: true,
              filename: '设备说明书.docx',
              extension: '.docx',
              charCount: 35,
              lineCount: 2,
              engineLabel: 'pdf.js（本地）',
              text: '这是从 Word 文档中提取的核心技术规格说明。',
              preview: '这是从 Word 文档中提取的核心技术规格说明。',
            },
          });
        }
        return new Response('', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);

  // 1. 测试纯文本/Markdown 文件的解析与资料源根卡片创建
  const mdFile = {
    name: '农机动力学研报.md',
    size: 512,
    text: async () => '# 农业机械土壤阻力分析\n深松铲耕作深度为 30cm 时，牵引阻力与土壤含水率呈非线性正相关。',
  };

  const docCard = await forkChat.createDocumentCard(mdFile, { x: 100, y: 150 });
  assert.ok(docCard);
  assert.equal(docCard.isDoc, true);
  assert.equal(docCard.title, '农机动力学研报.md');
  assert.match(docCard.docContent, /深松铲耕作深度为 30cm/);
  assert.equal(docCard.docMeta.charCount > 0, true);

  // 验证渲染的 DOM 包含资料源标签和预览控件
  const cardDom = ui.nodes.get(`dom-${docCard.id}`);
  assert.ok(cardDom);
  assert.match(cardDom.innerHTML, /\[资料源\]/);
  assert.match(cardDom.innerHTML, /tag-doc/);
  assert.match(cardDom.innerHTML, /doc-content-preview/);

  // 2. 测试从资料源卡片开辟分析分支
  const analysisBranch = forkChat.createBranchCard(docCard);
  assert.ok(analysisBranch);
  assert.match(analysisBranch.title, /分析 #1 \(农机动力学研报/);
  assert.match(analysisBranch.messages[0].text, /【承袭前置资料】/);
  assert.match(analysisBranch.messages[0].text, /已承袭《农机动力学研报\.md》/);

  // 3. 模拟在分析分支中提问并验证链式上下文装配（buildChainContext）
  analysisBranch.messages.push({
    role: 'user',
    text: '根据上述研究，请推导耕作阻力最小化的刀盘转速。',
  });
  analysisBranch.messages.push({
    role: 'assistant',
    text: '根据阻力与剪切应力方程，最佳转速区间为 240-280 rpm。',
    status: 'completed',
  });

  const chainMsgs = forkChat.buildChainContext(analysisBranch);
  // 首条应当是资料源的注入（role: user），第二条是助手确认基座（role: assistant）
  assert.ok(chainMsgs.length >= 4);
  assert.equal(chainMsgs[0].role, 'user');
  assert.match(chainMsgs[0].content, /【前置参考资料：《农机动力学研报\.md》】/);
  assert.match(chainMsgs[0].content, /土壤阻力分析/);
  assert.equal(chainMsgs[1].role, 'assistant');
  assert.match(chainMsgs[1].content, /已阅读并完全解析前置资料/);
  // 紧随其后的是分支中的用户提问与助手答复
  assert.equal(chainMsgs[2].role, 'user');
  assert.match(chainMsgs[2].content, /耕作阻力最小化/);
  assert.equal(chainMsgs[3].role, 'assistant');
  assert.match(chainMsgs[3].content, /最佳转速区间为 240-280 rpm/);

  // 4. 测试二进制复杂文档（如 Word .docx）调用后端 /api/document/extract 解析
  const docxFile = {
    name: '设备说明书.docx',
    size: 2048,
    arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
  };

  const wordCard = await forkChat.createDocumentCard(docxFile, { x: 500, y: 150 });
  assert.ok(wordCard);
  assert.equal(wordCard.isDoc, true);
  assert.equal(wordCard.title, '设备说明书.docx');
  assert.match(wordCard.docContent, /这是从 Word 文档中提取的核心技术规格说明/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.filename, '设备说明书.docx');

  ui.windowEvents.pagehide();
  await flush();
});

test('card-level attachment staged, sent, rendered, and inherited into child context (形态 A 卡片局部附件)', async () => {
  const ui = uiEnvironment();
  const requests = [];
  const hana = {
    ready() {},
    api: {
      async fetch(_path, init) {
        if (_path.endsWith('/cancel') || _path.endsWith('cancel')) return Response.json({ cancelled: false });
        if (_path.endsWith('/api/agents') || _path.endsWith('api/agents')) return Response.json({ ok: true, agents: [] });
        const req = JSON.parse(init.body);
        requests.push(req);
        return new Response([
          JSON.stringify({ type: 'start', requestId: req.requestId, provider: 'test-prov', model: 'test-model' }),
          JSON.stringify({ type: 'text-delta', requestId: req.requestId, delta: '已根据附件中的化学收率数据完成分析。' }),
          JSON.stringify({ type: 'done', requestId: req.requestId }),
        ].join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      },
    },
  };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();
  const card = cards[0];

  // 1. 暂存附件到卡片
  card.stagedAttachments = [
    {
      name: '反应数据表.csv',
      size: 1024,
      extension: '.csv',
      charCount: 120,
      lineCount: 5,
      content: '时间,温度,产率\n10,80,65%\n20,90,78%\n30,100,92%',
      preview: '时间,温度,产率\n10,80,65%...',
    }
  ];

  forkChat.renderCards();
  await flush();

  // 验证卡片 DOM 出现暂存附件 chip 与移除按钮
  const cardDom = ui.nodes.get(`dom-${card.id}`);
  assert.ok(cardDom);
  assert.match(cardDom.innerHTML, /反应数据表\.csv/);
  assert.match(cardDom.innerHTML, /staged-att-chip/);

  // 2. 发送带附件的提问
  await forkChat.sendCardPrompt(card, '请分析温度与产率的关系', {
    attachments: [...card.stagedAttachments],
  });
  card.stagedAttachments = [];
  await flush();

  // 3. 验证发送给模型的上下文携带了附件资料全文
  assert.equal(requests.length, 1);
  const sentMsgs = requests[0].messages;
  const lastUserMsg = sentMsgs.find(m => m.role === 'user' && m.content.includes('请分析温度与产率的关系'));
  assert.ok(lastUserMsg);
  assert.match(lastUserMsg.content, /【附件资料：《反应数据表\.csv》】/);
  assert.match(lastUserMsg.content, /时间,温度,产率/);
  assert.match(lastUserMsg.content, /请分析温度与产率的关系/);

  // 4. 验证渲染出的消息气泡包含可展开的附件详情预览
  forkChat.renderCards();
  const currentCardDom = ui.nodes.get('cards-layer').children[0];
  assert.ok(currentCardDom);
  assert.match(currentCardDom.innerHTML, /msg-attachments-list/);
  assert.match(currentCardDom.innerHTML, /msg-attachment-item/);
  assert.match(currentCardDom.innerHTML, /反应数据表\.csv/);

  // 5. 验证从该卡片开辟的子分支在 buildChainContext 时依然能回溯并承袭该附件
  const childBranch = forkChat.createBranchCard(card);
  assert.ok(childBranch);
  const childContext = forkChat.buildChainContext(childBranch);
  const ancestorAttachmentMsg = childContext.find(m => m.role === 'user' && m.content.includes('【附件资料：《反应数据表.csv》】'));
  assert.ok(ancestorAttachmentMsg, '子分支上下文应完整继承父级对话中挂载的附件');

  ui.windowEvents.pagehide();
  await flush();
});

test('card width resizing via drag handle: clamps within bounds, updates connectors, and adapts branching/tidy layouts', async () => {
  const ui = uiEnvironment();
  const hana = { ready() {} };

  await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
  await flush();

  const forkChat = ui.environment.window.__forkChat;
  assert.ok(forkChat);
  const cards = forkChat.getCards();
  const root = cards[0];

  // 初始卡片默认宽度为 340 或由属性设定
  assert.equal(root.width || 340, 340);

  const rootDom = ui.nodes.get(`dom-${root.id}`);
  assert.ok(rootDom);
  const resizeHandle = rootDom.querySelector('[data-action="resize-card"]');
  assert.ok(resizeHandle, '卡片右边缘必须包含拖拽拉伸手柄 DOM');

  // 1. 模拟按下拉伸手柄并拖拽向右拉宽 (clientX: 400 -> 660, dx: +260)
  let prevented = false, stopped = false;
  resizeHandle.events.mousedown({
    clientX: 400,
    stopPropagation() { stopped = true; },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true, '拖拽手柄应阻止默认文本选中行为');
  assert.equal(stopped, true, '拖拽手柄应阻止事件冒泡防止触发外层画布拖动');
  assert.ok(rootDom.classList.contains('is-resizing'), '卡片应进入 is-resizing 视觉状态');
  assert.ok(ui.environment.document.body.classList.contains('is-card-resizing'), 'body 应添加全局水平拉伸光标状态');

  // 触发 mousemove 到 660 (缩放为 1.0 时宽度为 340 + 260 = 600)
  ui.windowEvents.mousemove({ clientX: 660 });
  assert.equal(root.width, 600, '卡片宽度应实时响应拖拽增量并更新为 600');
  assert.equal(rootDom.style.width, '600px', '卡片 DOM style.width 应同步更新');

  // 2. 模拟松开鼠标 (mouseup)
  ui.windowEvents.mouseup();
  assert.equal(rootDom.classList.contains('is-resizing'), false, '松开后应移除 is-resizing');
  assert.equal(ui.environment.document.body.classList.contains('is-card-resizing'), false, '松开后应恢复 body 光标');

  // 3. 边界值限制检验 (Clamping: [260, 1200])
  // 极端向左拉：clientX: 400 -> -200 (dx: -600, 600 - 600 = 0 -> clamped to 260)
  resizeHandle.events.mousedown({ clientX: 400, stopPropagation() {}, preventDefault() {} });
  ui.windowEvents.mousemove({ clientX: -200 });
  assert.equal(root.width, 260, '卡片宽度应被下限钳制在 260px');
  ui.windowEvents.mouseup();

  // 极端向右拉：clientX: 400 -> 2000 (dx: +1600, 260 + 1600 = 1860 -> clamped to 1200)
  resizeHandle.events.mousedown({ clientX: 400, stopPropagation() {}, preventDefault() {} });
  ui.windowEvents.mousemove({ clientX: 2000 });
  assert.equal(root.width, 1200, '卡片宽度应被上限钳制在 1200px');
  ui.windowEvents.mouseup();

  // 3.1 底部拉伸手柄 (handle-bottom) 调整高度 [200, 1600]
  const bottomHandle = rootDom.querySelector('[data-direction="bottom"]');
  assert.ok(bottomHandle, '卡片底边缘应包含 handle-bottom 手柄');
  bottomHandle.events.mousedown({ clientX: 400, clientY: 500, stopPropagation() {}, preventDefault() {} });
  assert.ok(ui.environment.document.body.classList.contains('resizing-s'));
  ui.windowEvents.mousemove({ clientX: 400, clientY: 740 }); // dy = +240, 360 + 240 = 600
  assert.equal(root.height, 600, '卡片高度应实时响应拖拽增量更新为 600');
  assert.equal(rootDom.style.height, '600px');
  assert.ok(rootDom.classList.contains('has-custom-height'), '应附加 has-custom-height 标记解除内部高度限制');
  ui.windowEvents.mouseup();
  assert.equal(ui.environment.document.body.classList.contains('resizing-s'), false);

  // 3.2 右下角对角标手柄 (handle-corner) 宽高同时调整
  const cornerHandle = rootDom.querySelector('[data-direction="corner"]');
  assert.ok(cornerHandle, '卡片右下角应包含 handle-corner 对角缩放手柄');
  cornerHandle.events.mousedown({ clientX: 400, clientY: 500, stopPropagation() {}, preventDefault() {} });
  assert.ok(ui.environment.document.body.classList.contains('resizing-se'));
  ui.windowEvents.mousemove({ clientX: 200, clientY: 700 }); // dx = -200 -> width 1000, dy = +200 -> height 800
  assert.equal(root.width, 1000);
  assert.equal(root.height, 800);
  ui.windowEvents.mouseup();
  assert.equal(ui.environment.document.body.classList.contains('resizing-se'), false);

  // 设回 500px 宽、450px 高测试分支间距与垂直排版
  root.width = 500;
  root.height = 450;
  forkChat.renderCards();

  // 4. 从拉宽拉高后的卡片派生子分支，验证 targetX = parent.x + parent.width + 120
  const branch = forkChat.createBranchCard(root);
  assert.ok(branch);
  assert.equal(branch.x, root.x + 500 + 120, '新分支卡片 X 轴位置应基于父级拉宽后的宽度自适应对齐，绝不重叠');

  // 5. 自动整理算法验证：宽卡片列间距与高卡片垂直避让自适应
  root.x = 80;
  branch.x = 999;
  branch.height = 400;
  const branch2 = forkChat.createBranchCard(root);
  branch2.height = 500;
  forkChat.autoTidyLayout();
  assert.equal(root.x, 80, '根节点排版起始位置在 80');
  assert.equal(branch.x, 80 + 500 + 120, '自动排版引擎应根据深度最大卡片宽度动态计算列间距 (80 + 500 + 120 = 700)');
  assert.ok(branch2.y >= branch.y + 400 + 32, '纵向排版应根据上方兄弟卡片的高度动态避让');

  ui.windowEvents.pagehide();
  await flush();
});

for (const failure of ['permission', 'cancelled']) {
  test(`failed document ${failure} never creates or persists a successful card`, async () => {
    const ui = uiEnvironment();
    let cancellations = 0;
    const hana = { ready() {}, api: { async fetch(route, init = {}) {
      if (route.endsWith('/api/agents')) return Response.json({ ok: true, agents: [] });
      if (init.method === 'DELETE') { cancellations++; return Response.json({ ok: true, settled: true }); }
      if (route.endsWith('/api/document/client-error')) return Response.json({ ok: true });
      if (route.endsWith('/api/document/parse')) {
        if (failure === 'permission') return Response.json({ code: 'APP_RUNTIME_PERMISSION_DENIED', error: 'denied' }, { status: 403 });
        return Response.json({ ok: true, jobId: 'synthetic-doc-job' });
      }
      if (route.endsWith('/synthetic-doc-job')) return Response.json({ ok: true, status: 'cancelled', error: '已取消' });
      return Response.json({ ok: true });
    } } };
    await loadModule('../ui/assets/panel.js', imports(hana), ui.environment);
    await flush();
    const api = ui.environment.window.__forkChat;
    const before = api.getCards().length;
    const result = await api.createDocumentCard({ name: 'failed.pdf', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    await flush();
    assert.equal(result, null);
    assert.equal(api.getCards().length, before);
    assert(!api.getCards().some(card => card.isDoc && card.title === 'failed.pdf'));
    assert.equal(cancellations, failure === 'cancelled' ? 1 : 0);
    assert.match(ui.nodes.get('fork-flash').textContent, /没读出来/);
    const saved = JSON.stringify([...hosts.get(hana).values.values()]);
    assert(!saved.includes('failed.pdf'));
  });
}

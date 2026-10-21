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
import { memoryHost } from './helpers/fork-memory.mjs';
import { createAgentDirectory } from '../lib/agents.js';
import fs from 'node:fs/promises';
import path from 'node:path';

class Element {
  constructor(registry, document) { this.registry = registry; this.document = document; this.children = []; this.events = {}; this.nodes = new Map(); this.style = {}; this.value = ''; this.classList = { add() {}, remove() {} }; }
  set id(value) { this.elementId = value; this.registry?.set(value, this); }
  get id() { return this.elementId || ''; }
  focus() { if (this.document) this.document.activeElement = this; }
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
  const context = vm.createContext({ console, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, ...extra });
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
  assert.deepEqual(order, ['ready', 'fetch']);
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

test('a delete command only opens confirmation; cancel and scripted clicks never delete; trusted confirmation replaces the last session', async () => {
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
  assert.notEqual(canvasState(ui).activeId, id);
  assert.equal(ui.nodes.get('delete-session-dialog').open, false);
  const replacement = await store.get(canvasState(ui).activeId);
  assert.equal(replacement.snapshot.cards.length, 1);
  assert.ok(replacement.snapshot.cards[0].messages.every(message => message.localOnly));
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
  let root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'old question';
  const oldPending = root.querySelector('[data-action="send"]').events.click();
  calls[0].callbacks.onEvent({ type: 'text-delta', delta: 'old partial' });
  sessionCommand(ui, 'delete', id); await flush();
  // Opening a confirmation is not a cancellation or a persistence write.
  assert.equal(calls[0].callbacks.signal.aborted, false);
  await ui.nodes.get('btn-delete-confirm').events.click({ isTrusted: true });
  assert.equal(calls[0].callbacks.signal.aborted, true);
  root = ui.nodes.get('cards-layer').children[0];
  root.querySelector('#input-card-1').value = 'new question';
  const nextPending = root.querySelector('[data-action="send"]').events.click();
  calls[0].callbacks.onEvent({ type: 'text-delta', delta: 'LATE_DELETED' });
  calls[0].callbacks.onWaiting(); calls[0].callbacks.onCancelResult(false, 'LATE_CANCEL');
  calls[0].resolve({ text: 'LATE_DELETED' }); await oldPending;
  assert.doesNotMatch(ui.nodes.get('cards-layer').children[0].innerHTML, /old partial|LATE_DELETED|LATE_CANCEL/);
  calls[1].resolve({ text: 'new answer' }); await nextPending;
  assert.match(ui.nodes.get('cards-layer').children[0].innerHTML, /new answer/);
  const store = createForkSessionStore(hana, { locks: hosts.get(hana).locks });
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
    routes: { async register(register) { register({ get() {}, post(route, handler) { routes.set(route, handler); } }); } },
    models: { async cancel() {}, async stream() { modelCalls++; }, async *streamEvents() { modelCalls++; yield { type: 'text-delta', delta: 'ok' }; yield { type: 'done' }; } },
  });
  const module = await loadModule('../index.js', {
    './sdk/app-contract/server-client.js': { defineApp: setup => ({ apply: setup }) },
    './lib/agents.js': { createAgentDirectory },
    './lib/chat.js': await import('../lib/chat.js'),
    'node:fs/promises': { default: fs },
    'node:path': { default: path },
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

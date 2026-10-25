import assert from 'node:assert/strict';

export class FakeNode {
  constructor(tag = 'div', documentRef = null) {
    this.tagName = String(tag).toUpperCase();
    this.documentRef = documentRef;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.events = new Map();
    this.classList = new Set();
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.type = '';
    this.id = '';
    this._textContent = '';
    this._value = '';
    this.dataset = {};
  }

  get value() {
    if (this.tagName !== 'SELECT') return this._value ?? '';
    if (this._value && this.children.some(child => child.value === this._value)) return this._value;
    const selected = this.children.find(child => child.selected);
    return selected?.value ?? this.children[0]?.value ?? '';
  }

  set value(value) {
    this._value = String(value ?? '');
  }

  get textContent() {
    return `${this._textContent}${this.children.map(child => child.textContent).join('')}`;
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
    this.clearChildren();
  }

  get className() {
    return Array.from(this.classList).join(' ');
  }

  set className(value) {
    this.classList.clear();
    for (const token of String(value ?? '').trim().split(/\s+/)) {
      if (token) this.classList.add(token);
    }
  }

  get innerHTML() {
    return this._textContent;
  }

  set innerHTML(value) {
    this._textContent = String(value ?? '');
    this.clearChildren();
  }

  clearChildren() {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  setAttribute(key, value) {
    const stringValue = String(value);
    this.attributes.set(key, stringValue);
    if (key === 'id') this.id = stringValue;
    if (key.startsWith('data-')) {
      const prop = key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[prop] = stringValue;
    }
  }

  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }

  hasAttribute(key) {
    return this.attributes.has(key);
  }

  removeAttribute(key) {
    this.attributes.delete(key);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type, handler) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.events.get(type);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  dispatchEvent(event = {}) {
    if (!event.type) throw new TypeError('FakeNode.dispatchEvent 需要 event.type');
    if (event.target === undefined) event.target = this;
    if (event.currentTarget === undefined) event.currentTarget = this;
    for (const handler of [...(this.events.get(event.type) || [])]) handler(event);
    return true;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {
    if (this.documentRef) this.documentRef.activeElement = this;
  }
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.classList.has(selector.slice(1));
  if (selector.startsWith('[')) {
    const match = selector.match(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/);
    if (!match) return false;
    const [, attribute, expected] = match;
    if (expected === undefined) return node.hasAttribute(attribute);
    return node.getAttribute(attribute) === expected;
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

export function createFakeDocument() {
  const documentRef = {
    activeElement: null,
    createElement(tag) {
      return new FakeNode(tag, documentRef);
    },
    getElementById() {
      return null;
    },
  };
  documentRef.body = new FakeNode('body', documentRef);
  return documentRef;
}

export function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

export function deferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = value => {
      settled = true;
      resolve(value);
    };
    rejectPromise = error => {
      settled = true;
      reject(error);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    get settled() { return settled; },
  };
}

export async function waitFor(predicate, { timeoutMs = 1000, message = 'waitFor timeout' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

export function makeCards({ targetId = 'target', includeParent = true } = {}) {
  const cards = [];
  if (includeParent) {
    cards.push({
      id: 'root',
      parentId: null,
      title: '根节点',
      messages: [{ role: 'user', text: '根节点正文' }],
    });
  }
  cards.push({
    id: targetId,
    ...(includeParent ? { parentId: 'root' } : { parentId: null }),
    title: '目标节点',
    messages: [{ role: 'assistant', text: '目标节点正文' }],
  });
  return cards;
}

export function makeAction({
  actionId = `ha_${'a'.repeat(32)}`,
  state = 'prepared',
  canvasId = 'canvas-1',
  targetCardId = 'target',
  agentId = 'a1',
  sessionId = null,
  files = [],
  entryId = null,
  errorCode = null,
} = {}) {
  const now = '2026-10-25T00:00:00.000Z';
  return {
    actionId,
    state,
    source: { canvasId, revision: 1, targetCardId },
    agentId,
    payloadHash: 'b'.repeat(64),
    createdAt: now,
    updatedAt: now,
    expiresAt: '2026-10-25T01:00:00.000Z',
    bytes: 123,
    sessionId,
    files,
    entryId,
    errorCode,
    artifactCount: 0,
    artifactBytes: 0,
  };
}

export function makeControllerDeps({
  cards = makeCards(),
  snapshotAgentId = 'a1',
  agents = [{ id: 'a1', name: 'Agent 1' }],
  documentRef = createFakeDocument(),
  onRequest,
  isCardBusy = () => false,
  flashMessages = [],
  focus = async () => {},
  sessionState = {},
  savedSnapshot,
} = {}) {
  const state = {
    activeId: 'canvas-1',
    generation: 1,
    ready: true,
    busy: false,
    saving: false,
    dirty: false,
    error: '',
    ...sessionState,
  };
  const durableSnapshot = savedSnapshot || {
    id: state.activeId,
    revision: 1,
    snapshot: {
      cards,
      agent: { id: snapshotAgentId, name: 'Agent 1', provider: 'test', model: 'test-model' },
    },
  };
  const calls = [];
  const sessionController = {
    get state() { return state; },
    get generation() { return state.generation; },
    getSavedSnapshot: () => JSON.parse(JSON.stringify(durableSnapshot)),
    flush: async () => {},
  };
  const hana = {
    sessions: { focus },
    api: { fetch: async () => response({ ok: true }) },
  };
  const requestHost = async (hanaArg, path, init = {}) => {
    const call = { hana: hanaArg, path, init };
    calls.push(call);
    if (onRequest) {
      const result = await onRequest(path, init, call, { state, calls, agents, durableSnapshot });
      if (result !== undefined) return result;
    }
    if (path === '/api/agents') return response({ ok: true, agents });
    if (path === '/api/handoff/capabilities') {
      return response({
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
      });
    }
    if (path === '/api/handoff/actions') return response({ ok: true, actions: [] });
    if (path === '/api/handoff/prepare') {
      return response({ ok: true, action: makeAction({ canvasId: durableSnapshot.id, targetCardId: 'target', agentId: snapshotAgentId }) });
    }
    if (path === '/api/handoff/confirm') {
      const body = init.body ? JSON.parse(init.body) : {};
      return response({
        ok: true,
        action: makeAction({
          actionId: body.actionId,
          state: 'ready',
          canvasId: durableSnapshot.id,
          targetCardId: 'target',
          agentId: snapshotAgentId,
          sessionId: 'session-ready',
          entryId: 'entry-ready',
        }),
      });
    }
    if (path.startsWith('/api/handoff/actions/')) {
      return response({ ok: true, action: makeAction({ actionId: path.split('/').at(-1), state: 'ready', sessionId: 'session-ready', entryId: 'entry-ready' }) });
    }
    return response({ ok: true });
  };
  return {
    hana,
    requestHost,
    sessionController,
    getSessionController: () => sessionController,
    getCards: () => cards,
    isCardBusy,
    flashMessage: message => flashMessages.push(String(message)),
    safeDetail: error => String(error ?? ''),
    getIsDisposed: () => false,
    documentRef,
    cards,
    state,
    durableSnapshot,
    calls,
    flashMessages,
  };
}

export function artifactReceipt({ artifactId = 'a'.repeat(32), name = 'report.pdf', bytes = 17 } = {}) {
  return {
    artifactId,
    name,
    format: 'pdf',
    mime: 'application/pdf',
    bytes,
    sha256: 'c'.repeat(64),
    status: 'ready',
    createdAt: '2026-10-25T00:00:00.000Z',
  };
}

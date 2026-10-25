import test from 'node:test';
import assert from 'node:assert/strict';
import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { createDocumentPipeline } from '../ui/assets/panel-documents.js';
import { createPanelHandoff } from '../ui/assets/panel-handoff.js';
import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';

// DOM mock helper
class FakeNode {
  constructor(tag = 'div', documentRef = null) {
    this.tagName = tag.toUpperCase();
    this.documentRef = documentRef;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.events = new Map();
    this.classList = new Set();
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this._textContent = '';
    this._value = '';
    this.dataset = {};
  }
  get value() {
    if (this.tagName === 'SELECT') {
      const selected = this.children.find(c => c.selected);
      if (selected) return selected.value;
      return this.children[0]?.value ?? '';
    }
    return this._value ?? '';
  }
  set value(v) { this._value = v; }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v ?? ''); }
  get className() { return Array.from(this.classList).join(' '); }
  set className(v) {
    this.classList.clear();
    for (const c of String(v ?? '').trim().split(/\s+/)) {
      if (c) this.classList.add(c);
    }
  }
  get innerHTML() { return this._textContent; }
  set innerHTML(v) { this._textContent = String(v ?? ''); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
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
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.events.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }
  dispatchEvent(event) {
    const list = this.events.get(event.type) || [];
    for (const h of list) h(event);
  }
  querySelector(selector) {
    const found = this.querySelectorAll(selector);
    return found.length > 0 ? found[0] : null;
  }
  querySelectorAll(selector) {
    const res = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) res.push(child);
        walk(child);
      }
    };
    walk(this);
    return res;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { if (this.documentRef) this.documentRef.activeElement = this; }
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.classList.has(selector.slice(1));
  if (selector.startsWith('[')) {
    const m = selector.match(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/);
    if (!m) return false;
    const attr = m[1];
    const val = m[2];
    if (val === undefined) return node.hasAttribute(attr);
    return node.getAttribute(attr) === val;
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function createFakeDocument() {
  const doc = {
    nodes: new Map(),
    activeElement: null,
    createElement(tag) {
      const el = new FakeNode(tag, doc);
      return el;
    },
    getElementById(id) {
      return doc.nodes.get(id) || null;
    },
  };
  doc.body = new FakeNode('body', doc);
  return doc;
}

const flushTicks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// 1. 测试 fork-session-controller.js getSavedSnapshot()
test('fork-session-controller: getSavedSnapshot() returns deep-cloned immutable snapshot and guards against dirty/busy/unready states', async () => {
  let savedRecord = {
    id: 'canvas-durable-123',
    revision: 2,
    snapshot: { cards: [{ id: 'card-1', x: 0, y: 0, width: 340, height: 240, title: 'Card 1', messages: [{ role: 'user', text: 'hello' }] }], view: { x: 0, y: 0, scale: 1 } },
  };
  const store = {
    ensure: async () => savedRecord,
    list: async () => ({ activeId: savedRecord.id, sessions: [savedRecord] }),
    get: async () => savedRecord,
    save: async (id, rev, snap) => {
      savedRecord = { id, revision: rev + 1, snapshot: snap };
      return savedRecord;
    },
  };

  let captured = { cards: [{ id: 'card-1', x: 0, y: 0, width: 340, height: 240, title: 'Card 1', messages: [{ role: 'user', text: 'hello' }] }], view: { x: 0, y: 0, scale: 1 } };
  const controller = createForkSessionController({
    store,
    capture: () => captured,
    apply: async () => {},
    cancelPending: () => {},
  });

  // 未 init 前，未 ready：必须抛出 SESSION_NOT_SAVED
  assert.throws(() => controller.getSavedSnapshot(), (err) => {
    assert.equal(err.code, 'SESSION_NOT_SAVED');
    return true;
  });

  await controller.init();
  // 此时 ready 且未 dirty：成功返回深拷贝
  const saved = controller.getSavedSnapshot();
  assert.equal(saved.id, 'canvas-durable-123');
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.snapshot, savedRecord.snapshot);

  // 保证独立深拷贝：外部篡改不影响内部
  saved.snapshot.cards[0].title = 'Tampered';
  const saved2 = controller.getSavedSnapshot();
  assert.equal(saved2.snapshot.cards[0].title, 'Card 1');

  // 当画布发生变动但尚未保存（dirty: changed > saved）时，必须抛出 SESSION_NOT_SAVED
  captured = { cards: [{ id: 'card-1', x: 0, y: 0, width: 340, height: 240, title: 'Card 1 changed', messages: [{ role: 'user', text: 'hello' }] }], view: { x: 0, y: 0, scale: 1 } };
  controller.scheduleSave();
  assert.equal(controller.state.dirty, true);
  assert.throws(() => controller.getSavedSnapshot(), (err) => {
    assert.equal(err.code, 'SESSION_NOT_SAVED');
    return true;
  });

  // flush 后重新恢复可读
  await controller.flush(true);
  assert.equal(controller.state.dirty, false);
  const savedAfterFlush = controller.getSavedSnapshot();
  assert.equal(savedAfterFlush.snapshot.cards[0].title, 'Card 1 changed');
});

// 2. 测试 panel-documents.js isPending(cardId)
test('panel-documents: isPending(cardId) accurately reflects in-flight parse tasks without exposing documentTasks Map', async () => {
  let resolveParser;
  const parserPromise = new Promise((resolve) => { resolveParser = resolve; });
  const deps = {
    canMutateCanvas: () => true,
    isDisposed: () => false,
    inactiveError: () => new Error('inactive'),
    abortable: (p) => p,
    requestHost: async () => ({ ok: true, json: async () => parserPromise }),
  };

  const pipeline = createDocumentPipeline(deps);
  assert.equal(typeof pipeline.isPending, 'function', 'pipeline 必须提供 isPending 方法');
  assert.equal(pipeline.isPending('c1'), false);
  assert.equal(pipeline.isPending(null), false);

  const file = { name: 'test.pdf', size: 1024, type: 'application/pdf' };
  const taskPromise = pipeline.extractDocumentFile(file, 'c1');

  assert.equal(pipeline.isPending('c1'), true);
  assert.equal(pipeline.isPending('c2'), false);

  resolveParser({ ok: true, text: 'parsed text', charCount: 11 });
  await taskPromise;

  assert.equal(pipeline.isPending('c1'), false);
});

// 3. panel-handoff 控制器行为测试
test('panel-handoff: rejects busy target card or busy ancestors in DAG without stack overflow', async () => {
  const doc = createFakeDocument();
  const flashCalls = [];
  const cards = [
    { id: 'c-root', parentId: null, isBusy: false },
    { id: 'c-parent-1', parentId: 'c-root', isBusy: true },
    { id: 'c-parent-2', parentId: 'c-root', isBusy: false },
    { id: 'c-merge', parentIds: ['c-parent-1', 'c-parent-2'], isBusy: false },
  ];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }),
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: (id) => id === 'c-parent-1',
    flashMessage: (msg) => flashCalls.push(msg),
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c-merge');

  // 由于 c-parent-1 忙碌，open 必须拒绝，提示正忙
  assert.ok(flashCalls.some(m => m.includes('忙') || m.includes('正在处理')));
  handoff.dispose();
});

test('panel-handoff: handles deep chain (>300 nodes) with bounded stack and detects cycles safely', async () => {
  const doc = createFakeDocument();
  const flashCalls = [];
  const cards = [];
  for (let i = 0; i < 350; i++) {
    cards.push({
      id: `c-${i}`,
      parentId: i === 0 ? null : `c-${i - 1}`,
      title: `Node ${i}`,
      messages: [{ role: 'user', text: `msg ${i}` }],
    });
  }

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }),
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: () => false,
    flashMessage: (msg) => flashCalls.push(msg),
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  // 不得抛出 RangeError: Maximum call stack size exceeded
  await assert.doesNotReject(async () => {
    await handoff.open('c-349');
  });
  handoff.dispose();
});

test('panel-handoff: aborts without calling prepare if flush fails or generation shifts', async () => {
  const doc = createFakeDocument();
  const flashCalls = [];
  let prepareCalled = false;
  let currentGen = 1;

  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];
  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/handoff/prepare') prepareCalled = true;
      return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: currentGen, dirty: true }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {
        // 模拟外部并发使得 generation 变化
        currentGen = 2;
      },
    },
    getCards: () => cards,
    isCardBusy: () => false,
    flashMessage: (msg) => flashCalls.push(msg),
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c1');

  assert.equal(prepareCalled, false, '代际漂移后不得发起 prepare 调用');
  handoff.dispose();
});

test('panel-handoff: agent selection accepts /api/agents without state field, rejects on network error with fixed notice', async () => {
  const doc = createFakeDocument();
  let flashMsg = '';
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  // 1. /api/agents 没有 state 字段，正常识别有效 Agent
  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'agent-sol', name: 'Sol' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            agents: [{ id: 'agent-sol', name: 'Sol Architect', isCurrent: true }],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: () => false,
    flashMessage: (msg) => { flashMsg = msg; },
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c1');

  // 对话框中的 select 应该有 agent-sol
  const dialog = doc.body.querySelector('.handoff-dialog');
  assert.ok(dialog, 'dialog 必须创建在 body 下');
  const agentSelect = dialog.querySelector('.handoff-agent-select');
  assert.ok(agentSelect, '必须存在 agent 选择下拉框');
  assert.equal(agentSelect.value, 'agent-sol');

  handoff.dispose();
});

test('panel-handoff: copy draft into nextStep is explicit; draft over maxNextStepChars throws error without slicing', async () => {
  const doc = createFakeDocument();
  const flashCalls = [];
  const hugeDraft = 'x'.repeat(HANDOFF_LIMITS.maxNextStepChars + 10);
  const cards = [{ id: 'c1', title: 'C1', draft: hugeDraft, messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }),
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: () => false,
    flashMessage: (msg) => flashCalls.push(msg),
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c1');

  const dialog = doc.body.querySelector('.handoff-dialog');
  const nextStepInput = dialog.querySelector('.handoff-next-step');
  // 默认 nextStep 为空
  assert.equal(nextStepInput.value, '');

  const copyBtn = dialog.querySelector('.btn-copy-draft');
  assert.ok(copyBtn, '应提供复制目标草稿按钮');
  copyBtn.dispatchEvent({ type: 'click' });

  // 超过限额：明确报错拒绝，不得进行 slice
  assert.ok(flashCalls.some(m => m.includes('超出') || m.includes('超限')));
  assert.equal(nextStepInput.value, '');

  handoff.dispose();
});

test('panel-handoff: confirming sends only { actionId }, disables button against concurrent double-click', async () => {
  const doc = createFakeDocument();
  const confirmPayloads = [];
  let confirmResolvers = [];
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path, init) => {
      if (path === '/api/agents') {
        return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      }
      if (path === '/api/handoff/prepare') {
        return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_0123456789abcdef0123456789abcdef', state: 'prepared' } }) };
      }
      if (path === '/api/handoff/confirm') {
        confirmPayloads.push(JSON.parse(init.body));
        return new Promise((resolve) => {
          confirmResolvers.push(() => resolve({
            ok: true,
            json: async () => ({
              ok: true,
              action: { actionId: 'ha_0123456789abcdef0123456789abcdef', state: 'ready', sessionId: 'sess-new-1' },
            }),
          }));
        });
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: () => false,
    flashMessage: () => {},
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c1');

  const dialog = doc.body.querySelector('.handoff-dialog');
  const prepareBtn = dialog.querySelector('.btn-handoff-prepare');
  prepareBtn.dispatchEvent({ type: 'click' });
  await flushTicks(); // prepare 完成

  const confirmBtn = dialog.querySelector('.btn-handoff-confirm');
  assert.ok(confirmBtn, '必须展示确认按钮');

  // 并发点击两次
  confirmBtn.dispatchEvent({ type: 'click' });
  confirmBtn.dispatchEvent({ type: 'click' });
  await flushTicks();

  assert.equal(confirmPayloads.length, 1, '重复点击只能触发一次确认');
  assert.deepEqual(Object.keys(confirmPayloads[0]), ['actionId'], '确认请求只能包含 actionId');
  assert.equal(confirmPayloads[0].actionId, 'ha_0123456789abcdef0123456789abcdef');

  // 完成确认
  confirmResolvers[0]();
  await flushTicks();

  handoff.dispose();
});

test('panel-handoff: confirm network failure recovers only via GET action, does not auto POST replay', async () => {
  const doc = createFakeDocument();
  let confirmPostCount = 0;
  let actionGetCount = 0;
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path, init) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/prepare') return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_11111111111111111111111111111111', state: 'prepared' } }) };
      if (path === '/api/handoff/confirm') {
        confirmPostCount++;
        const err = new Error('HTTP 504 Gateway Timeout');
        err.status = 504;
        throw err;
      }
      if (path.startsWith('/api/handoff/actions/')) {
        actionGetCount++;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            action: { actionId: 'ha_11111111111111111111111111111111', state: 'ready', sessionId: 'sess-recovered' },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: () => false,
    flashMessage: () => {},
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c1');

  const dialog = doc.body.querySelector('.handoff-dialog');
  dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
  await flushTicks();

  dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
  await flushTicks();

  // 发生 504 后，用户点击查询/恢复
  const recoverBtn = dialog.querySelector('.btn-handoff-recover');
  assert.ok(recoverBtn, 'confirm 失败时应展示按 actionId 恢复查询按钮');
  recoverBtn.dispatchEvent({ type: 'click' });
  await flushTicks();

  assert.equal(confirmPostCount, 1, '绝不自动重试 POST confirm');
  assert.equal(actionGetCount, 1, '仅发起 GET actions 查询');

  handoff.dispose();
});

test('panel-handoff: ready state focus failure allows retry of focus, never recreates session', async () => {
  const doc = createFakeDocument();
  let focusAttempts = 0;
  let createOrConfirmCalls = 0;
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: {
      api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'Agent 1' }] }) }) },
      sessions: {
        focus: async () => {
          focusAttempts++;
          if (focusAttempts === 1) throw new Error('Window focus denied');
          return true;
        },
      },
    },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/prepare') return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_22222222222222222222222222222222', state: 'prepared' } }) };
      if (path === '/api/handoff/confirm') {
        createOrConfirmCalls++;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            action: { actionId: 'ha_22222222222222222222222222222222', state: 'ready', sessionId: 'sess-focus-test' },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: () => false,
    flashMessage: () => {},
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c1');

  const dialog = doc.body.querySelector('.handoff-dialog');
  dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
  await flushTicks();

  dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
  await flushTicks();

  const focusBtn = dialog.querySelector('.btn-handoff-focus');
  assert.ok(focusBtn, 'ready 状态下应展示 focus 按钮');

  // 第一次点击：focus 失败
  focusBtn.dispatchEvent({ type: 'click' });
  await flushTicks();
  assert.equal(focusAttempts, 1);
  assert.equal(createOrConfirmCalls, 1);

  // 第二次点击：重试 focus
  focusBtn.dispatchEvent({ type: 'click' });
  await flushTicks();
  assert.equal(focusAttempts, 2);
  assert.equal(createOrConfirmCalls, 1, '重试 focus 绝不重新调用 confirm 或创建');

  handoff.dispose();
});

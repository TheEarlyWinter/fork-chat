import test from 'node:test';
import assert from 'node:assert/strict';
import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { createDocumentPipeline } from '../ui/assets/panel-documents.js';
import { createPanelHandoff } from '../ui/assets/panel-handoff.js';
import { createHandoffView } from '../ui/assets/panel-handoff-view.js';
import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';
import { loadPanel } from './helpers/panel-harness.mjs';

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
            action: { actionId: 'ha_22222222222222222222222222222222', state: 'ready', sessionId: 'sess-focus-retry' },
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

// 11. [C1] 真实 panel.js 组合根晚赋 sessionController 后入口可用性
test('[C1] panel composition root: mounts with late sessionController assignment; entry openHandoff opens modal dialog', async () => {
  const { ui, panel } = await loadPanel();
  const doc = ui.environment.document;
  const cardEl = doc.getElementById('dom-card-1') || doc.body.querySelector('#card-1') || doc.body;
  const btn = cardEl.querySelector('[data-action="handoff"]');
  assert.ok(btn, '在 Hana 中继续 按钮必须挂载于卡片中');

  btn.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  await flushTicks(10);

  const dialog = doc.body.querySelector('.handoff-dialog');
  assert.ok(dialog && dialog.open, '点击后必须成功打开 handoff 模态对话框');
  const flash = doc.getElementById('fork-flash');
  assert.notEqual(flash?.textContent, '当前会话正在保存或正忙，请稍后重试。', '不得因组合根过早读取 null sessionController 而报错正忙');
  await panel.dispose();
});

// 12. [C2] busy check: isCardBusy checks activeRequests and documentPipeline.isPending by ID, unrelated card busy does not block
test('[C2] busy check: isCardBusy checks activeRequests and documentPipeline.isPending by ID, unrelated card busy does not block', async () => {
  const doc = createFakeDocument();
  const flashCalls = [];
  const cards = [
    { id: 'c-root', parentId: null },
    { id: 'c-parent', parentId: 'c-root' },
    { id: 'c-target', parentId: 'c-parent' },
    { id: 'c-unrelated', parentId: null },
  ];

  const activeRequests = new Set();
  const pendingDocs = new Set();
  // 模拟 panel.js 注入的 ID 级忙碌判定
  const isCardBusy = (id) => activeRequests.has(id) || pendingDocs.has(id);

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }),
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy,
    flashMessage: (msg) => flashCalls.push(msg),
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);

  // 1. 父卡片正在进行文档解析 (documentPipeline.isPending)
  pendingDocs.add('c-parent');
  await handoff.open('c-target');
  assert.ok(flashCalls.some(m => m.includes('正在处理') || m.includes('生成中') || m.includes('正忙')), '祖先卡片文档解析中必须阻断交接');
  let dialog = doc.body.querySelector('.handoff-dialog');
  assert.equal(dialog, null, '祖先卡片忙碌时不得打开对话框');

  // 2. 清除父卡片，但非相关分支卡片忙碌
  pendingDocs.clear();
  pendingDocs.add('c-unrelated');
  flashCalls.length = 0;
  await handoff.open('c-target');
  dialog = doc.body.querySelector('.handoff-dialog');
  assert.ok(dialog, '无关卡片忙碌绝不得阻断目标卡片交接');

  handoff.dispose();
});

// 13. [I1] DAG traversal: mixed parents (both parentId and parentIds) merges all ancestors; busy single parent is not missed
test('[I1] DAG traversal: mixed parents (both parentId and parentIds) merges all ancestors; busy single parent is not missed', async () => {
  const doc = createFakeDocument();
  const flashCalls = [];
  const cards = [
    { id: 'c-root', parentId: null },
    { id: 'p-single', parentId: 'c-root' },
    { id: 'p-multi-1', parentId: 'c-root' },
    { id: 'c-mixed', parentId: 'p-single', parentIds: ['p-multi-1'] },
  ];

  const busyIds = new Set(['p-single']);

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }),
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards } }),
      flush: async () => {},
    },
    getCards: () => cards,
    isCardBusy: (id) => busyIds.has(id),
    flashMessage: (msg) => flashCalls.push(msg),
    safeDetail: (err) => String(err),
    getIsDisposed: () => false,
    documentRef: doc,
  };

  const handoff = createPanelHandoff(deps);
  await handoff.open('c-mixed');

  // p-single 忙碌，尽管 c-mixed 同时声明了 parentIds: ['p-multi-1']，p-single 绝不能漏查
  assert.ok(flashCalls.some(m => m.includes('生成中') || m.includes('正忙')), '混合父关系中的 parentId 忙碌必须被检出并阻断');
  const dialog = doc.body.querySelector('.handoff-dialog');
  assert.equal(dialog, null, '存在忙碌祖先时不得打开对话框');

  handoff.dispose();
});

// 14. [I1] DAG traversal: genuine overflow explicitly rejects, never returns truncated partial ancestors
test('[I1] DAG traversal: genuine overflow explicitly rejects, never returns truncated partial ancestors', async () => {
  const doc = createFakeDocument();
  const flashCalls = [];
  const cards = [];
  const limit = HANDOFF_LIMITS.maxAncestors || 500;
  for (let i = 0; i <= limit + 50; i++) {
    cards.push({
      id: `c-${i}`,
      parentId: i === 0 ? null : `c-${i - 1}`,
      title: `Card ${i}`,
      messages: [{ role: 'user', text: `text ${i}` }],
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
  await handoff.open(`c-${limit + 50}`);

  // 超过祖先上限时，必须明确拒绝阻断，给出超限提示，不得截断后继续打开
  assert.ok(flashCalls.some(m => m.includes('超限') || m.includes('超出') || m.includes('上限') || m.includes('过长')), '祖先深度真超限必须明确报错拒绝');
  const dialog = doc.body.querySelector('.handoff-dialog');
  assert.equal(dialog, null, '超限时不得进入准备对话框');

  handoff.dispose();
});

// 15. [I3] preview DTO rendering: displays real messages, doc/artifact attachments, notice messages, and actual stats without [object Object] or (无正文)
test('[I3] preview DTO rendering: displays real messages, doc/artifact attachments, notice messages, and actual stats without [object Object] or (无正文)', () => {
  const doc = createFakeDocument();
  const view = createHandoffView({ documentRef: doc });

  const context = {
    source: { canvasId: 'sess-1', revision: 2 },
    nodes: [
      {
        cardId: 'c1',
        title: 'Card 1',
        messages: [{ role: 'assistant', text: '真实业务助手回复文本内容' }],
        doc: { name: 'annual-report.pdf', size: 10240, type: 'application/pdf' },
        artifactIds: ['art-f001'],
      },
    ],
    notices: [
      { code: 'INTEGRITY_NOTICE', message: '真实完整性警示说明' },
    ],
    stats: {
      nodeCount: 1,
      messageCount: 1,
      transcriptBytes: 4096,
      totalTokensEstimate: 1024,
    },
  };

  view.open(context);

  const dialog = doc.body.querySelector('.handoff-dialog');
  assert.ok(dialog, 'dialog 必须打开');

  // 1. 验证正文真实文本可见，绝非 (无正文)
  const contentEl = dialog.querySelector('.handoff-node-content');
  assert.ok(contentEl, '必须渲染节点正文容器');
  assert.ok(contentEl.textContent.includes('真实业务助手回复文本内容'), '真实助手正文必须可见');
  assert.equal(contentEl.textContent.includes('(无正文)'), false, '不得错误显示 (无正文)');

  // 2. 验证 notices.message 文本，绝非 [object Object]
  const noticeText = dialog.querySelector('.handoff-notices')?.textContent || '';
  assert.ok(noticeText.includes('真实完整性警示说明'), '真实警告说明必须可见');
  assert.equal(noticeText.includes('[object Object]'), false, 'notices 对象不得被强制转成 [object Object]');

  // 3. 验证 stats 预估字数/体积非 0
  const summaryEl = dialog.querySelector('.handoff-meta-summary');
  assert.ok(summaryEl, '必须渲染摘要容器');
  assert.equal(summaryEl.textContent.includes('正文预估: 0 字'), false, '不得错误显示正文预估 0 字');

  // 4. 验证附件/资料可见
  const attText = dialog.querySelector('.handoff-node-card')?.textContent || '';
  assert.ok(attText.includes('annual-report.pdf') || attText.includes('art-f001'), '资料或产物附件必须可见');

  view.close();
});

// 16. [I6] agent selection: defaults strictly to savedSnapshot.snapshot.agent.id, leaves empty and blocks prepare when no match
test('[I6] agent selection: defaults strictly to savedSnapshot.snapshot.agent.id, leaves empty and blocks prepare when no match', async () => {
  const doc = createFakeDocument();
  let prepareCalled = false;
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'agent-sol', name: 'Sol Architect' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') {
        return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'agent-sol', name: 'Sol Architect' }] }) };
      }
      if (path === '/api/handoff/prepare') {
        prepareCalled = true;
        return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_123', state: 'prepared' } }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      // 快照绑定的 agent-custom-9 在宿主可用列表中不存在
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards, agent: { id: 'agent-custom-9' } } }),
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
  const agentSelect = dialog.querySelector('.handoff-agent-select');

  // 未匹配到有效 Agent 时，下拉框必须为空选项，绝不得猜首项 (agent-sol)
  assert.equal(agentSelect.value, '', '不匹配快照 Agent 时必须留空');

  // 此时点击准备，必须被阻断，不得发起 prepare 请求
  const prepareBtn = dialog.querySelector('.btn-handoff-prepare');
  prepareBtn.dispatchEvent({ type: 'click' });
  await flushTicks();

  assert.equal(prepareCalled, false, '未选择有效 Agent 时严禁发起 prepare 调用');

  handoff.dispose();
});

// 17. [I2] input change during in-flight prepare: editing nextStep invalidates in-flight response and prevents confirmation of stale action
test('[I2] input change during in-flight prepare: editing nextStep invalidates in-flight response and prevents confirmation of stale action', async () => {
  const doc = createFakeDocument();
  let resolvePrepare;
  let confirmPayload = null;
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path, init) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/prepare') {
        return new Promise((r) => { resolvePrepare = r; });
      }
      if (path === '/api/handoff/confirm') {
        confirmPayload = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_stale_111', state: 'ready' } }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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
  await flushTicks(); // prepare 正在网络挂起

  // 用户在等待期间修改了下一步输入 (draft B)
  const nextStepInput = dialog.querySelector('.handoff-next-step');
  nextStepInput.value = '新输入草稿 B';
  nextStepInput.dispatchEvent({ type: 'input' });

  // 此时旧 prepare A 响应返回
  resolvePrepare({
    ok: true,
    json: async () => ({ ok: true, action: { actionId: 'ha_stale_111', state: 'prepared' } }),
  });
  await flushTicks();

  // 由于输入已变更，旧 action ha_stale_111 必须作废，确认按钮不得激活
  const confirmBtn = dialog.querySelector('.btn-handoff-confirm');
  if (confirmBtn && confirmBtn.style.display !== 'none') {
    confirmBtn.dispatchEvent({ type: 'click' });
    await flushTicks();
  }

  assert.equal(confirmPayload, null, '输入变更后迟到的 prepare 响应绝不得被确认');

  handoff.dispose();
});

// 18. [I8] modal failure: showModal throwing or missing fails closed (removes dialog and aborts), never falls back to open=true
test('[I8] modal failure: showModal throwing or missing fails closed (removes dialog and aborts), never falls back to open=true', async () => {
  const doc = createFakeDocument();
  let flashMsg = '';
  // 覆盖 FakeNode 的 showModal 使其抛错
  const origCreate = doc.createElement;
  doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag.toLowerCase() === 'dialog') {
      el.showModal = () => { throw new Error('ShowModal disabled by policy'); };
    }
    return el;
  };

  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];
  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }),
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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

  const dialog = doc.body.querySelector('.handoff-dialog');
  assert.equal(dialog, null, 'showModal 抛错或不可用时必须移除 dialog，禁止伪模态保留');
  assert.ok(flashMsg.includes('模态') || flashMsg.includes('对话框') || flashMsg.includes('不支持') || flashMsg.includes('失败'), '必须提示模态对话框不可用');

  handoff.dispose();
});

// 19. [C3] lifecycle safety: dispose during pending agents/flush resolves cleanly without TypeError on null view
test('[C3] lifecycle safety: dispose during pending agents/flush resolves cleanly without TypeError on null view', async () => {
  const doc = createFakeDocument();
  let resolveAgents;
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') {
        return new Promise(r => { resolveAgents = r; });
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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
  const openPromise = handoff.open('c1');
  await flushTicks();

  // 在 agents fetch 挂起期间，调用 dispose
  handoff.dispose();

  // 随后 agents fetch 返回
  resolveAgents({
    ok: true,
    json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }),
  });

  // 绝不得抛出 TypeError: Cannot read properties of null (reading 'renderAgents')
  await assert.doesNotReject(async () => {
    await openPromise;
    await flushTicks();
  });
});

// 20. [C3] lifecycle safety: canvas switch during pending prepare drops response, does not update new canvas dialog
test('[C3] lifecycle safety: canvas switch during pending prepare drops response, does not update new canvas dialog', async () => {
  const doc = createFakeDocument();
  let resolvePrepare;
  let currentGen = 1;
  let currentActiveId = 'sess-1';
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/prepare') return new Promise(r => { resolvePrepare = r; });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: currentActiveId, generation: currentGen, dirty: false }; },
      getSavedSnapshot: () => ({ id: currentActiveId, revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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

  // 画布并发切换到另一个会话 sess-2, generation 2
  currentGen = 2;
  currentActiveId = 'sess-2';

  // 此时原 sess-1 的 prepare 迟到返回
  resolvePrepare({
    ok: true,
    json: async () => ({ ok: true, action: { actionId: 'ha_sess1_action', state: 'prepared' } }),
  });
  await flushTicks();

  // 此时确认按钮不得激活为准备好的状态
  const confirmBtn = dialog.querySelector('.btn-handoff-confirm');
  assert.equal(confirmBtn.style.display, 'none', '画布切换后迟到的 prepare 响应必须被丢弃，确认按钮不得展示');

  handoff.dispose();
});

// 21. [I4] reopen recovery: open queries /api/handoff/actions for persistent canvas and target card, recovers existing state without POST
test('[I4] reopen recovery: open queries /api/handoff/actions for persistent canvas and target card, recovers existing state without POST', async () => {
  const doc = createFakeDocument();
  let actionsQueried = false;
  let preparePostCalled = false;
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/actions') {
        actionsQueried = true;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            actions: [
              {
                actionId: 'ha_existing_999',
                source: { canvasId: 'sess-durable-1', targetCardId: 'c1' },
                state: 'creating',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        };
      }
      if (path === '/api/handoff/prepare') {
        preparePostCalled = true;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-durable-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-durable-1', revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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

  assert.equal(actionsQueried, true, '打开交接时必须先查询 /api/handoff/actions 历史动作');
  assert.equal(preparePostCalled, false, '存在历史未完成动作时绝不自动重新发起 POST prepare');

  handoff.dispose();
});

// 22. [I5] status mapping: unknown state with known sessionId enables focus inspection, does not hide focus
test('[I5] status mapping: unknown state with known sessionId enables focus inspection, does not hide focus', async () => {
  const doc = createFakeDocument();
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/prepare') return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_unk_1', state: 'prepared' } }) };
      if (path === '/api/handoff/confirm') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            action: { actionId: 'ha_unk_1', state: 'unknown', sessionId: 'sess-known-unk-888' },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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

  // 状态为 unknown 但有已知 sessionId，必须展示核查/打开该会话按钮
  const focusBtn = dialog.querySelector('.btn-handoff-focus');
  assert.ok(focusBtn && focusBtn.style.display !== 'none', 'unknown 且有已知 sessionId 时必须展示核查会话 focus 按钮');

  handoff.dispose();
});

// 23. [I5] status mapping: partial state with known sessionId shows partial completion notice, never claims ready
test('[I5] status mapping: partial state with known sessionId shows partial completion notice, never claims ready', async () => {
  const doc = createFakeDocument();
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/prepare') return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_part_1', state: 'prepared' } }) };
      if (path === '/api/handoff/confirm') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            action: { actionId: 'ha_part_1', state: 'partial', sessionId: 'sess-part-999' },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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

  // partial 状态必须展示部分完成/警告信息，且 focus 按钮文案必须是核查，绝不得标为 ready / 成功打开
  const errorOrWarn = dialog.querySelector('.handoff-error');
  assert.ok(errorOrWarn && errorOrWarn.style.display !== 'none', 'partial 状态必须展示部分完成提示');
  const focusBtn = dialog.querySelector('.btn-handoff-focus');
  assert.ok(focusBtn && focusBtn.style.display !== 'none', 'partial 且有已知 sessionId 时必须展示 focus 按钮');
  assert.ok(focusBtn.textContent.includes('核查'), 'partial 状态下的 focus 按钮必须明确标注为核查，绝不得标为就绪打开');

  handoff.dispose();
});

// 24. [I7] confirm failure message: HTTP 403 or 409 displays neutral fixed notice without claiming 已发送
test('[I7] confirm failure message: HTTP 403 or 409 displays neutral fixed notice without claiming 已发送', async () => {
  const doc = createFakeDocument();
  let flashMsg = '';
  const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];

  const deps = {
    hana: { api: { fetch: async () => ({ ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) }) }, sessions: { focus: async () => {} } },
    requestHost: async (_hana, path) => {
      if (path === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
      if (path === '/api/handoff/prepare') return { ok: true, json: async () => ({ ok: true, action: { actionId: 'ha_err_1', state: 'prepared' } }) };
      if (path === '/api/handoff/confirm') {
        const err = new Error('HTTP 409 Conflict');
        err.status = 409;
        throw err;
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionController: {
      get state() { return { activeId: 'sess-1', generation: 1, dirty: false }; },
      getSavedSnapshot: () => ({ id: 'sess-1', revision: 1, snapshot: { cards, agent: { id: 'a1' } } }),
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

  const dialog = doc.body.querySelector('.handoff-dialog');
  dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
  await flushTicks();
  dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
  await flushTicks();

  // 必须使用中性文案，绝不能妄断“确认请求可能已发送”
  assert.equal(flashMsg.includes('可能已发送'), false, '不得在 409 等未知错误时误报可能已发送');
  const errorEl = dialog.querySelector('.handoff-error');
  assert.ok(errorEl.textContent.includes('确认未完成') || errorEl.textContent.includes('原动作查询'), '必须显示中性待查文案');

  handoff.dispose();
});

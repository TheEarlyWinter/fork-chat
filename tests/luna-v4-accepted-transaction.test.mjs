import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A7 acceptance-transaction tests.  This is additive: v3's 11 tests and its
// archived probes remain unchanged.  The root is switchable for baseline red
// evidence without touching the frozen copy.
const repoRoot = process.env.LUNA_PROD_ROOT
  || process.env.FORK_CHAT_PROD_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(path.join(repoRoot, 'ui/assets', name)).href);
const [policy, planModule, cardsModule, messagesModule, engineModule, eventsModule,
  rendererModule, previewModule, renderDiffModule] = await Promise.all([
  load('fork-context-policy.js'), load('panel-context-plan.js'), load('panel-cards.js'),
  load('panel-messages.js'), load('panel-chat-engine.js'), load('panel-card-events.js'),
  load('panel-renderer.js'), load('panel-context-preview.js'), load('panel-render-diff.js'),
]);
const { cardContentSignature, canReuseCardElement } = renderDiffModule;

const noop = () => {};
const cardOf = (id, extra = {}) => ({ id, title: id, x: 0, y: 0, width: 340, parentId: null, messages: [], ...extra });
const msg = (role, text, extra = {}) => ({ role, text, status: 'completed', ...extra });
const ticks = () => new Promise(resolve => setImmediate(resolve));
const fatal = (message, cause) => { const error = new Error(message); error.cause = cause; throw error; };

function makeNode(state = {}) {
  const node = {
    children: [], parentNode: null, style: {}, dataset: {}, hidden: false,
    value: '', id: '', className: '', action: '', textContent: '', listeners: new Map(),
    classList: {
      values: new Set(),
      add(...names) { names.forEach(name => this.values.add(name)); },
      remove(...names) { names.forEach(name => this.values.delete(name)); },
      contains(name) { return this.values.has(name); },
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; },
    remove() { this.parentNode?.removeChild?.(this); },
    addEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      list.push(handler);
      this.listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== handler));
    },
    focus() { state.document && (state.document.activeElement = this); },
    blur() { if (state.document?.activeElement === this) state.document.activeElement = null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains(target) {
      const walk = root => [root, ...root.children.flatMap(walk)];
      return walk(this).includes(target);
    },
  };
  let nodeValue = '';
  Object.defineProperty(node, 'value', {
    configurable: true,
    get: () => nodeValue,
    set: value => {
      node.valueWriteAttempts = (node.valueWriteAttempts || 0) + 1;
      if (node.failValueWrites || node.valueWriteHook?.(value, node.valueWriteAttempts)) {
        throw new Error('input value write failed');
      }
      nodeValue = String(value ?? '');
    },
  });
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
  const walk = root => [root, ...root.children.flatMap(walk)];
  const find = selector => {
    const all = walk(node);
    if (selector.startsWith('#')) return all.find(item => item.id === selector.slice(1)) || null;
    if (selector === '.card-input') return all.find(item => item.className === 'card-input') || null;
    const action = selector.match(/^\[data-action="([^"]+)"\]$/)?.[1];
    if (action) return all.find(item => item.action === action) || null;
    return null;
  };
  node.querySelector = find;
  node.querySelectorAll = selector => selector === '.card-input'
    ? walk(node).filter(item => item.className === 'card-input') : [];
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set(html) {
      node.children.forEach(child => { child.parentNode = null; });
      node.children = [];
      const text = String(html);
      const inputMatch = text.match(/<input[^>]*class="card-input"[^>]*id="([^"]+)"/);
      if (inputMatch) {
        const input = makeNode(state);
        input.id = inputMatch[1];
        input.className = 'card-input';
        node.appendChild(input);
      }
      const actions = [...text.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]);
      for (const action of new Set(actions)) {
        const button = makeNode(state);
        button.action = action;
        node.appendChild(button);
      }
    },
  });
  return node;
}

function makeDocument() {
  const state = {};
  const doc = makeNode(state);
  state.document = doc;
  doc.body = makeNode(state);
  doc.activeElement = null;
  doc.createElement = () => makeNode(state);
  doc.getElementById = id => {
    const walk = root => [root, ...root.children.flatMap(walk)];
    return walk(doc.body).find(item => item.id === id) || null;
  };
  return doc;
}

function makeProxyCard(id = 'target', extra = {}, throws = {}) {
  const raw = cardOf(id, extra);
  const calls = { set: new Map(), delete: new Map() };
  const shouldThrow = (kind, key, value) => {
    const map = calls[kind];
    const count = (map.get(key) || 0) + 1;
    map.set(key, count);
    const rule = throws[kind];
    if (rule instanceof Set && rule.has(key)) return true;
    if (typeof rule === 'function') return Boolean(rule({ key, value, count, calls }));
    return false;
  };
  return new Proxy(raw, {
    set(target, key, value, receiver) {
      if (shouldThrow('set', key, value)) throw new Error(`set ${String(key)} failed`);
      return Reflect.set(target, key, value, receiver);
    },
    deleteProperty(target, key) {
      if (shouldThrow('delete', key, undefined)) throw new Error(`delete ${String(key)} failed`);
      return Reflect.deleteProperty(target, key);
    },
  });
}

function makeRecoveryFactory() {
  let generation = 10;
  let cards = [];
  assert.equal(typeof eventsModule.createInputRecoveryBuffer, 'function',
    'A7 必须导出稳定 createInputRecoveryBuffer factory');
  const buffer = eventsModule.createInputRecoveryBuffer({
    getSession: () => ({ generation }),
    getCards: () => cards,
    maxCapacity: 2,
  });
  assert.ok(buffer && typeof buffer === 'object', 'factory 必须返回独立实例');
  assert.equal(typeof buffer.save, 'function', 'buffer 必须提供 save');
  assert.equal(typeof buffer.get, 'function', 'buffer 必须提供 get');
  assert.equal(typeof buffer.restore, 'function', 'buffer 必须提供 restore/applySnapshot');
  assert.equal(typeof buffer.clear, 'function', 'buffer 必须提供 clear');
  const size = () => buffer.size();
  assert.equal(typeof size(), 'number', 'buffer 必须提供可观察的有界 size');
  return {
    buffer,
    save: snapshot => buffer.save(snapshot),
    get: cardId => buffer.get(cardId),
    restore: (cardId, options) => buffer.restore(cardId, options),
    size,
    setGeneration: value => { generation = value; },
    setCards: value => { cards = value; },
  };
}

function makeSnapshot(card, generation, input, attachments = card.stagedAttachments) {
  return {
    cardId: card.id,
    generation,
    card,
    cardRef: card,
    input,
    inputValue: input.value,
    hasDraftProp: Object.prototype.hasOwnProperty.call(card, 'draft'),
    draft: card.draft,
    stagedAttachments: attachments,
    attachments,
  };
}

function makeRealHarness({
  card = cardOf('target', { draft: 'QUESTION', stagedAttachments: [{ name: 'a.txt', content: 'A' }] }),
  onPlan = noop,
  generationStart = 1,
  cardProxyThrows,
} = {}) {
  const documentRef = makeDocument();
  const cardsState = { value: [cardProxyThrows ? makeProxyCard(card.id, card, cardProxyThrows) : card] };
  const target = cardsState.value[0];
  const activeRequests = new Map();
  const cardCleanups = new Set();
  const notifications = [];
  let generation = generationStart;
  let currentUI = null;
  let renderer;
  let modelResolve;
  let modelCalls = 0;
  let modelStarted = false;
  let renderCount = 0;
  let planCalls = [];
  let planMutation = onPlan;

  const createPendingPlanPort = () => {
    const build = planModule.buildContextPlan;
    // Deliberately default the second parameter: function.length === 1.
    return function buildPlan(card, options = {}) {
      const cardsBefore = cardsState.value;
      assert.equal(cardsBefore.includes(card), true, 'plan port 首次参数必须是当前 live card');
      planCalls.push({ card, options });
      const plan = build({
        cards: cardsBefore,
        targetCard: card,
        pendingUserMessage: options.pendingUserMessage ?? options.pendingMessage,
      });
      planMutation({ card, options, harness });
      return plan;
    };
  };

  const modelPromise = new Promise(resolve => { modelResolve = resolve; });
  const engine = engineModule.createChatEngine({
    hana: {},
    runChat: async () => { modelCalls += 1; modelStarted = true; return modelPromise; },
    ChatError: class TestChatError extends Error {},
    safeDetail: value => String(value),
    activeRequests,
    getCards: () => cardsState.value,
    getSession: () => ({ generation }),
    getAgent: () => ({ id: 'a7-agent', name: 'A7 Agent' }),
    getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null,
    buildContextPlan: createPendingPlanPort(),
    reportContextIssue: issue => notifications.push(issue),
    flashMessage: issue => notifications.push(issue),
    getIsDisposed: () => false,
    canMutateCanvas: expected => expected === undefined || expected === generation,
    uniqueId: prefix => `${prefix}-a7`,
    paintMessage: noop,
    renderCards: () => { renderCount += 1; renderer.renderCards(); },
    scheduleSave: noop,
    cardParentIds: item => item.parentId ? [item.parentId] : [],
    documentRef,
  });

  const recoveryBuffer = eventsModule.createInputRecoveryBuffer({
    getSession: () => ({ generation }),
    getCards: () => cardsState.value,
    maxCapacity: 8,
  });
  const eventController = eventsModule.createCardEvents({
    listen(targetNode, type, handler, options, scope) {
      if (!targetNode?.addEventListener) return noop;
      targetNode.addEventListener(type, handler, options);
      const off = () => targetNode.removeEventListener?.(type, handler, options);
      scope?.add?.(off);
      return off;
    },
    getCardCleanups: () => cardCleanups,
    hana: {},
    flashMessage: issue => notifications.push(issue),
    safeDetail: value => String(value),
    getSession: () => ({ generation }),
    getGeneration: () => generation,
    getCards: () => cardsState.value,
    getIsDisposed: () => false,
    getIsSpacePressed: () => false,
    getSelectedCardId: () => target.id,
    getDocumentRef: () => documentRef,
    getNavigator: () => null,
    activeRequests,
    paintMessage: noop,
    ChatError: class TestChatError extends Error {},
    chainIsBusy: item => activeRequests.has(item.id),
    openBattleDialog: async () => {},
    documentUi: { attachFilesToCard: async () => {}, removeStagedAttachment: noop, hideDropIndicator: noop },
    cardGestures: { beginCardDrag: noop, bindResizeHandles: noop },
    createBranchCard: noop,
    closeCardHierarchy: noop,
    cycleCardStatusStamp: () => null,
    selectCard: noop,
    toggleMultiSelectCard: noop,
    clearMultiSelect: noop,
    renderCards: () => { renderCount += 1; renderer.renderCards(); },
    renderConnectors: noop,
    scheduleSave: noop,
    recordSnapshot: noop,
    canMutateCanvas: expected => expected === undefined || expected === generation,
    sendCardPrompt: (...args) => engine.sendCardPrompt(...args),
    cancelCardRequest: (...args) => engine.cancelCardRequest(...args),
    findCardAncestorChain: () => [],
    cardParentIds: () => [],
    formatCardChainMarkdown: () => '',
    buildTopologyOutline: () => '',
    openContextPreview: noop,
    openRefManager: noop,
    buildContextPreview: noop,
    changeCardContextMode: noop,
    reportContextIssue: issue => notifications.push(issue),
    recoveryBuffer,
  });

  const bind = (root, liveCard) => {
    const input = root.querySelector(`#input-${liveCard.id}`);
    const send = root.querySelector('[data-action="send"]');
    eventController.bindCardEvents(root, liveCard);
    currentUI = { root, input, send };
  };
  renderer = rendererModule.createRenderer({
    cardContentSignature,
    canReuseCardElement,
    documentRef,
    getCardsLayer: () => documentRef.body,
    getBadgeStats: () => null,
    getEmptyState: () => null,
    getIsDisposed: () => false,
    getCards: () => cardsState.value,
    getSelectedCardId: () => target.id,
    getCurrentAgent: () => ({}),
    getSession: () => ({ state: { ready: true, busy: false } }),
    getMultiSelectedCardIds: () => new Set(),
    activeRequests,
    chainIsBusy: item => activeRequests.has(item.id),
    drain: set => { for (const off of [...set]) off(); set.clear(); },
    getCardCleanups: () => cardCleanups,
    computeVisibleCards: () => ({ visibleCards: cardsState.value }),
    collectSubtreeCardIds: () => new Set(),
    cardParentIds: () => [],
    buildCardHtml: cardsModule.buildCardHtml,
    escapeHtml: value => String(value ?? ''),
    messageMarkup: messagesModule.messageMarkup,
    statusText: messagesModule.statusText,
    formatFileSize: value => `${value || 0} B`,
    bindCardEvents: bind,
    renderConnectors: noop,
  });

  const harness = {
    card: target,
    eventController,
    recoveryBuffer,
    cardsState,
    documentRef,
    activeRequests,
    notifications,
    get generation() { return generation; },
    set generation(value) { generation = value; },
    get currentUI() { return currentUI; },
    get renderer() { return renderer; },
    engine,
    planCalls,
    get modelCalls() { return modelCalls; },
    get modelStarted() { return modelStarted; },
    get renderCount() { return renderCount; },
    resolveModel(value = { text: 'ANSWER' }) { modelResolve(value); },
    setPlanMutation(fn) { planMutation = fn; },
    startSend() {
      renderer.renderCards();
      const oldUI = currentUI;
      const handler = oldUI.send.listeners.get('click')?.[0];
      assert.equal(typeof handler, 'function', '真实 send handler 必须存在');
      const promise = handler({ preventDefault: noop, stopPropagation: noop });
      return { oldUI, promise };
    },
  };
  return harness;
}

function attachPromiseError(promise) {
  let error = null;
  const settled = Promise.resolve(promise).catch(reason => { error = reason; return null; });
  return { settled, get error() { return error; } };
}

// --- strict plan invocation --------------------------------------------------

test('A7 engine: second-parameter default keeps arity=1 but still calls card+opts exactly once', async () => {
  const card = cardOf('strict-target');
  const cards = [card];
  const calls = [];
  const plan = {
    isRequestReady: true, messages: [{ role: 'user', content: 'QUESTION' }], errors: [],
  };
  const buildPlan = function buildPlan(targetCard, options = {}) {
    calls.push({ targetCard, options });
    assert.equal(targetCard, card);
    assert.equal(options.pendingUserMessage.text, 'QUESTION');
    return plan;
  };
  assert.equal(buildPlan.length, 1, 'fixture 必须保留默认第二参数 arity=1');
  const engine = engineModule.createChatEngine({
    hana: {}, runChat: async () => ({ text: 'ANSWER' }), ChatError: class extends Error {}, safeDetail: String,
    activeRequests: new Map(), getCards: () => cards, getSession: () => ({ generation: 1 }),
    getAgent: () => ({ id: 'agent' }), getReasoningEffort: () => null, getAgentReasoningEffort: () => null,
    buildContextPlan: buildPlan, reportContextIssue: noop, flashMessage: noop,
    getIsDisposed: () => false, canMutateCanvas: () => true, uniqueId: p => `${p}-strict`,
    paintMessage: noop, renderCards: noop, scheduleSave: noop, cardParentIds: () => [],
    documentRef: { getElementById: () => null },
  });
  assert.equal(await engine.sendCardPrompt(card, 'QUESTION'), true);
  assert.equal(calls.length, 1, 'arity=1 不得触发旧对象式调用或 fallback 二次调用');
  assert.equal(calls[0].targetCard, card);
  assert.equal(calls[0].options.pendingUserMessage.text, 'QUESTION');
});

// --- real renderer + engine + events ----------------------------------------

test('A7 real composition: normal acceptance clears before model and preserves attachment identity rules', async () => {
  const originalAttachments = [{ name: 'a.txt', content: 'A' }];
  const h = makeRealHarness({ card: cardOf('normal', { draft: 'QUESTION', stagedAttachments: originalAttachments }) });
  const { oldUI, promise } = h.startSend();
  const sendState = attachPromiseError(promise);
  await ticks();

  assert.equal(h.modelCalls, 1);
  assert.equal(h.planCalls.length, 1);
  assert.equal(h.planCalls[0].card, h.card);
  assert.equal(h.planCalls[0].options.pendingUserMessage.text, 'QUESTION');
  assert.equal(h.currentUI.input.value, '', 'model 开始前 live input 必须已清');
  assert.equal(Object.hasOwn(h.card, 'draft'), false, 'model 开始前 draft own-property 必须已清');
  assert.notStrictEqual(h.card.stagedAttachments, originalAttachments, '清理必须替换附件数组');
  assert.deepEqual(originalAttachments, [{ name: 'a.txt', content: 'A' }], '原附件数组和成员不得被破坏');
  assert.equal(Object.isFrozen(h.card.messages[0]), true, 'accepted user DTO 必须冻结');
  assert.equal(oldUI.input.value, '', '旧 DOM 也必须清理');

  h.resolveModel();
  await sendState.settled;
  assert.equal(sendState.error, null);
  assert.equal(h.currentUI.input.value, '', '模型完成后的重绘不得恢复旧问题');
  assert.equal(Object.hasOwn(h.card, 'draft'), false);
});

const mutationCases = [
  {
    name: 'new input and draft edit',
    mutate: h => { h.currentUI.input.value = 'NEW_EDIT'; h.card.draft = 'NEW_EDIT'; },
    assertState: h => {
      assert.equal(h.currentUI.input.value, 'NEW_EDIT');
      assert.equal(h.card.draft, 'NEW_EDIT');
    },
  },
  {
    name: 'push into original attachment array',
    mutate: h => { h.card.stagedAttachments.push({ name: 'new.txt', content: 'NEW' }); },
    assertState: h => {
      assert.equal(h.card.stagedAttachments.length, 2);
      assert.equal(h.card.stagedAttachments[1].name, 'new.txt');
    },
  },
  {
    name: 'replace a member inside original attachment array',
    mutate: h => { h.card.stagedAttachments[0] = { name: 'edited.txt', content: 'EDITED' }; },
    assertState: h => {
      assert.equal(h.card.stagedAttachments[0].name, 'edited.txt');
      assert.equal(h.card.stagedAttachments[0].content, 'EDITED');
    },
  },
  {
    name: 'draft own-property change',
    mutate: h => { delete h.card.draft; h.currentUI.input.value = ''; },
    assertState: h => {
      assert.equal(Object.hasOwn(h.card, 'draft'), false);
      assert.equal(h.currentUI.input.value, '');
    },
  },
  {
    name: 'new generation',
    mutate: h => { h.generation = 2; },
    assertState: h => {
      assert.equal(h.generation, 2);
      assert.equal(h.currentUI.input.value, 'QUESTION');
      assert.equal(h.card.draft, 'QUESTION');
    },
  },
  {
    name: 'same ID but new card object',
    mutate: h => {
      const replacement = cardOf(h.card.id, { draft: 'NEW_CARD_DRAFT', stagedAttachments: [{ name: 'new-card.txt' }] });
      h.cardsState.value = [replacement];
    },
    assertState: h => {
      const replacement = h.cardsState.value[0];
      assert.notStrictEqual(replacement, h.card);
      assert.equal(replacement.draft, 'NEW_CARD_DRAFT');
      assert.equal(replacement.stagedAttachments[0].name, 'new-card.txt');
    },
  },
  {
    name: 'current mounted DOM replaced before acceptance',
    mutate: h => {
      h.renderer.renderCards();
      h.currentUI.input.value = 'NEW_DOM_EDIT';
      h.card.draft = 'NEW_DOM_EDIT';
    },
    assertState: h => {
      assert.equal(h.currentUI.input.value, 'NEW_DOM_EDIT');
      assert.equal(h.card.draft, 'NEW_DOM_EDIT');
    },
  },
];

for (const scenario of mutationCases) {
  test(`A7 real composition: accepted pre-image rejects ${scenario.name}`, async () => {
    const h = makeRealHarness({ onPlan: ({ harness }) => scenario.mutate(harness) });
    const { promise } = h.startSend();
    const sendState = attachPromiseError(promise);
    await ticks();
    await ticks();
    assert.equal(h.modelCalls, 1);
    scenario.assertState(h);
    h.resolveModel();
    await sendState.settled;
    assert.equal(sendState.error, null);
    scenario.assertState(h);
  });
}

// --- cleanup exception transactions ------------------------------------------

test('A7 real composition: attachment cleanup exception is isolated without masking accepted request', async () => {
  const originalAttachments = [{ name: 'a.txt', content: 'A' }];
  const h = makeRealHarness({
    card: cardOf('attachment-error', { draft: 'ORIGINAL', stagedAttachments: originalAttachments }),
    cardProxyThrows: { set: ({ key, count }) => key === 'stagedAttachments' && count === 1 },
  });
  const { promise } = h.startSend();
  const sendState = attachPromiseError(promise);
  await ticks();
  assert.equal(h.modelCalls, 1);
  assert.strictEqual(h.card.stagedAttachments, originalAttachments);
  assert.strictEqual(h.card.stagedAttachments[0], originalAttachments[0]);
  h.resolveModel();
  await sendState.settled;
  assert.equal(sendState.error, null);
  assert.equal(h.modelCalls, 1);
  assert.ok(h.notifications.length >= 1, '附件清理异常必须报告');
});

test('A7 real composition: input cleanup exception restores replaced attachment array and members, then preserves new edit', async () => {
  const originalAttachments = [{ name: 'a.txt', content: 'A' }];
  const h = makeRealHarness({
    card: cardOf('input-error', { draft: 'ORIGINAL', stagedAttachments: originalAttachments }),
    cardProxyThrows: { set: ({ key, count }) => key === 'stagedAttachments' && count === 2 },
    onPlan: ({ harness }) => { harness.currentUI.input.valueWriteHook = value => value === ''; },
  });
  const { promise } = h.startSend();
  const sendState = attachPromiseError(promise);
  await ticks();
  assert.equal(h.modelCalls, 1);
  assert.ok(h.recoveryBuffer.get('input-error'), '真实 cardEvents 实例必须保存恢复副本');
  // The user edits after acceptance while the model is still deferred.
  h.currentUI.input.value = 'USER_EDIT_AFTER_ACCEPT';
  h.card.draft = 'USER_EDIT_AFTER_ACCEPT';
  h.resolveModel();
  await sendState.settled;
  assert.equal(sendState.error, null);
  assert.equal(h.currentUI.input.value, 'USER_EDIT_AFTER_ACCEPT', '完成后不得 blind restore 旧输入');
  assert.equal(h.card.draft, 'USER_EDIT_AFTER_ACCEPT');

  // New edit blocks restore; then a clean empty state permits exact restoration.
  assert.equal(h.recoveryBuffer.restore('input-error', {
    targetCard: h.card, inputEl: h.currentUI.input, generation: h.generation,
  }), false);
  h.currentUI.input.value = '';
  delete h.card.draft;
  h.card.stagedAttachments = [];
  assert.equal(h.recoveryBuffer.restore('input-error', {
    targetCard: h.card, inputEl: h.currentUI.input, generation: h.generation,
  }), true);
  assert.strictEqual(h.card.stagedAttachments, originalAttachments);
  assert.strictEqual(h.card.stagedAttachments[0], originalAttachments[0]);
  assert.equal(typeof h.eventController.dispose, 'function', '真实 cardEvents 必须提供 dispose 清缓冲入口');
  h.recoveryBuffer.save({
    cardId: h.card.id, cardRef: h.card, generation: h.generation,
    inputValue: 'BUFFER', draft: 'BUFFER', hasDraftProp: true, stagedAttachments: originalAttachments,
  });
  assert.equal(h.recoveryBuffer.size(), 1);
  h.eventController.dispose();
  assert.equal(h.recoveryBuffer.size(), 0, 'cardEvents dispose 必须清空实例缓冲');
});

test('A7 real composition: draft cleanup exception independently restores prior input/attachments', async () => {
  const originalAttachments = [{ name: 'a.txt', content: 'A' }];
  const h = makeRealHarness({
    card: cardOf('draft-error', { draft: 'ORIGINAL', stagedAttachments: originalAttachments }),
    cardProxyThrows: { delete: new Set(['draft']) },
  });
  const { promise } = h.startSend();
  const sendState = attachPromiseError(promise);
  await ticks();
  assert.equal(h.modelCalls, 1);
  assert.equal(h.currentUI.input.value, 'ORIGINAL', 'draft 异常时 input 必须独立恢复');
  assert.equal(h.card.draft, 'ORIGINAL', 'draft 异常时 draft 必须保持原值');
  assert.strictEqual(h.card.stagedAttachments, originalAttachments);
  assert.strictEqual(h.card.stagedAttachments[0], originalAttachments[0]);
  h.currentUI.input.value = 'USER_EDIT_AFTER_ACCEPT';
  h.card.draft = 'USER_EDIT_AFTER_ACCEPT';
  h.resolveModel();
  await sendState.settled;
  assert.equal(sendState.error, null);
  assert.equal(h.currentUI.input.value, 'USER_EDIT_AFTER_ACCEPT');
  assert.equal(h.card.draft, 'USER_EDIT_AFTER_ACCEPT');
  assert.equal(h.modelCalls, 1);
});

// --- recovery buffer factory/lifecycle --------------------------------------

test('A7 recovery buffer: identity/generation/new-edit negatives, positive restore, cap, isolation and second exception', () => {
  const makeEntry = (id = 'buffer-card') => {
    const attachments = [{ name: `${id}.txt`, content: id }];
    const card = cardOf(id, { draft: `DRAFT-${id}`, stagedAttachments: attachments });
    const input = { value: `INPUT-${id}` };
    return { card, input, attachments };
  };

  // Identity negative: entry exists and is observable before replacing the live object.
  const identity = makeRecoveryFactory();
  const identityEntry = makeEntry();
  identity.setCards([identityEntry.card]);
  identity.save(makeSnapshot(identityEntry.card, 10, identityEntry.input, identityEntry.attachments));
  assert.ok(identity.get('buffer-card'), 'identity negative 前必须确认 entry 存在');
  const replacement = cardOf('buffer-card', { draft: 'NEW_CARD' });
  identity.setCards([replacement]);
  assert.equal(identity.restore('buffer-card', { targetCard: replacement, inputEl: identityEntry.input, generation: 10 }), false,
    '同 ID 新卡必须因 cardRef 不同而拒绝');
  identity.setCards([identityEntry.card]);
  identityEntry.input.value = '';
  delete identityEntry.card.draft;
  identityEntry.card.stagedAttachments = [];
  assert.equal(identity.restore('buffer-card', { targetCard: identityEntry.card, inputEl: identityEntry.input, generation: 10 }), true,
    '同 ID 新卡负控后，重新回到原活对象必须仍可正向恢复');

  // Generation negative: use a fresh instance so rejection is not an eviction no-op.
  const generation = makeRecoveryFactory();
  const generationEntry = makeEntry('generation-card');
  generation.setCards([generationEntry.card]);
  generation.save(makeSnapshot(generationEntry.card, 10, generationEntry.input, generationEntry.attachments));
  assert.ok(generation.get('generation-card'), 'generation negative 前必须确认 entry 存在');
  generation.setGeneration(11);
  assert.equal(generation.restore('generation-card', { targetCard: generationEntry.card, inputEl: generationEntry.input, generation: 11 }), false,
    'generation 变化必须拒绝旧副本');
  generation.setGeneration(10);
  generation.save(makeSnapshot(generationEntry.card, 10, generationEntry.input, generationEntry.attachments));
  generationEntry.input.value = '';
  delete generationEntry.card.draft;
  generationEntry.card.stagedAttachments = [];
  assert.equal(generation.restore('generation-card', { targetCard: generationEntry.card, inputEl: generationEntry.input, generation: 10 }), true,
    'generation 负控后重新 capture 的同代副本必须可正向恢复');

  // New edit negative: a valid live card/input with changed state must not be overwritten.
  const edited = makeRecoveryFactory();
  const editedEntry = makeEntry('edited-card');
  edited.setCards([editedEntry.card]);
  edited.save(makeSnapshot(editedEntry.card, 10, editedEntry.input, editedEntry.attachments));
  assert.ok(edited.get('edited-card'));
  editedEntry.input.value = 'USER_EDIT';
  editedEntry.card.draft = 'USER_EDIT';
  editedEntry.card.stagedAttachments = [{ name: 'new.txt', content: 'NEW' }];
  assert.equal(edited.restore('edited-card', { targetCard: editedEntry.card, inputEl: editedEntry.input, generation: 10 }), false);
  assert.equal(editedEntry.input.value, 'USER_EDIT');
  assert.equal(editedEntry.card.draft, 'USER_EDIT');
  assert.equal(editedEntry.card.stagedAttachments[0].name, 'new.txt');

  // Positive restore: same live card + generation + empty current state; preserve exact array/member identity.
  const positive = makeRecoveryFactory();
  const positiveEntry = makeEntry('positive-card');
  positive.setCards([positiveEntry.card]);
  positive.save(makeSnapshot(positiveEntry.card, 10, positiveEntry.input, positiveEntry.attachments));
  assert.ok(positive.get('positive-card'));
  positiveEntry.input.value = '';
  delete positiveEntry.card.draft;
  positiveEntry.card.stagedAttachments = [];
  assert.equal(positive.restore('positive-card', { targetCard: positiveEntry.card, inputEl: positiveEntry.input, generation: 10 }), true);
  assert.equal(positiveEntry.card.draft, 'DRAFT-positive-card');
  assert.strictEqual(positiveEntry.card.stagedAttachments, positiveEntry.attachments);
  assert.strictEqual(positiveEntry.card.stagedAttachments[0], positiveEntry.attachments[0]);
  assert.equal(positiveEntry.input.value, 'INPUT-positive-card');

  // Capacity and instance isolation: A is observable before eviction; another factory cannot see it.
  const capped = makeRecoveryFactory();
  const capA = makeEntry('cap-a'), capB = makeEntry('cap-b'), capC = makeEntry('cap-c');
  capped.setCards([capA.card, capB.card, capC.card]);
  capped.save(makeSnapshot(capA.card, 10, capA.input, capA.attachments));
  capped.save(makeSnapshot(capB.card, 10, capB.input, capB.attachments));
  assert.ok(capped.get('cap-a'));
  capped.save(makeSnapshot(capC.card, 10, capC.input, capC.attachments));
  assert.equal(capped.size(), 2);
  assert.equal(capped.get('cap-a'), null, '超容量后 A 必须确实被逐出');
  const isolated = makeRecoveryFactory();
  isolated.setCards([capB.card]);
  assert.equal(isolated.get('cap-b'), null, '不同 factory 实例不可见');

  // Restore second exception: same live card/input/generation, setter is actually attempted.
  const exceptional = makeRecoveryFactory();
  const exceptionalEntry = makeEntry('exceptional-card');
  let inputAttempts = 0;
  const throwingInput = {
    _value: 'INPUT-exceptional-card',
    get value() { return this._value; },
    set value(value) { inputAttempts += 1; if (inputAttempts === 1) throw new Error('restore input failed'); this._value = value; },
  };
  exceptional.setCards([exceptionalEntry.card]);
  exceptional.save(makeSnapshot(exceptionalEntry.card, 10, throwingInput, exceptionalEntry.attachments));
  assert.ok(exceptional.get('exceptional-card'));
  throwingInput._value = '';
  delete exceptionalEntry.card.draft;
  exceptionalEntry.card.stagedAttachments = [];
  assert.equal(exceptional.restore('exceptional-card', { targetCard: exceptionalEntry.card, inputEl: throwingInput, generation: 10 }), false);
  assert.ok(inputAttempts > 0, '恢复异常负控必须实际命中 input setter');
  assert.ok(exceptional.get('exceptional-card'), '部分恢复失败不得静默消费副本');
  delete exceptionalEntry.card.draft;
  exceptionalEntry.card.stagedAttachments = [];
  throwingInput._value = '';
  assert.equal(exceptional.restore('exceptional-card', { targetCard: exceptionalEntry.card, inputEl: throwingInput, generation: 10 }), true);

  positive.buffer.clear();
  assert.equal(positive.size(), 0, 'clear 必须清空实例');
  assert.equal(typeof positive.buffer.dispose, 'function', '实例必须提供 dispose 清理入口');
  positive.save(makeSnapshot(positiveEntry.card, 10, positiveEntry.input, positiveEntry.attachments));
  positive.buffer.dispose();
  assert.equal(positive.size(), 0, 'dispose 必须清空实例');
});

// --- root preview wiring and ordinary redraw --------------------------------

test('A7 root preview: real generation wiring is static, ordinary redraw preserves preview', () => {
  const panelSource = fs.readFileSync(path.join(repoRoot, 'ui/assets/panel.js'), 'utf8');
  const previewInit = panelSource.match(/const contextPreview = createContextPreview\(\{[\s\S]{0,1400}?\n\}\);/);
  assert.ok(previewInit, 'panel.js 必须存在可审计的 contextPreview 接线');
  assert.match(previewInit[0], /getGeneration\s*:/, 'root preview 必须注入真实 generation');
  const reset = panelSource.match(/function resetTransientUI\(\)[\s\S]{0,500}?\n\}/);
  assert.ok(reset, 'panel.js 必须存在 resetTransientUI');
  assert.doesNotMatch(reset[0], /contextPreview\??\.close/, '普通 renderer redraw 不得通过 resetTransientUI 关闭 preview');
  const cardEventsInit = panelSource.match(/const cardEvents = createCardEvents\([\s\S]{0,2600}?\n\}\);/);
  assert.ok(cardEventsInit, 'root 必须存在可审计的 cardEvents 接线');
  assert.match(cardEventsInit[0], /recoveryBuffer|createInputRecoveryBuffer/, 'root 必须接入实例级恢复缓冲');
  assert.match(panelSource, /cardEvents\.(?:dispose|clear)|recoverableBuffer\.(?:dispose|clear)/,
    'applySnapshot/dispose 必须清理 cardEvents 恢复缓冲');

  const documentRef = makeDocument();
  const target = cardOf('preview-target', { draft: 'PREVIEW_QUESTION' });
  const cards = [target];
  let generation = 3;
  const preview = previewModule.createContextPreview({
    getDocument: () => documentRef,
    getCards: () => cards,
    getGeneration: () => generation,
    reportIssue: noop,
  });
  assert.ok(preview.show(target));
  assert.equal(preview.isOpen(), true);
  const renderer = rendererModule.createRenderer({
    cardContentSignature,
    canReuseCardElement,
    documentRef,
    getCardsLayer: () => documentRef.body,
    getBadgeStats: () => null,
    getEmptyState: () => null,
    getIsDisposed: () => false,
    getCards: () => cards,
    getSelectedCardId: () => target.id,
    getCurrentAgent: () => ({}),
    getSession: () => ({ state: { ready: true, busy: false } }),
    getMultiSelectedCardIds: () => new Set(),
    activeRequests: new Map(),
    chainIsBusy: () => false,
    drain: noop,
    getCardCleanups: () => new Set(),
    computeVisibleCards: () => ({ visibleCards: cards }),
    collectSubtreeCardIds: () => new Set(),
    cardParentIds: () => [],
    buildCardHtml: cardsModule.buildCardHtml,
    escapeHtml: value => String(value ?? ''),
    messageMarkup: messagesModule.messageMarkup,
    statusText: messagesModule.statusText,
    formatFileSize: value => `${value || 0} B`,
    bindCardEvents: noop,
    renderConnectors: noop,
    onBeforeRender: noop,
    onAfterRender: () => preview.refresh(),
  });
  renderer.renderCards();
  assert.equal(preview.isOpen(), true, '同 generation/card 的普通重绘必须保留 preview');
  generation = 4;
  preview.refresh();
  assert.equal(preview.isOpen(), false, 'generation 变化才应关闭 preview');
});

// --- context extra probes ----------------------------------------------------

const contextPending = { role: 'user', text: 'QUESTION' };
const contextCard = (id, extra = {}) => cardOf(id, { messages: [], ...extra });
const contextRef = (id, text = 'QUOTE') => ({ id, sourceCardId: 'source', sourceTitle: 'source', text });
function contextReady(input) {
  const plan = planModule.buildContextPlan({ ...input, pendingUserMessage: contextPending, pendingMessage: contextPending });
  assert.equal(plan.errors.length, 0, '合法正控不能被无关错误遮蔽');
  assert.equal(plan.isRequestReady, true);
  return plan;
}
function contextRejected(input, code) {
  const plan = planModule.buildContextPlan({ ...input, pendingUserMessage: contextPending, pendingMessage: contextPending });
  assert.ok(plan.errors.length > 0, '非法输入必须产生结构化错误');
  if (code) assert.ok(plan.errors.some(error => error.code === code), `必须包含 ${code}`);
  assert.equal(plan.isRequestReady, false);
  assert.deepEqual(plan.messages, []);
  return plan;
}

test('A7 context C01: explicit target outside cards still validates policy and refs', () => {
  const target = contextCard('outside-target');
  contextReady({ cards: [], targetCard: target });
  contextRejected({ cards: [], targetCard: { ...target, contextMode: 'INVALID' } }, 'INVALID_CONTEXT_POLICY');
  contextRejected({ cards: [], targetCard: { ...target, contextRefs: [{ id: 'bad' }] } }, 'INVALID_CONTEXT_REFERENCE');
});

test('A7 context C02: cross-card same ref ID with different immutable content is rejected', () => {
  const first = contextCard('first', { contextRefs: [contextRef('same-id', 'FIRST')] });
  const second = contextCard('second', { parentId: 'first', contextRefs: [contextRef('other-id', 'SECOND')] });
  contextReady({ cards: [first, second], targetCard: second });
  const conflict = { ...second, contextRefs: [contextRef('same-id', 'DIFFERENT')] };
  contextRejected({ cards: [first, conflict], targetCard: conflict });
});

test('A7 context C03: Infinity override cannot bypass the hard 64KiB reference prefix cap', () => {
  const small = contextCard('small', {
    contextRefs: Array.from({ length: 4 }, (_, index) => contextRef(`small-${index}`, `${index}-${'x'.repeat(8100)}`)),
  });
  contextReady({ cards: [small], targetCard: small, maxReferenceBytes: Infinity });
  const large = { ...small, contextRefs: Array.from({ length: 10 }, (_, index) => contextRef(`large-${index}`, `${index}-${'x'.repeat(8100)}`)) };
  contextRejected({ cards: [large], targetCard: large, maxReferenceBytes: Infinity }, 'CONTEXT_REFERENCE_PREFIX_TOO_LARGE');
});

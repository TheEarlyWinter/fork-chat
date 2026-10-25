import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Luna v3 tests deliberately import the production root dynamically.  Sol can
// run the same file against the immutable pre-repair tree with:
//   LUNA_PROD_ROOT=/absolute/path/to/baseline node --test tests/luna-v3-contract-regressions.test.mjs
const repoRoot = process.env.LUNA_PROD_ROOT
  || process.env.FORK_CHAT_PROD_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Do not append a query suffix: panel-context.js re-exports the same plan module through its normal URL.
// A cache-busting suffix here would create a second ESM instance and turn identity checks into a harness false positive.
const load = name => import(pathToFileURL(path.join(repoRoot, 'ui/assets', name)).href);

const [policy, planModule, contextModule, cardsModule, selectionModule, popoverModule,
  engineModule, eventsModule, rendererModule, messagesModule, refsModule, historyModule,
  historyControllerModule, previewModule, renderDiffModule] = await Promise.all([
  load('fork-context-policy.js'),
  load('panel-context-plan.js'),
  load('panel-context.js'),
  load('panel-cards.js'),
  load('panel-selection.js'),
  load('panel-selection-popover.js'),
  load('panel-chat-engine.js'),
  load('panel-card-events.js'),
  load('panel-renderer.js'),
  load('panel-messages.js'),
  load('panel-refs.js'),
  load('panel-history.js'),
  load('panel-history-controller.js'),
  load('panel-context-preview.js'),
  load('panel-render-diff.js')]);
const { cardContentSignature, canReuseCardElement } = renderDiffModule;

const noop = () => {};
const msg = (role, text, extra = {}) => ({ role, text, status: 'completed', ...extra });
const makeCard = (id, extra = {}) => ({
  id, title: id, x: 0, y: 0, width: 340, parentId: null, messages: [], ...extra,
});
const rawRef = (id, sourceCardId, text, extra = {}) => ({
  id, sourceCardId, sourceTitle: sourceCardId, text, ...extra,
});
const normalizedRef = (id, sourceCardId, text, ownerCardId = null) =>
  policy.normalizeContextRefs([rawRef(id, sourceCardId, text)], { ownerCardId })[0];

function assertExport(ns, name) {
  assert.equal(typeof ns[name], 'function', `${name} 必须由生产模块导出`);
  return ns[name];
}

function selectionDocument(text = 'ORIGINAL_QUOTE', requestId = 'message-1') {
  const root = { id: 'dom-source', parentNode: null };
  const row = { parentNode: root };
  const bubble = {
    nodeType: 1,
    id: `reply-${requestId}`,
    parentNode: row,
    querySelector: () => null,
    closest: selector => selector === '.msg-bubble'
      ? bubble
      : selector === '.msg-row.msg-asst' ? row : null,
  };
  const range = {
    startContainer: bubble,
    endContainer: bubble,
    commonAncestorContainer: bubble,
    getBoundingClientRect: () => ({ top: 100, left: 100, width: 20 }),
  };
  const makeElement = () => {
    const node = {
      children: [], parentNode: null, style: {}, dataset: {}, hidden: false, value: '',
      className: '', type: '', textContent: '', listeners: new Map(), classList: {
        add: noop, remove: noop, contains: () => false,
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
      focus: noop,
      blur: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
    return node;
  };
  const doc = Object.assign(makeElement(), {
    body: makeElement(),
    createElement: makeElement,
    activeElement: null,
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => text,
      removeAllRanges: noop,
    }),
  });
  return { doc, bubble };
}

function selectionDeps({ doc, cards, generation = () => 1, overrides = {} } = {}) {
  return {
    getDocument: () => doc,
    getCards: () => cards,
    createBranchCard: () => ({}),
    getGeneration: generation,
    getIsDisposed: () => false,
    canMutateCanvas: () => true,
    chainIsBusy: () => false,
    listen(target, type, handler, options, scope) {
      if (!target?.addEventListener) return noop;
      target.addEventListener(type, handler, options);
      const cleanup = () => target.removeEventListener?.(type, handler, options);
      scope?.add?.(cleanup);
      return cleanup;
    },
    reportIssue: noop,
    ...overrides,
  };
}

function makePlanPort(cards, calls = []) {
  const build = assertExport(planModule, 'buildContextPlan');
  // Keep two declared parameters so a legacy object-shaped call cannot pass a
  // length-based compatibility branch unnoticed.
  return function strictBuildContextPlan(targetCard, options) {
    // This is intentionally strict: the engine port must be the new
    // buildContextPlan(card, { pendingUserMessage }) contract, not the old
    // object-shaped legacy call.
    assert.ok(targetCard && cards.includes(targetCard), 'engine 必须把当前 live card 传给编译端口');
    const pendingUserMessage = options?.pendingUserMessage ?? options?.pendingMessage;
    calls.push({ targetCard, pendingUserMessage });
    return build({ cards, targetCard, pendingUserMessage });
  };
}

function makeEngineDeps({ cards, buildContextPlan, runChat = async () => ({ text: 'ANSWER' }),
  activeRequests = new Map(), generation = 1, reportContextIssue = noop } = {}) {
  return {
    hana: {},
    runChat,
    ChatError: class TestChatError extends Error {},
    safeDetail: value => String(value),
    activeRequests,
    getCards: () => cards,
    getSession: () => ({ generation }),
    getAgent: () => ({ id: 'synthetic-agent', name: 'Synthetic Agent' }),
    getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null,
    buildContextPlan,
    reportContextIssue,
    // Compatibility port is present only so a missing/new required-port test
    // isolates the reportContextIssue contract instead of failing elsewhere.
    flashMessage: noop,
    getIsDisposed: () => false,
    canMutateCanvas: () => true,
    uniqueId: prefix => `${prefix}-luna-v3`,
    paintMessage: noop,
    renderCards: noop,
    scheduleSave: noop,
    cardParentIds: card => card.parentId ? [card.parentId] : [],
    documentRef: { getElementById: () => null },
  };
}

function makeHistoryCard(id, refValue) {
  return makeCard(id, {
    contextRefs: refValue ? policy.normalizeContextRefs([refValue], { ownerCardId: id }) : undefined,
  });
}

// --- Interface migration and pending contract --------------------------------

test('Luna v3: engine requires reportContextIssue and selection requires lifecycle ports', () => {
  const card = makeCard('target');
  const planCalls = [];
  const engineFactory = assertExport(engineModule, 'createChatEngine');
  const engineDeps = makeEngineDeps({ cards: [card], buildContextPlan: makePlanPort([card], planCalls) });
  const withoutReport = { ...engineDeps };
  delete withoutReport.reportContextIssue;
  assert.throws(() => engineFactory(withoutReport), TypeError, '缺 reportContextIssue 必须在工厂边界失败');

  const { doc } = selectionDocument();
  const selectionFactory = assertExport(popoverModule, 'createSelectionBranchController');
  for (const key of ['getGeneration', 'getIsDisposed', 'canMutateCanvas', 'chainIsBusy', 'listen']) {
    const deps = selectionDeps({ doc, cards: [card] });
    delete deps[key];
    assert.throws(
      () => selectionFactory(deps),
      TypeError,
      `缺 ${key} 必须在 selection 工厂边界失败`,
    );
  }
});

test('Luna v3: pending helper is shared by context and plan modules', () => {
  const fromPlan = assertExport(planModule, 'createPendingUserMessage');
  const fromContext = assertExport(contextModule, 'createPendingUserMessage');
  assert.strictEqual(fromPlan, fromContext, 'panel-context 必须 re-export 同一个 pending helper');

  const attachments = [{ name: 'a.txt', content: '正文' }];
  const pending = fromPlan('  新问题  ', attachments);
  assert.deepEqual(pending, {
    role: 'user',
    text: '新问题',
    attachments,
  });
  assert.notStrictEqual(pending.attachments, attachments, 'pending 只能复制附件数组本身');
  assert.equal(fromPlan('  ', []), null);
  assert.equal(fromPlan('', undefined), null);
});

test('Luna v3: no pending is a legal historical projection, never a ready request', () => {
  const build = assertExport(planModule, 'buildContextPlan');
  const source = makeCard('source', { messages: [msg('assistant', 'SOURCE_BODY')] });
  const target = makeCard('target', {
    messages: [msg('user', 'OLD_QUESTION'), msg('assistant', 'OLD_ANSWER')],
    contextRefs: [normalizedRef('r1', 'source', 'QUOTE', 'target')],
  });
  const plan = build({ cards: [source, target], targetCard: target });
  assert.equal(plan.errors.length, 0, '无 pending 本身不是 fatal error');
  assert.equal(plan.isRequestReady, false);
  assert.match(plan.messages.map(item => item.content).join('\n'), /OLD_QUESTION/);
  assert.ok(!plan.messages.some(item => item.content.includes('QUOTE')));
  assert.ok(Array.isArray(plan.sources));
  assert.ok(plan.stats && typeof plan.stats.wireBytes === 'number');
});

test('Luna v3: invalid policy, ref DTO and per-card limit are fatal with empty messages', () => {
  const build = assertExport(planModule, 'buildContextPlan');
  const pending = { role: 'user', text: 'CURRENT_QUESTION', status: 'completed' };

  const invalidPolicy = makeCard('policy-target', { contextMode: 'bogus' });
  const policyPlan = build({ cards: [invalidPolicy], targetCard: invalidPolicy, pendingUserMessage: pending });
  assert.ok(policyPlan.errors.some(error => error.code === 'INVALID_CONTEXT_POLICY'));
  assert.deepEqual(policyPlan.messages, []);
  assert.equal(policyPlan.isRequestReady, false);

  const invalidRef = makeCard('ref-target', {
    contextRefs: [{ text: 'MALFORMED_WITHOUT_ID' }],
  });
  const refPlan = build({ cards: [invalidRef], targetCard: invalidRef, pendingUserMessage: pending });
  assert.ok(refPlan.errors.some(error => error.code === 'INVALID_CONTEXT_REFERENCE'));
  assert.deepEqual(refPlan.messages, []);
  assert.equal(refPlan.isRequestReady, false);

  const tooMany = makeCard('limit-target', {
    contextRefs: Array.from({ length: policy.MAX_REFS_PER_CARD + 1 }, (_, index) =>
      rawRef(`r${index}`, 'source', `QUOTE_${index}`)),
  });
  const limitPlan = build({ cards: [tooMany], targetCard: tooMany, pendingUserMessage: pending });
  assert.ok(limitPlan.errors.some(error => error.code === 'CONTEXT_REFERENCE_LIMIT_EXCEEDED'));
  assert.deepEqual(limitPlan.messages, []);
  assert.equal(limitPlan.isRequestReady, false);
});

// --- Actual engine acceptance boundary ---------------------------------------

test('Luna v3: engine uses the new plan port once and freezes generation meta', async () => {
  const card = makeCard('target');
  const cards = [card];
  const planCalls = [];
  const engineFactory = assertExport(engineModule, 'createChatEngine');
  const engine = engineFactory(makeEngineDeps({
    cards,
    generation: 7,
    buildContextPlan: makePlanPort(cards, planCalls),
  }));
  const accepted = [];
  let reentrant;
  const result = await engine.sendCardPrompt(card, 'FIRST', {
    onAccepted(meta) {
      accepted.push(meta);
      reentrant = engine.sendCardPrompt(card, 'REENTRANT');
    },
  });

  assert.equal(result, true);
  assert.equal(planCalls.length, 1, '一次发送只能同步编译一次');
  assert.equal(accepted.length, 1);
  assert.deepEqual(Object.keys(accepted[0]).sort(), ['cardId', 'generation', 'requestId']);
  assert.equal(accepted[0].generation, 7);
  assert.ok(Object.isFrozen(accepted[0]), 'onAccepted meta 必须冻结');
  assert.equal(await reentrant, false, 'onAccepted 不得重入第二次发送');
  assert.ok(Object.isFrozen(card.messages[0]), '已接受的 user DTO 必须冻结');
});

test('Luna v3: onAccepted/reportContextIssue failures do not reject an accepted request', async () => {
  const card = makeCard('target');
  const cards = [card];
  const planCalls = [];
  let modelCalls = 0;
  const engine = assertExport(engineModule, 'createChatEngine')(makeEngineDeps({
    cards,
    buildContextPlan: makePlanPort(cards, planCalls),
    reportContextIssue: () => { throw new Error('notification failed'); },
    runChat: async () => { modelCalls += 1; return { text: 'ANSWER' }; },
  }));

  await assert.doesNotReject(() => engine.sendCardPrompt(card, 'QUESTION', {
    onAccepted: () => { throw new Error('cleanup failed'); },
  }));
  assert.equal(modelCalls, 1, '接受后 hook 失败不能重发或取消已接受请求');
  assert.equal(planCalls.length, 1);
});

// --- Real renderer + engine + card-events composition ------------------------

function parsedDomElement() {
  const node = {
    children: [], parentNode: null, style: {}, dataset: {}, hidden: false, value: '',
    className: '', action: '', id: '', textContent: '', listeners: new Map(),
    classList: { values: new Set(), add(...names) { names.forEach(name => this.values.add(name)); }, remove(...names) { names.forEach(name => this.values.delete(name)); }, contains(name) { return this.values.has(name); } },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; },
    remove() { this.parentNode?.removeChild?.(this); },
    addEventListener(type, handler) { const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list); },
    removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== handler)); },
    focus: noop,
    blur: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
  const walk = root => [root, ...root.children.flatMap(walk)];
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set(html) {
      for (const child of node.children) child.parentNode = null;
      node.children = [];
      const inputMatch = String(html).match(/<input[^>]*class="card-input"[^>]*id="([^"]+)"/);
      if (inputMatch) {
        const input = parsedDomElement();
        input.id = inputMatch[1];
        input.className = 'card-input';
        node.appendChild(input);
      }
      if (String(html).includes('data-action="send"')) {
        const send = parsedDomElement();
        send.action = 'send';
        node.appendChild(send);
      }
    },
  });
  node.querySelector = selector => {
    const nodes = walk(node);
    if (selector.startsWith('#')) return nodes.find(item => item.id === selector.slice(1)) || null;
    if (selector === '[data-action="send"]') return nodes.find(item => item.action === 'send') || null;
    return null;
  };
  node.querySelectorAll = selector => selector === '.card-input'
    ? walk(node).filter(item => item.className === 'card-input')
    : [];
  return node;
}

function rendererCompositionHarness() {
  const target = makeCard('target', {
    draft: 'UNSENT_QUESTION',
    stagedAttachments: [{ name: 'a.txt', content: 'ATTACHMENT' }],
  });
  const cards = [target];
  const activeRequests = new Map();
  const layer = parsedDomElement();
  const doc = {
    activeElement: null,
    createElement: () => parsedDomElement(),
    getElementById: id => {
      const walk = root => [root, ...root.children.flatMap(walk)];
      return walk(layer).find(item => item.id === id) || null;
    },
  };
  let liveUI;
  let renderer;
  let resolveModel;
  let modelCalls = 0;
  const modelPromise = new Promise(resolve => { resolveModel = resolve; });
  const planCalls = [];
  const planPort = makePlanPort(cards, planCalls);
  const engine = assertExport(engineModule, 'createChatEngine')(makeEngineDeps({
    cards,
    activeRequests,
    buildContextPlan: planPort,
    renderCards: () => renderer.renderCards(),
    runChat: async () => { modelCalls += 1; return modelPromise; },
  }));
  const cleanups = new Set();
  const bindCardEvents = assertExport(eventsModule, 'createCardEvents');
  const bind = (root, card) => {
    const input = root.querySelector(`#input-${card.id}`);
    const send = root.querySelector('[data-action="send"]');
    const listen = (target, type, handler, options, scope) => {
      if (!target?.addEventListener) return noop;
      target.addEventListener(type, handler, options);
      const off = () => target.removeEventListener?.(type, handler, options);
      scope?.add?.(off);
      return off;
    };
    const controller = bindCardEvents({
      listen,
      getCardCleanups: () => cleanups,
      hana: {},
      flashMessage: noop,
      safeDetail: value => String(value),
      getSession: () => ({ generation: 1 }),
      getGeneration: () => 1,
      getCards: () => cards,
      getIsDisposed: () => false,
      getIsSpacePressed: () => false,
      getSelectedCardId: () => card.id,
      getDocumentRef: () => doc,
      getNavigator: () => null,
      activeRequests,
      paintMessage: noop,
      ChatError: class extends Error {},
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
      renderCards: () => renderer.renderCards(),
      renderConnectors: noop,
      scheduleSave: noop,
      recordSnapshot: noop,
      canMutateCanvas: () => true,
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
      reportContextIssue: noop,
    });
    controller.bindCardEvents(root, card);
    liveUI = { input, send };
  };
  renderer = assertExport(rendererModule, 'createRenderer')({
    cardContentSignature,
    canReuseCardElement,
    documentRef: doc,
    getCardsLayer: () => layer,
    getBadgeStats: () => null,
    getEmptyState: () => null,
    getIsDisposed: () => false,
    getCards: () => cards,
    getSelectedCardId: () => target.id,
    getCurrentAgent: () => ({}),
    getSession: () => ({ state: { ready: true, busy: false } }),
    getMultiSelectedCardIds: () => new Set(),
    activeRequests,
    chainIsBusy: item => activeRequests.has(item.id),
    drain(set) { for (const off of [...set]) off(); set.clear(); },
    getCardCleanups: () => cleanups,
    computeVisibleCards: () => ({ visibleCards: cards }),
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
  return { target, cards, renderer, layer, oldUI: () => liveUI, resolveModel, modelCalls: () => modelCalls, planCalls };
}

test('Luna v3: accepted cleanup clears the live renderer input before completion and keeps it clear after completion', async () => {
  const h = rendererCompositionHarness();
  h.renderer.renderCards();
  const oldUI = h.oldUI();
  assert.equal(oldUI.input.value, 'UNSENT_QUESTION');

  const pending = oldUI.send.listeners.get('click')[0]({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.modelCalls(), 1);
  assert.equal(h.oldUI().input.value, '', '接受边界后当前 live input 必须已清空');
  assert.equal(h.target.draft, undefined, '接受边界后 draft 必须已清空');
  assert.equal(h.target.stagedAttachments?.length || 0, 0);

  h.resolveModel({ text: 'ANSWER' });
  await pending;
  assert.equal(h.oldUI().input.value, '', '模型完成后的 preserve 重绘不得写回旧问题');
  assert.equal(h.target.draft, undefined);
  assert.equal(h.planCalls.length, 1);
});

// --- Selection lifecycle and actual-history retention ------------------------

test('Luna v3: selection candidate invalidates on message change, deletion, empty source, same ID and generation', () => {
  const controllerFactory = assertExport(popoverModule, 'createSelectionBranchController');
  let generation = 1;
  let cards = [makeCard('source', { messages: [msg('assistant', 'ORIGINAL_QUOTE', { requestId: 'message-1' })] })];
  const created = [];
  const first = selectionDocument();
  const controller = controllerFactory(selectionDeps({
    doc: first.doc,
    cards,
    generation: () => generation,
    overrides: { createBranchCard: (source, options) => { created.push({ source, options }); return {}; } },
  }));
  controller.inspect();
  assert.ok(controller.getPending(), '合法 completed 消息必须先产生候选');

  cards[0].messages[0].text = 'REPLACED_BODY';
  controller.commit();
  assert.equal(created.length, 0, '正文变化后旧候选必须失效');

  cards = [makeCard('source', { messages: [msg('assistant', 'ORIGINAL_QUOTE', { requestId: 'message-1' })] })];
  const deleted = selectionDocument();
  const deletedController = controllerFactory(selectionDeps({
    doc: deleted.doc,
    cards,
    overrides: {
      getCards: () => cards,
      createBranchCard: (source, options) => { created.push({ source, options }); return {}; },
    },
  }));
  deletedController.inspect();
  cards[0].messages = [];
  deletedController.commit();
  assert.equal(created.length, 0, '消息删除后旧候选必须失效');

  const emptyCards = [makeCard('source')];
  const empty = selectionDocument();
  const emptyController = controllerFactory(selectionDeps({ doc: empty.doc, cards: emptyCards }));
  emptyController.inspect();
  assert.equal(emptyController.getPending(), null, '无真实消息不能构造候选');

  cards = [makeCard('source', { messages: [msg('assistant', 'ORIGINAL_QUOTE', { requestId: 'message-1' })] })];
  const sameId = selectionDocument();
  const sameIdController = controllerFactory(selectionDeps({
    doc: sameId.doc,
    cards,
    overrides: {
      getCards: () => cards,
      createBranchCard: (source, options) => { created.push({ source, options }); return {}; },
    },
  }));
  sameIdController.inspect();
  cards = [makeCard('source', { messages: [msg('assistant', 'ORIGINAL_QUOTE', { requestId: 'message-1' })] })];
  sameIdController.commit();
  assert.equal(created.length, 0, '同 ID 新对象不能接受旧候选');

  cards = [makeCard('source', { messages: [msg('assistant', 'ORIGINAL_QUOTE', { requestId: 'message-1' })] })];
  const generationDoc = selectionDocument();
  const generationController = controllerFactory(selectionDeps({
    doc: generationDoc.doc,
    cards,
    generation: () => generation,
    overrides: { createBranchCard: (source, options) => { created.push({ source, options }); return {}; } },
  }));
  generationController.inspect();
  generation = 2;
  generationController.commit();
  assert.equal(created.length, 0, '代际变化不能接受旧候选');
});

test('Luna v3: source exclude and busy state block reference writes', () => {
  const controllerFactory = assertExport(popoverModule, 'createSelectionBranchController');
  const source = makeCard('source', {
    messages: [msg('assistant', 'ORIGINAL_QUOTE', { requestId: 'message-1' })],
    contextMode: 'exclude',
  });
  const owner = makeCard('owner');
  const cards = [source, owner];
  const { doc } = selectionDocument();
  let additions = 0;
  const controller = controllerFactory(selectionDeps({
    doc,
    cards,
    overrides: {
      getSelectedCardId: () => owner.id,
      addContextRef: () => { additions += 1; return { ok: true }; },
    },
  }));
  controller.inspect();
  controller.commitReference(owner.id);
  assert.equal(additions, 0, 'exclude 来源不能写入引用');

  const busyDoc = selectionDocument();
  let busyAdds = 0;
  const busyController = controllerFactory(selectionDeps({
    doc: busyDoc.doc,
    cards: [makeCard('source', { messages: [msg('assistant', 'ORIGINAL_QUOTE', { requestId: 'message-1' })] }), owner],
    overrides: {
      chainIsBusy: () => true,
      getSelectedCardId: () => owner.id,
      addContextRef: () => { busyAdds += 1; return { ok: true }; },
    },
  }));
  busyController.inspect();
  busyController.commitReference(owner.id);
  assert.equal(busyAdds, 0, '忙碌路径不能写引用');
});

test('Luna v3: history-only refs are counted once, cached, cleared, and archive IDs are merged', () => {
  const managerFactory = assertExport(historyModule, 'createHistoryManager');
  const controllerFactory = assertExport(historyControllerModule, 'createHistoryController');
  const refValue = normalizedRef('r-history', 'source', 'HISTORY_ONLY_TEXT', 'owner');
  const old = makeHistoryCard('owner', refValue);
  const manager = managerFactory();
  manager.recordSnapshot([old]);
  manager.syncCards([makeCard('owner')]);
  const first = manager.getRetainedReferenceIds();
  assert.ok(first.has('r-history'), 'sync 后引用必须来自 history-only 状态');
  assert.ok(manager.getStats().retainedBytes > 0, 'history-only ref 必须计入额外预算');
  first.delete('r-history');
  assert.ok(manager.getRetainedReferenceIds().has('r-history'), 'getter 必须返回隔离 Set');

  const archive = new Map([['archived', makeHistoryCard('archived', normalizedRef('r-archive', 'source', 'ARCHIVE_TEXT', 'archived'))]]);
  const cards = [makeCard('live')];
  const controller = controllerFactory({
    getCards: () => cards,
    setCards: () => {},
    setSelectedCardId: () => {},
    renderCards: noop,
    renderConnectors: noop,
    scheduleSave: noop,
    getRemovedCardArchive: () => archive,
  });
  assert.ok(controller.getRetainedReferenceIds().has('r-archive'), 'controller 必须显式合并 archive refs');

  let textReads = 0;
  const countedRef = {
    get id() { return 'r-counted'; },
    sourceCardId: 'source',
    get sourceTitle() { return 'source'; },
    get text() { textReads += 1; return 'COUNTED_UTF8_中文'; },
  };
  const cacheManager = managerFactory();
  cacheManager.recordSnapshot([makeCard('counted', { contextRefs: [countedRef] })]);
  cacheManager.syncCards([makeCard('counted')]);
  const firstEstimateReads = textReads;
  cacheManager.syncCards([makeCard('counted')]);
  assert.equal(textReads, firstEstimateReads, '同一 ref 的逻辑字节必须命中缓存');
  cacheManager.clear();
  cacheManager.recordSnapshot([makeCard('counted', { contextRefs: [countedRef] })]);
  cacheManager.syncCards([makeCard('counted')]);
  assert.ok(textReads > firstEstimateReads, 'clear 后再次可达必须重新估算');

  const conflictManager = managerFactory();
  conflictManager.recordSnapshot([makeHistoryCard('conflict', normalizedRef('same-id', 'source', 'A', 'conflict'))]);
  assert.throws(
    () => conflictManager.recordSnapshot([makeHistoryCard('conflict', normalizedRef('same-id', 'source', 'B', 'conflict'))]),
    /reference id|引用|INVALID/i,
    '同 ID 异正文不得跨历史状态静默共存',
  );

  const mutableRef = { id: 'mutable', sourceCardId: 'source', sourceTitle: 'source', text: 'MUTABLE' };
  const mutableCard = makeCard('mutable-owner', { contextRefs: [mutableRef] });
  let mutableCards = [mutableCard];
  const mutableHistory = controllerFactory({
    getCards: () => mutableCards,
    setCards: next => { mutableCards = next; },
    setSelectedCardId: noop,
    renderCards: noop,
    renderConnectors: noop,
    scheduleSave: noop,
    removedCardArchive: new Map(),
  });
  mutableHistory.recordSnapshot(mutableCards);
  mutableCards = [makeCard('mutable-owner')];
  mutableHistory.recordSnapshot(mutableCards);
  assert.equal(mutableHistory.undo(), true);
  const restoredMutable = mutableCards[0].contextRefs[0];
  assert.ok(Object.isFrozen(restoredMutable), '历史快照应冻结复制后的 ref 条目');
  assert.equal(Object.isFrozen(mutableRef), false, '不得冻结活对象的 raw ref');

  manager.clear();
  assert.equal(manager.getRetainedReferenceIds().size, 0, 'clear 必须释放 IDs');
  assert.equal(manager.getStats().retainedBytes, 0, 'clear 必须释放引用预算');
});

// --- Preview refresh ----------------------------------------------------------

test('Luna v3: preview refresh reuses the pending plan and replaces stale content', () => {
  const previewFactory = assertExport(previewModule, 'createContextPreview');
  const makeNode = () => {
    const node = { children: [], parentNode: null, textContent: '', style: {}, listeners: new Map(),
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; },
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      removeEventListener(type) { this.listeners.delete(type); },
      remove() { this.parentNode?.removeChild?.(this); },
    };
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
    return node;
  };
  const input = { value: 'FIRST_QUESTION' };
  const doc = { body: makeNode(), createElement: makeNode, getElementById: id => id === 'input-target' ? input : null };
  const target = makeCard('target', { draft: 'FIRST_QUESTION' });
  const preview = previewFactory({ getDocument: () => doc, getCards: () => [target], reportIssue: noop });
  const walk = root => [root, ...root.children.flatMap(walk)];
  preview.show(target);
  const firstText = walk(doc.body).map(item => item.textContent).join('\n');
  input.value = 'SECOND_QUESTION';
  target.draft = 'SECOND_QUESTION';
  assert.equal(typeof preview.refresh, 'function', 'preview 必须提供 refresh');
  preview.refresh(target);
  const secondText = walk(doc.body).map(item => item.textContent).join('\n');
  assert.match(firstText, /FIRST_QUESTION/);
  assert.match(secondText, /SECOND_QUESTION/);
  assert.doesNotMatch(secondText, /FIRST_QUESTION/);
  preview.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackService } from '../ui/assets/panel-feedback.js';
import { createCanvasActions } from '../ui/assets/panel-canvas-actions.js';
import { createCanvasViewController } from '../ui/assets/panel-canvas-view.js';
import { createCardEvents } from '../ui/assets/panel-card-events.js';
import { createRenderer } from '../ui/assets/panel-renderer.js';
import { cardContentSignature, canReuseCardElement } from '../ui/assets/panel-render-diff.js';
import { createHistoryController } from '../ui/assets/panel-history-controller.js';
import { setCardDraft, clearCardDraft, getCardDraft, setMessageAsidesOpen, setCardScrollToEnd, setCardGeometry, setCardCollapsed, setCardStatusStamp, setCardZIndex } from '../ui/assets/panel-cards.js';
import { assertFunction, assertObject, assertString, assertCardsArray, assertMethod } from '../ui/assets/panel-contracts.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class Node {
  constructor(documentRef) {
    this.documentRef = documentRef;
    this.children = [];
    this.style = {};
    this.events = {};
    this.hidden = false;
    this.open = false;
    this.textContent = '';
    this.value = '';
  }
  set id(value) { this.elementId = value; this.documentRef.nodes.set(value, this); }
  get id() { return this.elementId || ''; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, handler) { this.events[type] = handler; }
  removeEventListener(type, handler) { if (this.events[type] === handler) delete this.events[type]; }
  getBoundingClientRect() { return { width: 1000, height: 700, left: 0, top: 0 }; }
}

function makeDocument() {
  const documentRef = {
    nodes: new Map(),
    createElement: () => new Node(documentRef),
    getElementById: id => documentRef.nodes.get(id) || null,
  };
  documentRef.body = new Node(documentRef);
  return documentRef;
}

function canvasHarness({ result, activeId = null, isDisposedOverride, extractDocumentFileOverride } = {}) {
  let cards = [];
  let generation = 1;
  const calls = [];
  let dependencyScheduleSaveCalls = 0;
  let controllerScheduleSaveCalls = 0;
  const session = {
    generation,
    state: { activeId },
    async newSession() { calls.push('newSession'); this.state.activeId = 'session-1'; this.generation = ++generation; },
    scheduleSave() { controllerScheduleSaveCalls += 1; calls.push('save'); },
  };
  const deps = {
    getCards: () => cards,
    setCards: next => { cards = next; },
    getSelectedCardId: () => null,
    setSelectedCardId() {},
    multiSelectedCardIds: new Set(),
    canMutateCanvas: token => token === undefined || token === session.generation,
    chainIsBusy: () => false,
    abortActiveRequest: () => {},
    abortDocumentTasksFor: () => {},
    renderCards: () => calls.push('render'),
    scheduleSave: () => { dependencyScheduleSaveCalls += 1; calls.push('save'); },
    recordSnapshot: () => calls.push('snapshot'),
    selectCard: () => calls.push('select'),
    focusCardInViewport: () => {},
    ensureCardInView: () => {},
    calculateBranchYPositions: () => [0],
    getSessionController: () => session,
    initialSnapshot: () => ({ cards: [], view: { x: 0, y: 0, scale: 1 } }),
    uniqueId: prefix => `${prefix}-1`,
    isDisposed: isDisposedOverride || (() => false),
    extractDocumentFile: extractDocumentFileOverride || (async () => { calls.push('parse'); return result; }),
    flashMessage: text => calls.push(['flash', text]),
  };
  return {
    actions: createCanvasActions(deps),
    session,
    calls,
    get dependencyScheduleSaveCalls() { return dependencyScheduleSaveCalls; },
    get controllerScheduleSaveCalls() { return controllerScheduleSaveCalls; },
    get cards() { return cards; },
    setCards(next) { cards = next; },
    setGeneration(value) { generation = value; session.generation = value; },
  };
}

function makeEventNode({ id = '', value = '', open = false } = {}) {
  const node = {
    id,
    value,
    open,
    style: {},
    events: new Map(),
    classList: {
      values: new Set(),
      add(...names) { names.forEach(name => this.values.add(name)); },
      remove(...names) { names.forEach(name => this.values.delete(name)); },
      contains(name) { return this.values.has(name); },
    },
    focus() { this.focused = true; },
    click() { this.clicked = true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
  return node;
}

function makeCardEventHarness(options = {}) {
  const { getCards, activeRequests = new Map() } = options;
  const hasCancelCardRequest = Object.hasOwn(options, 'cancelCardRequest');
  const cancelCardRequest = options.cancelCardRequest;
  const hasSendCardPrompt = Object.hasOwn(options, 'sendCardPrompt');
  const sendCardPrompt = options.sendCardPrompt;
  const card = { id: 'card-1', messages: [{ role: 'assistant', requestId: 'req-1', asidesOpen: false }] };
  const cardsGetter = getCards || (() => [card]);
  const input = makeEventNode({ id: 'input-card-1' });
  const asides = makeEventNode({ id: 'asides-req-1', open: false });
  const cancel = makeEventNode();
  const send = makeEventNode();
  const battle = makeEventNode();
  const close = makeEventNode();
  const branch = makeEventNode();
  const branchBattle = makeEventNode();
  const attach = makeEventNode();
  const file = makeEventNode();
  const staged = makeEventNode();
  const cardEl = makeEventNode();
  const bySelector = new Map([
    ['#input-card-1', input],
    ['#asides-req-1', asides],
    ['[data-action="cancel"]', cancel],
    ['[data-action="send"]', send],
    ['[data-action="battle"]', battle],
    ['[data-action="close"]', close],
    ['[data-action="branch"]', branch],
    ['[data-action="branch-battle"]', branchBattle],
    ['[data-action="attach"]', attach],
    ['#file-card-1', file],
    ['.staged-attachments-bar', staged],
    ['[data-drag-handle="true"]', makeEventNode()],
  ]);
  cardEl.querySelector = selector => bySelector.get(selector) || null;
  cardEl.querySelectorAll = () => [];
  cardEl.contains = () => false;
  const listeners = [];
  const schedules = [];
  const cancelCalls = [];
  const sendCalls = [];
  const sendSnapshots = [];
  const cancelFn = hasCancelCardRequest
    ? cancelCardRequest
    : ((cardId, reason) => cancelCalls.push({ cardId, reason }));
  // 桩要复现真实 engine 的接受边界：只有进入接受态才回调 onAccepted 清输入
  const sendFn = hasSendCardPrompt
    ? sendCardPrompt
    : (async (card, text, sendOptions) => {
          sendCalls.push([card, text, sendOptions]);
        sendSnapshots.push({ draft: card.draft, input: input.value, text });
        sendOptions?.onAccepted?.({ cardId: card.id });
        return true;
      });
  const documentRef = { activeElement: null, body: makeEventNode() };
  const deps = {
    listen(target, type, handler) {
      if (target) target.events.set(type, handler);
      listeners.push({ target, type, handler });
      return () => {};
    },
    getCardCleanups: () => new Set(),
    hana: { sessions: { focus: async () => {} } },
    flashMessage: () => {},
    safeDetail: value => String(value),
    getSession: () => ({ generation: 1 }),
    getCards: cardsGetter,
    getIsDisposed: () => false,
    getIsSpacePressed: () => false,
    getSelectedCardId: () => card.id,
    getDocumentRef: () => documentRef,
    getNavigator: () => null,
    activeRequests,
    paintMessage: () => {},
    ChatError: class extends Error {},
    chainIsBusy: () => false,
    openBattleDialog: async () => {},
    documentUi: { attachFilesToCard: async () => {}, removeStagedAttachment: () => {}, hideDropIndicator: () => {} },
    cardGestures: { beginCardDrag: () => {}, bindResizeHandles: () => {} },
    createBranchCard: () => {},
    closeCardHierarchy: () => {},
    cycleCardStatusStamp: () => null,
    selectCard: () => {},
    toggleMultiSelectCard: () => {},
    clearMultiSelect: () => {},
    renderCards: () => {},
    renderConnectors: () => {},
    scheduleSave: () => schedules.push('save'),
    recordSnapshot: () => {},
    canMutateCanvas: () => true,
    sendCardPrompt: sendFn,
    cancelCardRequest: cancelFn,
    findCardAncestorChain: () => [],
    cardParentIds: () => [],
    formatCardChainMarkdown: () => '',
    buildTopologyOutline: () => '',
    openContextPreview: () => {},
    openRefManager: () => {},
  };
  return {
    card,
    cardEl,
    input,
    asides,
    cancel,
    activeRequests,
    cancelCalls,
    sendCalls,
    sendSnapshots,
    schedules,
    listeners,
    controller: createCardEvents(deps),
  };
}

function makeRendererHarness({ cards = [], getCards = () => cards, bodyScrollTop = 123 } = {}) {
  const input = makeEventNode({ id: `input-${cards[0]?.id || 'card-1'}`, value: 'draft from DOM' });
  const body = makeEventNode({ id: `body-${cards[0]?.id || 'card-1'}` });
  body.scrollTop = bodyScrollTop;
  body.scrollHeight = 900;
  const asides = makeEventNode({ id: `asides-${cards[0]?.messages?.[0]?.requestId || 'req-1'}`, open: true });
  const cardsLayer = {
    innerHTML: '<stale>',
    children: [],
    querySelectorAll: selector => selector === '.card-input' ? [input] : [],
    appendChild(node) { this.children.push(node); },
  };
  const documentRef = {
    activeElement: null,
    getElementById(id) {
      return id === body.id ? body : (id === asides.id ? asides : null);
    },
    createElement() {
      const cardEl = makeEventNode();
      cardEl.querySelector = selector => selector === `#body-${cards[0]?.id || 'card-1'}` ? body : null;
      return cardEl;
    },
  };
  const cleanups = new Set();
  const deps = {
    documentRef,
    cardContentSignature,
    canReuseCardElement,
    getCardsLayer: () => cardsLayer,
    getBadgeStats: () => null,
    getEmptyState: () => null,
    getIsDisposed: () => false,
    getCards,
    getSelectedCardId: () => null,
    getCurrentAgent: () => ({ id: 'agent-1' }),
    getSession: () => ({ state: { ready: true, busy: false } }),
    getMultiSelectedCardIds: () => new Set(),
    activeRequests: new Map(),
    chainIsBusy: () => false,
    drain: set => set.clear(),
    getCardCleanups: () => cleanups,
    computeVisibleCards: ({ cards: visible }) => ({ visibleCards: visible }),
    collectSubtreeCardIds: () => new Set(),
    cardParentIds: () => [],
    buildCardHtml: () => '<div></div>',
    escapeHtml: value => String(value),
    messageMarkup: () => '',
    statusText: () => '',
    formatFileSize: () => '0 B',
    bindCardEvents: () => {},
    renderConnectors: () => {},
  };
  return { renderer: createRenderer(deps), cardInput: input, body, asides, cardsLayer, documentRef };
}

test('panel-feedback: flash uses an injected document/timer and dispose closes its own local lifecycle gate', () => {
  const documentRef = makeDocument();
  let documentReads = 0;
  const timers = [];
  const cancelled = [];
  const feedback = createFeedbackService({
    documentRef: () => { documentReads++; return documentRef; },
    later: callback => { timers.push(callback); return timers.length; },
    cancelLater: id => cancelled.push(id),
  });
  assert.equal(documentReads, 0, '构造阶段不得读取晚绑定 document');
  feedback.flashMessage('第一条');
  const el = documentRef.nodes.get('fork-flash');
  assert.equal(el.textContent, '第一条');
  assert.equal(el.style.opacity, '1');
  feedback.flashMessage('第二条');
  assert.equal(el.textContent, '第二条');
  assert.deepEqual(cancelled, [1]);
  timers.at(-1)();
  assert.equal(el.style.opacity, '0');
  feedback.flashMessage('不会显示');
  feedback.dispose();
  assert.equal(feedback.isDisposed(), true);
  assert.equal(el.style.opacity, '0');
  assert.equal(cancelled.at(-1), 3);
  feedback.flashMessage('迟到');
  assert.equal(el.textContent, '不会显示');
});

test('panel-canvas-actions: document creation orders session before parse and preserves complete card schema', async () => {
  const result = {
    ok: true, filename: 'report.pdf', size: 88, extension: '.pdf', charCount: 10, lineCount: 2,
    text: '正文内容', preview: '正文', engineLabel: 'test-parser',
  };
  const ui = canvasHarness({ result });
  const card = await ui.actions.createDocumentCard({ name: 'report.pdf' }, { x: 12, y: 34 });
  assert.ok(card);
  assert.ok(ui.calls.indexOf('newSession') < ui.calls.indexOf('parse'), '必须先确保会话存在，再启动解析');
  assert.ok(ui.calls.indexOf('parse') < ui.calls.indexOf('render'));
  assert.deepEqual(ui.calls, ['newSession', 'parse', 'render', 'save', 'select', 'snapshot'], '文档成功路径必须保持 render→save→select→snapshot 顺序');
  assert.equal(ui.dependencyScheduleSaveCalls, 1, '成功文档路径必须调用注入的 dep.scheduleSave 一次');
  assert.equal(ui.controllerScheduleSaveCalls, 0, '成功文档路径不得越端口调用 sessionCtrl.scheduleSave');
  assert.equal(card.isDoc, true);
  assert.deepEqual(card.docMeta, { name: 'report.pdf', size: 88, extension: '.pdf', charCount: 10, lineCount: 2 });
  assert.deepEqual(card.messages[0].docMeta, { name: 'report.pdf', size: 88, lineCount: 2, charCount: 10 });
  assert.equal(card.messages[0].docPreview, '正文');
  assert.equal(card.x, 12);
  assert.equal(card.y, 34);
});

test('panel-canvas-actions: dispose during extract prevents late document card/render/save even when canMutate stays true', async () => {
  let disposed = false;
  let release;
  const ui = canvasHarness({
    activeId: 'session-1',
    isDisposedOverride: () => disposed,
    extractDocumentFileOverride: () => new Promise(resolve => { release = resolve; }),
  });
  const pending = ui.actions.createDocumentCard({ name: 'late.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  disposed = true;
  release({ ok: true, filename: 'late.pdf', size: 1, extension: '.pdf', charCount: 1, lineCount: 1, text: '迟到', preview: '迟到' });

  assert.equal(await pending, null);
  assert.equal(ui.cards.length, 0, 'dispose 后迟到解析不得新建卡片');
  assert.equal(ui.calls.includes('render'), false, 'dispose 后迟到解析不得重绘');
  assert.equal(ui.calls.includes('save'), false, 'dispose 后迟到解析不得保存');
});

test('panel-canvas-actions: core branch creation works without optional DOM/document dependencies', () => {
  const ui = canvasHarness({ activeId: 'session-1' });
  const parent = {
    id: 'parent', parentId: null, title: '主线对话 #01', x: 80, y: 80, width: 340,
    messages: [{ role: 'assistant', status: 'completed', text: '正文' }],
  };
  ui.setCards([parent]);
  const branch = ui.actions.createBranchCard(parent, { autoFocus: false });
  assert.ok(branch);
  assert.equal(ui.cards.length, 2);
  assert.equal(ui.cards[1].parentId, 'parent');
});

test('panel-canvas-actions: parse failure and generation change never create a document card', async () => {
  const failed = canvasHarness({ result: { ok: false, filename: 'bad.pdf', stage: 'parse', error: 'denied' } });
  assert.equal(await failed.actions.createDocumentCard({ name: 'bad.pdf' }), null);
  assert.equal(failed.cards.length, 0);
  assert.deepEqual(failed.calls.at(-1), ['flash', '《bad.pdf》没读出来（parse阶段）：denied']);

  let release;
  const pending = canvasHarness({ result: null });
  pending.actions = createCanvasActions({
    getCards: () => pending.cards,
    setCards: next => { pending._cards = next; },
    getSelectedCardId: () => null, setSelectedCardId() {}, multiSelectedCardIds: new Set(),
    canMutateCanvas: token => token === undefined || token === pending.session.generation,
    chainIsBusy: () => false,
    abortActiveRequest: () => {},
    abortDocumentTasksFor: () => {},
    renderCards() {}, scheduleSave() {}, recordSnapshot() {}, selectCard() {}, ensureCardInView() {}, focusCardInViewport() {},
    calculateBranchYPositions: () => [0],
    getSessionController: () => pending.session, initialSnapshot: () => ({}), uniqueId: p => `${p}-late`, isDisposed: () => false,
    extractDocumentFile: () => new Promise(resolve => { release = resolve; }), flashMessage() {},
  });
  const late = pending.actions.createDocumentCard({ name: 'old.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  pending.setGeneration(pending.session.generation + 1);
  release({ ok: true, filename: 'old.pdf', size: 1, extension: '.pdf', charCount: 1, lineCount: 1, text: '迟到', preview: '迟到' });
  assert.equal(await late, null);
  assert.equal(pending.cards.length, 0);
});

test('panel-canvas-view: resetView restores the initial viewport only when there are no cards', () => {
  const view = { x: 900, y: -200, scale: 1.8 };
  const surfaceDoc = makeDocument();
  const viewportDoc = makeDocument();
  const controller = createCanvasViewController({
    getCards: () => [], getSelectedCardId: () => null, setSelectedCardId() {}, view,
    multiSelectedCardIds: new Set(), surface: new Node(surfaceDoc), viewport: new Node(viewportDoc), zoomText: null,
    connectorsSvg: null, btnZoomIn: null, btnZoomOut: null, getIsSpacePressed: () => false,
    canMutateCanvas: () => true,
    renderCards() {}, scheduleSave() {}, recordSnapshot() {}, clearMultiSelect() {}, isDisposed: () => false,
    listen() {}, later() {}, documentRef: () => makeDocument(), windowRef: null,
  });
  controller.resetView();
  assert.deepEqual(view, { x: 60, y: 40, scale: 1.0 });
});

test('panel-contracts: required dependency and runtime card assertions fail closed', () => {
  const fn = () => {};
  const object = {};
  assert.equal(assertFunction(fn, 'fn'), fn);
  assert.equal(assertObject(object, 'object'), object);
  assert.equal(assertString('id', 'id'), 'id');
  const cards = [];
  assert.equal(assertCardsArray(cards, 'cards'), cards);
  assert.equal(assertMethod({ run: fn }, 'run'), fn);
  assert.throws(() => assertFunction(null, 'fn'), TypeError);
  assert.throws(() => assertObject(null, 'object'), TypeError);
  assert.throws(() => assertString('', 'id'), TypeError);
  assert.throws(() => assertCardsArray(null, 'cards'), TypeError);
  assert.throws(() => assertCardsArray({ length: 0 }, 'cards'), TypeError);
  assert.throws(() => assertMethod({}, 'run'), TypeError);
});

test('panel-cards: shared draft, scroll, asides, status and geometry writers preserve identity and delete defaults', () => {
  const card = {
    id: 'card-1',
    draft: 'old',
    scrollToEnd: true,
    height: 640,
    isCollapsed: true,
    statusStamp: 'starred',
    zIndex: 8,
  };
  const message = { requestId: 'req-1', asidesOpen: true };

  setCardDraft(card, 'new draft');
  setCardScrollToEnd(card, true);
  setMessageAsidesOpen(message, false);
  setCardGeometry(card, { x: 12, y: 24, width: 400, height: 480 });
  setCardCollapsed(card, false);
  setCardStatusStamp(card, 'accepted');
  setCardZIndex(card, 10);

  assert.equal(getCardDraft(card), 'new draft');
  assert.equal(card.scrollToEnd, true);
  assert.equal(message.asidesOpen, false);
  assert.equal(card.x, 12);
  assert.equal(card.y, 24);
  assert.equal(card.width, 400, '几何写入口必须保留明确提供的几何值');
  assert.equal(card.height, 480);
  assert.equal(card.isCollapsed, undefined);
  assert.equal(card.statusStamp, 'accepted');
  assert.equal(card.zIndex, 10);

  const whitespaceDraft = '  \n\t';
  setCardDraft(card, whitespaceDraft);
  setCardScrollToEnd(card, false);
  setMessageAsidesOpen(message, undefined);
  setCardGeometry(card, { x: 30 });
  setCardStatusStamp(card, null);
  setCardZIndex(card, undefined);

  assert.equal(card.draft, whitespaceDraft, '纯空格/换行草稿必须逐字保留');
  assert.equal(card.scrollToEnd, undefined);
  assert.equal(message.asidesOpen, undefined);
  assert.equal(card.height, 480, '只更新坐标时不得删除未提供的 height');
  assert.equal(card.statusStamp, undefined);
  assert.equal(card.zIndex, undefined);

  clearCardDraft(card);
  assert.equal(card.draft, undefined, '只有发送路径显式 clear helper 才允许清空草稿');
});

test('panel-renderer: preserve pass writes shared draft/scroll/asides state through the live card objects', () => {
  const card = { id: 'card-1', draft: 'old', messages: [{ role: 'assistant', requestId: 'req-1' }] };
  const harness = makeRendererHarness({ cards: [card] });
  harness.renderer.renderCards(true);

  assert.equal(card.draft, 'draft from DOM');
  assert.equal(card.savedScrollTop, 123);
  assert.equal(card.messages[0].asidesOpen, true);
  assert.equal(harness.cardsLayer.children.length, 1);
  assert.equal(harness.cardsLayer.children[0].querySelector('#body-card-1'), harness.body);

  harness.cardInput.value = '  \n\t';
  harness.renderer.renderCards(true);
  assert.equal(card.draft, '  \n\t', 'renderer 回收草稿时不得 trim 纯空白内容');
});

test('panel-renderer: a legitimate scrollTop=0 survives preserve redraw across two frames', () => {
  const card = { id: 'card-1', messages: [{ role: 'assistant', requestId: 'req-1' }] };
  const harness = makeRendererHarness({ cards: [card], bodyScrollTop: 0 });
  harness.renderer.renderCards(true);
  assert.equal(card.savedScrollTop, 0, 'scrollTop=0 是合法状态，不能被当作缺省删除');
  assert.equal(harness.body.scrollTop, 0, '首帧重绘不得跳到底部');

  harness.body.scrollTop = 0;
  harness.renderer.renderCards(true);
  assert.equal(card.savedScrollTop, 0, '第二帧仍必须保留 scrollTop=0');
  assert.equal(harness.body.scrollTop, 0, '跨帧 preserve 重绘仍不得跳到底部');
});

test('panel-card-events: draft/asides writes use shared state and cancel delegates to engine without mutating message state', () => {
  const active = {
    terminalSeen: false,
    controller: { abort() { throw new Error('事件层不得直接 abort'); } },
    message: { status: 'generating', streaming: true },
  };
  let getCardsReads = 0;
  const harness = makeCardEventHarness({
    getCards: () => { getCardsReads++; return []; },
    activeRequests: new Map([['card-1', active]]),
  });
  assert.equal(getCardsReads, 0, 'card-events 构造阶段不得读取晚绑定 getCards');
  harness.controller.bindCardEvents(harness.cardEl, harness.card);
  assert.equal(getCardsReads, 0, '草稿/副栏/取消绑定阶段不得提前读取 getCards');

  harness.input.value = 'typed later';
  harness.input.events.get('input')();
  harness.asides.open = true;
  harness.asides.events.get('toggle')();
  harness.cancel.events.get('click')({});

  assert.equal(harness.card.draft, 'typed later');
  assert.equal(harness.card.messages[0].asidesOpen, true);
  assert.deepEqual(harness.cancelCalls, [{ cardId: 'card-1', reason: '用户取消了本次等待。' }]);
  assert.equal(active.message.status, 'generating');
  assert.equal(active.message.streaming, true);
  assert.ok(harness.schedules.length >= 2, '草稿与折叠状态变更都必须请求保存');

  harness.input.value = '  \n\t';
  harness.input.events.get('input')();
  assert.equal(harness.card.draft, '  \n\t', 'events 回收草稿时不得 trim 纯空白内容');
});

test('panel-card-events: send explicitly clears the draft only after delegating the prompt', async () => {
  const harness = makeCardEventHarness();
  harness.controller.bindCardEvents(harness.cardEl, harness.card);
  harness.input.value = 'question';
  await harness.input.events.get('input')();
  assert.equal(harness.card.draft, 'question');
  await harness.cardEl.querySelector('[data-action="send"]').events.get('click')({});
  assert.equal(harness.card.draft, undefined, '发送完成后必须使用显式 clear helper');
  assert.equal(harness.sendCalls.length, 1);
  assert.deepEqual(harness.sendSnapshots, [{ draft: 'question', input: 'question', text: 'question' }], '委托 engine 时输入仍必须存在，不能由事件层提前清空');
});

test('panel-card-events: cancelCardRequest is a required engine delegate, not an optional controller.abort fallback', () => {
  assert.throws(
    () => makeCardEventHarness({ cancelCardRequest: undefined }),
    TypeError,
    '取消委托缺失时必须在工厂构造阶段失败',
  );
});

test('panel-card-events: source has no direct controller.abort cancellation fallback', async () => {
  const source = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui/assets/panel-card-events.js'), 'utf8');
  assert.doesNotMatch(source, /active\.controller\.abort/, '取消必须归属 chat engine，不得由事件层直接 abort');
});

test('panel-renderer: constructor does not read a late-bound getCards getter', () => {
  let reads = 0;
  const rendererDeps = makeRendererHarness({
    getCards: () => { reads++; return []; },
  });
  assert.equal(reads, 0, 'renderer 构造阶段不得读取晚绑定 getCards');
  rendererDeps.renderer.renderCards(false);
  assert.equal(reads, 1, 'renderer 运行时才读取 getCards');
});

test('panel-renderer: non-array getCards fails at the actual render boundary', () => {
  const harness = makeRendererHarness({ getCards: () => ({ not: 'cards' }) });
  assert.throws(() => harness.renderer.renderCards(false), TypeError);
});

test('panel-history-controller: late getCards remains unread at construction and undo restores the live card identity', () => {
  let reads = 0;
  let live = { id: 'card-1', x: 1, y: 2, width: 340, messages: [{ text: 'keep me' }] };
  const controller = createHistoryController({
    getCards: () => { reads++; return [live]; },
    setCards: next => { live = next[0]; },
    setSelectedCardId: () => {},
    renderCards: () => {},
    renderConnectors: () => {},
    scheduleSave: () => {},
  });
  assert.equal(reads, 0);

  const identity = live;
  controller.recordSnapshot([identity], identity.id);
  identity.x = 99;
  controller.recordSnapshot([identity], identity.id);
  assert.equal(controller.undo(), true);
  assert.equal(live, identity, '历史恢复只改拓扑字段，不应替换活卡对象');
  assert.equal(live.x, 1);
});

test('panel-history-controller: restoring a snapshot without height deletes a stale live geometry field', () => {
  const card = { id: 'card-1', x: 1, y: 2, width: 340, messages: [] };
  const history = createHistoryController({
    getCards: () => [card], setCards: () => {}, setSelectedCardId: () => {},
    renderCards: () => {}, renderConnectors: () => {}, scheduleSave: () => {},
  });
  history.recordSnapshot([card], card.id);
  card.height = 640;
  history.recordSnapshot([card], card.id);
  delete card.height;
  history.recordSnapshot([card], card.id);
  card.height = 900;
  assert.equal(history.undo(), true);
  assert.equal(card.height, 640);
  assert.equal(history.undo(), true);
  assert.equal(card.height, undefined, '快照缺省字段必须删除旧几何值');

  card.width = 999;
  history.recordSnapshot([card], card.id);
  card.width = 340;
  history.recordSnapshot([card], card.id);
  assert.equal(history.undo(), true);
  assert.equal(card.width, 999, '历史恢复应保留既有几何值，不得重新走用户输入 clamp');
});

test('panel architecture: renderer and session-state route transient writes through panel-cards helpers', async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui/assets');
  for (const file of ['panel-renderer.js', 'panel-session-state.js']) {
    const text = await readFile(path.join(dir, file), 'utf8');
    assert.doesNotMatch(
      text,
      /\b(?:card|message)\.(?:draft|savedScrollTop|asidesOpen|scrollToEnd)\s*=(?!=)/,
      `${file} 不得绕过 panel-cards helper 直接写展示暂态`,
    );
  }
});

test('panel architecture: business controllers do not silently replace an invalid getCards getter with []', async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui/assets');
  const files = (await readdir(dir)).filter(file => /^panel-.*\.js$/.test(file) && file !== 'panel-contracts.js');
  const violations = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), 'utf8');
    if (/getCards\s*\?\s*getCards\(\)\s*:\s*\[\]|getCards\(\)\s*\|\|\s*\[\]/.test(text)) violations.push(file);
  }
  assert.deepEqual(violations, [], `发现 getCards 静默回退：${violations.join(', ')}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep the regression runnable against an immutable git-show/archive tree while
// Sol changes the mutable production tree:
//   FORK_CHAT_PROD_ROOT=/path/to/baseline node --test tests/panel-arrange-draft-regressions.test.mjs
const repoRoot = process.env.LUNA_PROD_ROOT
  || process.env.FORK_CHAT_PROD_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panelSource = await readFile(path.join(repoRoot, 'ui/assets/panel.js'), 'utf8');
const load = name => import(pathToFileURL(path.join(repoRoot, 'ui/assets', name)).href);

const [cardsModule, messagesModule, planModule, engineModule, eventsModule,
  rendererModule, actionsModule, viewModule, layoutModule, renderDiffModule] = await Promise.all([
  load('panel-cards.js'),
  load('panel-messages.js'),
  load('panel-context-plan.js'),
  load('panel-chat-engine.js'),
  load('panel-card-events.js'),
  load('panel-renderer.js'),
  load('panel-canvas-actions.js'),
  load('panel-canvas-view.js'),
  load('panel-layout.js'),
  load('panel-render-diff.js')]);
const { cardContentSignature, canReuseCardElement } = renderDiffModule;

const { buildCardHtml, cardParentIds } = cardsModule;
const { messageMarkup, statusText } = messagesModule;
const { buildContextPlan } = planModule;
const { createChatEngine } = engineModule;
const { createCardEvents } = eventsModule;
const { createRenderer } = rendererModule;
const { createCanvasActions } = actionsModule;
const { createCanvasViewController } = viewModule;
const { calculateBranchYPositions } = layoutModule;

const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));

function cardOf(id, extra = {}) {
  return {
    id,
    title: id,
    parentId: null,
    x: 80,
    y: 80,
    width: 340,
    messages: [{ role: 'assistant', localOnly: true, text: `LOCAL_${id}` }],
    ...extra,
  };
}

function classNames(value) {
  return String(value || '').split(/\s+/).filter(Boolean);
}

/**
 * Minimal legal DOM replacement for the production renderer/cardHtml path.
 * It intentionally supports selectors and event dispatch used by the real
 * modules instead of replacing renderCards or calling it directly as the
 * arrange action under test.
 */
function makeDocument() {
  const state = {
    document: null,
    metrics: {
      appendCalls: 0,
      innerHTMLWrites: 0,
      valueWrites: 0,
      focusCalls: 0,
      selectionWrites: 0,
    },
  };

  function makeNode(tagName = 'div') {
    const attrs = new Map();
    const classSet = new Set();
    const node = {
      nodeType: 1,
      tagName: String(tagName).toUpperCase(),
      children: [],
      parentNode: null,
      ownerDocument: state.document,
      style: {},
      dataset: {},
      hidden: false,
      disabled: false,
      id: '',
      action: '',
      textContent: '',
      listeners: new Map(),
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 360,
      offsetHeight: 360,
      selectionStart: 0,
      selectionEnd: 0,
      _value: '',
      classList: {
        add(...names) {
          names.forEach(name => classSet.add(name));
          node._className = [...classSet].join(' ');
        },
        remove(...names) {
          names.forEach(name => classSet.delete(name));
          node._className = [...classSet].join(' ');
        },
        contains(name) {
          return classSet.has(name);
        },
      },
      appendChild(child) {
        state.metrics.appendCalls += 1;
        if (child?.parentNode) child.parentNode.removeChild?.(child);
        this.children.push(child);
        if (child) child.parentNode = this;
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        if (child) child.parentNode = null;
        return child;
      },
      remove() {
        this.parentNode?.removeChild?.(this);
      },
      contains(target) {
        if (this === target) return true;
        return this.children.some(child => child?.contains?.(target));
      },
      addEventListener(type, handler) {
        const handlers = this.listeners.get(type) || [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
      },
      removeEventListener(type, handler) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== handler));
      },
      dispatchEvent(event = {}) {
        const current = { ...event };
        if (!current.target) current.target = this;
        current.currentTarget = this;
        current.defaultPrevented = false;
        current.preventDefault = current.preventDefault || (() => { current.defaultPrevented = true; });
        current.stopPropagation = current.stopPropagation || noop;
        const results = [];
        for (const handler of [...(this.listeners.get(current.type) || [])]) {
          try {
            results.push(handler(current));
          } catch (error) {
            results.push(Promise.reject(error));
          }
        }
        this.lastDispatchPromise = Promise.all(results.map(result => Promise.resolve(result)));
        return true;
      },
      focus() {
        state.metrics.focusCalls += 1;
        if (state.document) state.document.activeElement = this;
      },
      blur() {
        if (state.document?.activeElement === this) state.document.activeElement = null;
      },
      setSelectionRange(start, end) {
        state.metrics.selectionWrites += 1;
        this.selectionStart = start;
        this.selectionEnd = end;
      },
      getAttribute(name) {
        return attrs.get(name) ?? null;
      },
      setAttribute(name, value) {
        const stringValue = String(value);
        attrs.set(name, stringValue);
        if (name === 'id') this.id = stringValue;
        if (name === 'class') this.className = stringValue;
        if (name === 'data-action') this.action = stringValue;
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = stringValue;
      },
    };

    Object.defineProperty(node, 'className', {
      configurable: true,
      get: () => node._className || '',
      set: value => {
        classSet.clear();
        classNames(value).forEach(name => classSet.add(name));
        node._className = [...classSet].join(' ');
        attrs.set('class', node._className);
      },
    });
    Object.defineProperty(node, 'value', {
      configurable: true,
      get: () => node._value,
      set: value => {
        state.metrics.valueWrites += 1;
        node._value = String(value ?? '');
      },
    });
    Object.defineProperty(node, 'isConnected', {
      get: () => {
        let current = node;
        while (current) {
          if (current === state.document) return true;
          current = current.parentNode;
        }
        return false;
      },
    });
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });

    const walk = root => [root, ...root.children.flatMap(child => walk(child))];
    node.matches = selector => {
      const alternatives = String(selector || '').split(',').map(item => item.trim()).filter(Boolean);
      return alternatives.some(item => {
        if (item === '*') return true;
        if (item.startsWith('#')) return node.id === item.slice(1);
        const attr = item.match(/^\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]$/);
        if (attr) {
          const current = node.getAttribute(attr[1]);
          return current !== null && (attr[2] === undefined || current === attr[2]);
        }
        const tagAttr = item.match(/^([a-zA-Z]+)\[([^=\]]+)=?["']?([^\]"']*)["']?\]$/);
        if (tagAttr) {
          return node.tagName.toLowerCase() === tagAttr[1].toLowerCase()
            && node.getAttribute(tagAttr[2]) === tagAttr[3];
        }
        if (item.startsWith('.')) return item.slice(1).split('.').every(name => classSet.has(name));
        if (item.includes('.')) {
          const [tag, ...classes] = item.split('.');
          return node.tagName.toLowerCase() === tag.toLowerCase() && classes.every(name => classSet.has(name));
        }
        return node.tagName.toLowerCase() === item.toLowerCase();
      });
    };
    node.closest = selector => {
      let current = node;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentNode;
      }
      return null;
    };
    node.querySelector = selector => walk(node).find(item => item !== node && item.matches?.(selector)) || null;
    node.querySelectorAll = selector => walk(node).filter(item => item !== node && item.matches?.(selector));

    Object.defineProperty(node, 'innerHTML', {
      configurable: true,
      get: () => '',
      set: html => {
        state.metrics.innerHTMLWrites += 1;
        for (const child of node.children) child.parentNode = null;
        node.children = [];
        const source = String(html ?? '');
        if (!source) return;
        const openTags = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
        for (const match of source.matchAll(openTags)) {
          const child = makeNode(match[1]);
          const rawAttrs = match[2] || '';
          const attrPattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
          for (const attr of rawAttrs.matchAll(attrPattern)) {
            child.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
          }
          if (child.classList.contains('card-body')) {
            child.offsetHeight = 360;
            child.scrollHeight = 1000;
          }
          node.appendChild(child);
        }
      },
    });

    return node;
  }

  const doc = {
    activeElement: null,
    metrics: state.metrics,
    createElement: tagName => makeNode(tagName),
    body: null,
    getElementById(id) {
      const walk = root => [root, ...root.children.flatMap(child => walk(child))];
      return walk(this.body).find(item => item.id === id) || null;
    },
  };
  state.document = doc;
  doc.body = makeNode('div');
  doc.body.parentNode = doc;
  doc.body.id = 'cards-layer';
  doc.body.ownerDocument = doc;

  return { doc, makeNode };
}

function createArrangeHarness({ cards: initialCards, generation = 1 } = {}) {
  const { doc, makeNode } = makeDocument();
  const session = {
    generation,
    state: { activeId: 'session-1', ready: true, busy: false },
  };
  const state = { cards: initialCards || [cardOf('root')], session };
  const activeRequests = new Map();
  const cardCleanups = new Set();
  const selected = { id: null };
  const renderTrace = [];
  const snapshots = [];
  const notifications = [];
  const live = new Map();
  const modelRuns = [];
  let drainCalls = 0;
  let bindCalls = 0;
  let idCounter = 0;
  let renderer;
  let canvasView;
  let eventController;

  const getCards = () => state.cards;
  const getSession = () => state.session;
  const canMutateCanvas = expected => expected === undefined || expected === state.session.generation;
  const chainIsBusy = card => {
    if (activeRequests.has(card?.id)) return true;
    const parents = cardParentIds(card);
    return parents.some(parentId => activeRequests.has(parentId));
  };
  const uniqueId = prefix => `${prefix}-arrange-${++idCounter}`;
  const listen = (target, type, handler, options, scope) => {
    if (!target?.addEventListener) return noop;
    target.addEventListener(type, handler, options);
    const off = () => target.removeEventListener?.(type, handler, options);
    scope?.add?.(off);
    return off;
  };
  const drain = set => {
    drainCalls += 1;
    for (const cleanup of [...set]) {
      try { cleanup(); } catch {}
    }
    set.clear();
  };
  const rootRenderCards = (preserve = true, options) => {
    renderTrace.push({ type: 'root-render', preserve, options });
    renderer.renderCards(preserve, options);
  };

  // This is the real arrange production controller.  panel.js wires the
  // toolbar click to this method; the test keeps the click boundary explicit.
  const arrangeButton = makeNode('button');
  arrangeButton.id = 'btn-auto-tidy';

  canvasView = createCanvasViewController({
    getCards,
    getSelectedCardId: () => selected.id,
    setSelectedCardId: id => { selected.id = id; },
    view: { x: 0, y: 0, scale: 1 },
    multiSelectedCardIds: new Set(),
    surface: makeNode('div'),
    viewport: Object.assign(makeNode('div'), {
      clientWidth: 1200,
      clientHeight: 800,
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
    }),
    zoomText: makeNode('span'),
    connectorsSvg: makeNode('svg'),
    refConnectorsSvg: makeNode('svg'),
    getIsSpacePressed: () => false,
    canMutateCanvas,
    renderCards: rootRenderCards,
    scheduleSave: () => { renderTrace.push({ type: 'save' }); },
    recordSnapshot: (cards, selectedId) => { snapshots.push({ cards, selectedId }); },
    clearMultiSelect: noop,
    isDisposed: () => false,
    listen,
    documentRef: doc,
    windowRef: makeNode('window'),
  });
  arrangeButton.addEventListener('click', () => {
    renderTrace.push({ type: 'arrange-click' });
    canvasView.autoTidyLayout();
  });

  const canvasActions = createCanvasActions({
    getCards,
    setCards: next => { state.cards = next; },
    getSelectedCardId: () => selected.id,
    setSelectedCardId: id => { selected.id = id; },
    multiSelectedCardIds: new Set(),
    canMutateCanvas,
    chainIsBusy,
    isBusy: () => false,
    isModalOpen: () => false,
    abortActiveRequest: noop,
    abortDocumentTasksFor: noop,
    calculateBranchYPositions: (parent, count, targetX) => calculateBranchYPositions(parent, count, targetX, state.cards),
    renderCards: rootRenderCards,
    scheduleSave: () => { renderTrace.push({ type: 'save' }); },
    recordSnapshot: (cards, selectedId) => { snapshots.push({ cards, selectedId }); },
    extractDocumentFile: async () => null,
    initialSnapshot: () => ({ cards: [] }),
    getSessionController: () => session,
    selectCard: (id, focus) => canvasView.selectCard(id, focus),
    ensureCardInView: card => canvasView.ensureCardInView(card),
    focusCardInViewport: card => canvasView.focusCardInViewport(card),
    flashMessage: message => notifications.push(String(message)),
    uniqueId,
    isDisposed: () => false,
  });

  const engine = createChatEngine({
    hana: {},
    runChat: async (_hana, request) => {
      renderTrace.push({ type: 'model-boundary', request });
      return new Promise(resolve => { modelRuns.push(resolve); });
    },
    ChatError: class TestChatError extends Error {},
    safeDetail: value => String(value),
    activeRequests,
    getCards,
    getSession,
    getAgent: () => ({ id: 'arrange-agent', name: 'Arrange Agent' }),
    getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null,
    buildContextPlan: (targetCard, options = {}) => {
      renderTrace.push({
        type: 'plan',
        targetCard,
        pendingText: options.pendingUserMessage?.text,
      });
      return buildContextPlan({
        cards: state.cards,
        targetCard,
        pendingUserMessage: options.pendingUserMessage,
      });
    },
    reportContextIssue: issue => notifications.push(issue),
    getIsDisposed: () => false,
    canMutateCanvas,
    uniqueId,
    paintMessage: noop,
    renderCards: rootRenderCards,
    scheduleSave: () => { renderTrace.push({ type: 'save' }); },
    cardParentIds,
    documentRef: doc,
  });

  eventController = createCardEvents({
    listen,
    getCardCleanups: () => cardCleanups,
    hana: {},
    flashMessage: issue => notifications.push(issue),
    safeDetail: value => String(value),
    getSession,
    getGeneration: () => state.session.generation,
    getCards,
    getIsDisposed: () => false,
    getIsSpacePressed: () => false,
    getSelectedCardId: () => selected.id,
    getDocumentRef: () => doc,
    getNavigator: () => null,
    activeRequests,
    paintMessage: noop,
    ChatError: class TestChatError extends Error {},
    chainIsBusy,
    openBattleDialog: async () => {},
    documentUi: {
      attachFilesToCard: async () => {},
      removeStagedAttachment: noop,
      hideDropIndicator: noop,
    },
    cardGestures: {
      beginCardDrag: noop,
      bindResizeHandles: noop,
    },
    createBranchCard: (card, options) => canvasActions.createBranchCard(card, options),
    closeCardHierarchy: card => canvasActions.closeCardHierarchy(card),
    cycleCardStatusStamp: cardsModule.cycleCardStatusStamp,
    selectCard: (id, focus) => canvasView.selectCard(id, focus),
    toggleMultiSelectCard: noop,
    clearMultiSelect: noop,
    renderCards: rootRenderCards,
    renderConnectors: noop,
    scheduleSave: () => { renderTrace.push({ type: 'save' }); },
    recordSnapshot: (cards, selectedId) => { snapshots.push({ cards, selectedId }); },
    canMutateCanvas,
    sendCardPrompt: (...args) => engine.sendCardPrompt(...args),
    cancelCardRequest: (...args) => engine.cancelCardRequest(...args),
    findCardAncestorChain: () => [],
    cardParentIds,
    formatCardChainMarkdown: () => '',
    buildTopologyOutline: () => '',
    openContextPreview: noop,
    openRefManager: noop,
  });

  const bindCardEvents = (root, card) => {
    bindCalls += 1;
    eventController.bindCardEvents(root, card);
    live.set(card.id, {
      card,
      root,
      input: root.querySelector(`#input-${card.id}`),
      send: root.querySelector('[data-action="send"]'),
    });
  };

  renderer = createRenderer({
    cardContentSignature,
    canReuseCardElement,
    documentRef: doc,
    getCardsLayer: () => doc.body,
    getBadgeStats: () => null,
    getEmptyState: () => null,
    getIsDisposed: () => false,
    getCards,
    getSelectedCardId: () => selected.id,
    getCurrentAgent: () => ({ name: 'Arrange Agent' }),
    getSession: () => ({ state: { ready: true, busy: false } }),
    getMultiSelectedCardIds: () => new Set(),
    activeRequests,
    chainIsBusy,
    drain,
    getCardCleanups: () => cardCleanups,
    computeVisibleCards: ({ cards }) => ({ visibleCards: cards }),
    collectSubtreeCardIds: () => new Set(),
    cardParentIds,
    buildCardHtml,
    escapeHtml: value => String(value ?? ''),
    messageMarkup,
    statusText,
    formatFileSize: value => `${value || 0} B`,
    bindCardEvents,
    renderConnectors: () => renderTrace.push({ type: 'connectors' }),
    onBeforeRender: () => renderTrace.push({ type: 'renderer-before' }),
    onAfterRender: () => renderTrace.push({ type: 'renderer-after' }),
  });

  const getLive = id => {
    const item = live.get(id);
    assert.ok(item, `live card ${id} must be rendered`);
    return item;
  };
  const dispatchInput = (id, value) => {
    const item = getLive(id);
    item.input.value = value;
    item.input.dispatchEvent({ type: 'input' });
    // This assertion is deliberately before arrange: it proves that the
    // fixture dispatched the same input event that updates production card.draft.
    assert.equal(state.cards.find(card => card.id === id)?.draft, value,
      `真实 input 事件必须先把 ${id}.draft 更新为新值`);
    return item.input.lastDispatchPromise;
  };
  const clickArrange = async () => {
    arrangeButton.dispatchEvent({ type: 'click' });
    await arrangeButton.lastDispatchPromise;
  };
  const clickArrangeSync = () => arrangeButton.dispatchEvent({ type: 'click' });
  const resolveNextModel = value => {
    const resolve = modelRuns.shift();
    assert.equal(typeof resolve, 'function', 'send must reach the offline model boundary');
    resolve(value);
  };
  const sendThroughLiveButton = async (id, text) => {
    dispatchInput(id, text);
    const item = getLive(id);
    item.send.dispatchEvent({ type: 'click' });
    await tick();
    assert.equal(modelRuns.length, 1, 'send click must start exactly one deferred model call');
    resolveNextModel({ text: 'ROOT_ANSWER' });
    await item.send.lastDispatchPromise;
  };

  return {
    doc,
    session,
    state,
    activeRequests,
    live,
    renderTrace,
    snapshots,
    notifications,
    modelRuns,
    metrics: doc.metrics,
    get drainCalls() { return drainCalls; },
    get bindCalls() { return bindCalls; },
    renderer,
    canvasView,
    canvasActions,
    rootRenderCards,
    getLive,
    dispatchInput,
    clickArrange,
    clickArrangeSync,
    sendThroughLiveButton,
    replaceCards(cards) { state.cards = cards; },
    switchSession(cards, nextGeneration) {
      state.session.generation = nextGeneration;
      state.cards = cards;
      rootRenderCards(false);
    },
  };
}

async function makeSentChildArrangeFixture() {
  const root = cardOf('root', { draft: undefined });
  delete root.draft;
  const h = createArrangeHarness({ cards: [root] });
  h.rootRenderCards();
  await h.sendThroughLiveButton(root.id, 'ROOT_QUESTION');
  const child = h.canvasActions.createBranchCard(root, { autoFocus: true });
  assert.ok(child, '真实 createBranchCard 必须创建已发送子卡的前置对象');
  await h.sendThroughLiveButton(child.id, 'CHILD_QUESTION');
  assert.equal(Object.hasOwn(child, 'draft'), false, '子卡发送接受后不应残留旧 draft');
  assert.equal(h.getLive(child.id).input.value, '', '子卡发送完成后的 live input 应为空');
  return { h, root, child };
}

test('root 真实源码必须把整理 layout-only 两参完整转发到 renderer', () => {
  const rootForwarding = /function renderCards\s*\(\s*preserve\s*=\s*true\s*,\s*([A-Za-z_$][\w$]*)(?:\s*=\s*\{\})?\s*\)\s*\{\s*renderer\.renderCards\s*\(\s*preserve\s*,\s*\1\s*\)/s;
  assert.match(panelSource, rootForwarding,
    'panel.js 的 root renderCards wrapper 不得丢弃第二个 layout options 参数');

  const canvasStart = panelSource.indexOf('const canvasViewController = createCanvasViewController({');
  assert.ok(canvasStart >= 0, 'panel.js 必须存在真实 canvas view factory 接线');
  const canvasBlock = panelSource.slice(canvasStart, panelSource.indexOf('\n});', canvasStart) + 4);
  const viewForwarding = /renderCards\s*:\s*\(\s*preserve\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*renderCards\s*\(\s*preserve\s*,\s*\1\s*\)/s;
  assert.match(canvasBlock, viewForwarding,
    'panel.js 的 canvas view wrapper 不得把 layout-only options 截断');
});

test('layout-only：已发送子卡保留同一 card/input、焦点选区、纯空白 draft，且不 drain/rebind', async () => {
  const { h, child } = await makeSentChildArrangeFixture();
  const draft = '  \n\t';
  await h.dispatchInput(child.id, draft);

  const before = h.getLive(child.id);
  before.input.focus();
  before.input.setSelectionRange(1, 3);
  const beforeMetrics = { ...h.metrics };
  const beforeDrainCalls = h.drainCalls;
  const beforeBindCalls = h.bindCalls;
  const beforeBefore = h.renderTrace.filter(item => item.type === 'renderer-before').length;
  const beforeAfter = h.renderTrace.filter(item => item.type === 'renderer-after').length;
  const beforeConnectors = h.renderTrace.filter(item => item.type === 'connectors').length;
  const arrangeStart = h.renderTrace.length;

  await h.clickArrange();

  const arrangeIndex = h.renderTrace.findIndex((item, index) => index >= arrangeStart && item.type === 'arrange-click');
  const nextRender = h.renderTrace.slice(arrangeIndex + 1).find(item => item.type === 'root-render');
  assert.ok(arrangeIndex >= arrangeStart, '整理必须经过真实 toolbar click 边界');

  const after = h.getLive(child.id);
  assert.ok(after.root === before.root, '整理不得销毁已发送子卡 card DOM');
  assert.ok(after.input === before.input, '整理不得替换已发送子卡 input DOM');
  assert.deepEqual(nextRender?.options, { layoutOnly: true },
    'autoTidyLayout 必须通过 root 传入 layout-only mode');
  assert.strictEqual(after.root.__boundCard, child, '保留的 card 节点必须仍绑定当前活对象');
  assert.strictEqual(after.input.__boundCard, child, '保留的 input 节点必须仍绑定当前活对象');
  assert.equal(child.draft, draft, '纯空格/换行 draft 必须逐字同步回活 card');
  assert.equal(after.input.value, draft, 'layout-only 不得改写 input.value');
  assert.equal(after.root.style.left, `${child.x}px`, '保留节点必须同步新的 x geometry');
  assert.equal(after.root.style.top, `${child.y}px`, '保留节点必须同步新的 y geometry');
  assert.strictEqual(h.doc.activeElement, before.input, 'layout-only 不得夺走输入焦点');
  assert.equal(after.input.selectionStart, 1, 'layout-only 不得改变 selectionStart');
  assert.equal(after.input.selectionEnd, 3, 'layout-only 不得改变 selectionEnd');

  assert.equal(h.drainCalls, beforeDrainCalls, 'layout-only 不得 drain 卡片 cleanup');
  assert.equal(h.bindCalls, beforeBindCalls, 'layout-only 不得重复绑定卡片事件');
  assert.deepEqual(h.metrics, beforeMetrics,
    'layout-only 不得清空 innerHTML、append 节点、写 input.value、focus 或 selection');
  assert.equal(h.renderTrace.filter(item => item.type === 'renderer-before').length, beforeBefore + 1,
    'layout-only 必须保留 renderer before hook');
  assert.equal(h.renderTrace.filter(item => item.type === 'renderer-after').length, beforeAfter + 1,
    'layout-only 必须保留 renderer after hook');
  assert.equal(h.renderTrace.filter(item => item.type === 'connectors').length, beforeConnectors + 1,
    'layout-only 必须继续刷新连线');
});

test('layout-only 后同一 input 仍能写 draft，点击发送只触发一次 handler', async () => {
  const { h, child } = await makeSentChildArrangeFixture();
  const before = h.getLive(child.id);
  await h.dispatchInput(child.id, 'BEFORE_LAYOUT_DRAFT');
  const beforeBindCalls = h.bindCalls;
  const arrangeStart = h.renderTrace.length;
  await h.clickArrange();
  const arrangeIndex = h.renderTrace.findIndex((item, index) => index >= arrangeStart && item.type === 'arrange-click');
  const nextRender = h.renderTrace.slice(arrangeIndex + 1).find(item => item.type === 'root-render');
  assert.deepEqual(nextRender?.options, { layoutOnly: true },
    '发送后继续编辑也必须走 layout-only 整理路径');
  const afterArrange = h.getLive(child.id);
  assert.strictEqual(afterArrange.input, before.input, '发送前置条件必须仍是同一 input 节点');
  assert.equal(h.bindCalls, beforeBindCalls, 'layout-only 整理期间不得重复绑定 handler');

  await h.sendThroughLiveButton(child.id, 'AFTER_LAYOUT_SEND');
  assert.equal(h.renderTrace.filter(item => item.type === 'model-boundary' && item.request.cardId === child.id).length, 2,
    '子卡首次发送与整理后发送各一次，不能因重绘重复触发 handler');
  assert.equal(Object.hasOwn(child, 'draft'), false, '接受边界后第二次发送仍必须清除 draft');
});

test('IME compositionstart→整理→compositionend：layout-only 保留同一输入节点且 geometry 正常', async () => {
  const card = cardOf('ime-card');
  const h = createArrangeHarness({ cards: [card] });
  h.rootRenderCards();
  await h.dispatchInput(card.id, 'IME_DRAFT');
  const before = h.getLive(card.id);
  before.input.focus();
  before.input.setSelectionRange(2, 5);
  const beforeMetrics = { ...h.metrics };
  const beforeDrainCalls = h.drainCalls;
  const beforeBindCalls = h.bindCalls;
  const arrangeStart = h.renderTrace.length;

  h.renderer.onCompositionStart({ target: before.input });
  h.clickArrangeSync();
  const arrangeIndex = h.renderTrace.findIndex((item, index) => index >= arrangeStart && item.type === 'arrange-click');
  const nextRender = h.renderTrace.slice(arrangeIndex + 1).find(item => item.type === 'root-render');
  const afterArrange = h.getLive(card.id);
  assert.ok(afterArrange.input === before.input, 'IME 期间整理不得替换正在组词的 input');
  assert.strictEqual(afterArrange.root, before.root, 'IME 期间整理不得替换 card DOM');
  assert.equal(afterArrange.root.style.left, `${card.x}px`, 'IME 期间也必须立即同步 x geometry');
  assert.equal(afterArrange.root.style.top, `${card.y}px`, 'IME 期间也必须立即同步 y geometry');
  assert.strictEqual(h.doc.activeElement, before.input, 'IME 期间焦点必须保持');
  assert.equal(afterArrange.input.selectionStart, 2);
  assert.equal(afterArrange.input.selectionEnd, 5);

  h.renderer.onCompositionEnd();
  const afterComposition = h.getLive(card.id);
  assert.ok(afterComposition.input === before.input,
    'compositionend 不应把 layout-only 已保留的 input 再次拆掉');
  assert.ok(afterComposition.root === before.root,
    'compositionend 不应把 layout-only 已保留的 card 再次拆掉');
  assert.deepEqual(nextRender?.options, { layoutOnly: true },
    'IME 期间整理也必须通过 layout-only mode，不得退回 defer full render');
  assert.deepEqual(h.metrics, beforeMetrics, 'IME layout-only 前后不得发生 full render DOM 操作');
  assert.equal(h.drainCalls, beforeDrainCalls);
  assert.equal(h.bindCalls, beforeBindCalls);
});

test('layout-only 结构不完整必须安全 full fallback，不污染旧 DOM', async () => {
  const first = cardOf('missing-first');
  const second = cardOf('missing-second');
  const h = createArrangeHarness({ cards: [first, second] });
  h.rootRenderCards();
  await h.dispatchInput(first.id, 'KEEP_FIRST_DRAFT');
  const oldFirst = h.getLive(first.id);
  const oldSecond = h.getLive(second.id);
  const beforeDrainCalls = h.drainCalls;
  const beforeBindCalls = h.bindCalls;
  oldSecond.root.remove();

  await h.clickArrange();
  const newFirst = h.getLive(first.id);
  const newSecond = h.getLive(second.id);
  assert.notStrictEqual(newFirst.root, oldFirst.root, '缺失可见卡节点时必须走 full fallback');
  assert.notStrictEqual(newFirst.input, oldFirst.input, 'fallback 必须重建完整结构而非留下半棵旧树');
  assert.ok(h.drainCalls > beforeDrainCalls, 'full fallback 必须执行原 cleanup drain');
  assert.ok(h.bindCalls > beforeBindCalls, 'full fallback 必须重新绑定完整卡片事件');
  assert.equal(first.draft, 'KEEP_FIRST_DRAFT', 'fallback 的 preserve 仍须回收当前 input draft');
  assert.equal(newFirst.input.value, 'KEEP_FIRST_DRAFT');
  assert.ok(newSecond.root.parentNode === h.doc.body, 'fallback 必须补回缺失的第二张活卡');
  assert.notStrictEqual(newSecond.root, oldSecond.root, 'fallback 不得重新挂回已脱离旧 DOM');
});

test('真实发送→真实分支→真实 input→点击整理：发送后的子卡新草稿保留', async () => {
  const root = cardOf('root', { draft: undefined });
  delete root.draft;
  const h = createArrangeHarness({ cards: [root] });
  h.rootRenderCards();
  assert.equal(h.getLive('root').input.value, '', '初始 root 不应伪造已输入值');

  await h.sendThroughLiveButton('root', 'ROOT_QUESTION');
  assert.equal(Object.hasOwn(root, 'draft'), false, '接受边界后 root.draft 必须清除');
  assert.equal(root.messages.at(-1).text, 'ROOT_ANSWER');

  // This branch is created by the production canvas-actions factory, not by a
  // hand-built card. Its createBranchCard call also performs a real redraw.
  const child = h.canvasActions.createBranchCard(root, { autoFocus: true });
  assert.ok(child, '真实 createBranchCard 必须创建子卡');
  assert.equal(child.parentId, root.id);
  assert.equal(h.getLive(child.id).input.value, '', '子卡首绘输入为空');

  // Reproduce the reported lifecycle: the child itself carries a legal,
  // 29-byte parsed attachment and is rendered before it sends.
  const attachmentContent = '01234567890123456789012345678';
  assert.equal(Buffer.byteLength(attachmentContent, 'utf8'), 29);
  const childAttachment = {
    name: 'child-evidence.txt',
    size: 29,
    extension: '.txt',
    charCount: attachmentContent.length,
    lineCount: 1,
    content: attachmentContent,
    preview: attachmentContent,
  };
  child.stagedAttachments = [childAttachment];
  h.rootRenderCards();
  assert.ok(h.getLive(child.id).root.querySelector('.staged-attachments-bar'),
    '合法 stagedAttachments 必须经过真实 renderer/cardHtml 进入新 DOM');

  const childInputBeforeSend = h.getLive(child.id).input;
  await h.sendThroughLiveButton(child.id, 'CHILD_QUESTION_WITH_ATTACHMENT');
  const childBoundary = h.renderTrace.filter(item => item.type === 'model-boundary').at(-1);
  assert.equal(childBoundary?.request?.cardId, child.id, 'child send 必须真正到达模型边界');
  const childWireText = childBoundary.request.messages.map(message => message.content).join('\n');
  assert.match(childWireText, /child-evidence\.txt/);
  assert.match(childWireText, new RegExp(attachmentContent));
  const acceptedChildUser = [...child.messages].reverse().find(message => message.role === 'user');
  assert.deepEqual(acceptedChildUser?.attachments, [childAttachment],
    'child accepted user DTO 必须保留附件正文');
  assert.equal(Object.hasOwn(child, 'draft'), false,
    'child accepted 后 draft 必须清除');
  assert.deepEqual(child.stagedAttachments, [],
    'child accepted 后暂存附件必须清除');
  assert.equal(h.getLive(child.id).input.value, '',
    'child accepted/完成后的新 DOM input 必须清空');
  assert.notStrictEqual(h.getLive(child.id).input, childInputBeforeSend,
    'child 完成后整理前必须确实使用新 DOM input');

  // The next draft is entered only after the child itself completed sending.
  await h.dispatchInput(child.id, 'AFTER_SEND_DRAFT');
  assert.equal(child.draft, 'AFTER_SEND_DRAFT');
  const beforeArrangeRenderCount = h.renderTrace.filter(item => item.type === 'renderer-before').length;
  await h.clickArrange();

  const arrangeIndex = h.renderTrace.findIndex(item => item.type === 'arrange-click');
  const nextRender = h.renderTrace.slice(arrangeIndex + 1).find(item => item.type === 'root-render');
  assert.ok(arrangeIndex >= 0, '必须经过整理按钮 click 边界');
  assert.deepEqual(nextRender?.preserve, true, 'root wrapper 未显式传参时必须保持 preserve=true');
  assert.ok(h.renderTrace.filter(item => item.type === 'renderer-before').length > beforeArrangeRenderCount,
    '整理 click 必须真正进入 renderer/cardHtml 重建');
  assert.equal(child.draft, 'AFTER_SEND_DRAFT', '整理后 live child.draft 不得丢失');
  assert.equal(h.getLive(child.id).input.value, 'AFTER_SEND_DRAFT',
    '整理后新建 input 必须从 live draft 恢复');
});

test('非发送场景与其他卡：宽高、附件和不同卡草稿一起经过真实整理仍保留', async () => {
  const attachments = [{ name: 'evidence.txt', size: 17, content: 'EVIDENCE' }];
  const root = cardOf('unsent-root', { width: 720, height: 900 });
  const other = cardOf('other-card', {
    x: 800,
    y: 520,
    width: 720,
    height: 900,
    stagedAttachments: attachments,
  });
  const h = createArrangeHarness({ cards: [root, other] });
  h.rootRenderCards();

  const largeDraft = `LARGE_DRAFT_${'x'.repeat(4096)}`;
  await h.dispatchInput(root.id, largeDraft);
  await h.dispatchInput(other.id, 'OTHER_CARD_DRAFT');
  assert.equal(root.draft, largeDraft);
  assert.equal(other.draft, 'OTHER_CARD_DRAFT');
  await h.clickArrange();

  assert.equal(root.draft, largeDraft);
  assert.equal(other.draft, 'OTHER_CARD_DRAFT');
  assert.equal(h.getLive(root.id).input.value, largeDraft);
  assert.equal(h.getLive(other.id).input.value, 'OTHER_CARD_DRAFT');
  assert.strictEqual(other.stagedAttachments, attachments, '整理不得替换其他卡附件数组');
  assert.equal(other.stagedAttachments[0].content, 'EVIDENCE');
  assert.equal(other.width, 720, '整理只改坐标，不得损坏自定义宽度');
  assert.equal(other.height, 900, '整理只改坐标，不得损坏自定义高度');
});

test('同 ID 换活对象负控：整理不得把旧 DOM 输入污染新卡', async () => {
  const oldCard = cardOf('same-id');
  const h = createArrangeHarness({ cards: [oldCard] });
  h.rootRenderCards();
  await h.dispatchInput(oldCard.id, 'OLD_OBJECT_DRAFT');
  const oldLive = h.getLive(oldCard.id);
  const beforeDrainCalls = h.drainCalls;

  const replacement = cardOf('same-id');
  h.replaceCards([replacement]);
  // Deliberately leave the old DOM mounted. The renderer identity guard must
  // skip its input during the preserve pass, so this is not a false clean
  // result caused by rendering the replacement first.
  await h.clickArrange();

  assert.equal(Object.hasOwn(replacement, 'draft'), false,
    '同 ID 新活对象不应继承旧 card.draft');
  const replacementLive = h.getLive(replacement.id);
  assert.equal(replacementLive.input.value, '',
    '同 ID 新活对象不应继承旧 DOM input.value');
  assert.notEqual(replacementLive.card, oldCard);
  assert.notStrictEqual(replacementLive.root, oldLive.root,
    '同 ID 活对象替换必须放弃旧节点并走 full fallback');
  assert.ok(h.drainCalls > beforeDrainCalls,
    '同 ID 活对象替换必须执行原 cleanup guard，而不是 layout-only 复用');
});

test('切会话负控：代际切换用 preserve=false，后续整理也不保留旧输入', async () => {
  const oldCard = cardOf('session-card');
  const h = createArrangeHarness({ cards: [oldCard], generation: 1 });
  h.rootRenderCards();
  await h.dispatchInput(oldCard.id, 'OLD_SESSION_DRAFT');
  const oldLive = h.getLive(oldCard.id);

  const newCard = cardOf('session-card');
  h.switchSession([newCard], 2);
  assert.equal(h.session.generation, 2);
  const newLive = h.getLive(newCard.id);
  assert.notStrictEqual(newLive.root, oldLive.root, '切会话必须先 full replace 旧 card DOM');
  assert.notStrictEqual(newLive.input, oldLive.input, '切会话不得复用旧 input DOM');
  assert.equal(newLive.input.value, '', '切会话的 preserve=false 必须清掉旧输入');
  assert.equal(Object.hasOwn(newCard, 'draft'), false);

  await h.clickArrange();
  assert.equal(h.getLive(newCard.id).input.value, '', '切会话后整理不得回灌旧输入');
  assert.equal(Object.hasOwn(newCard, 'draft'), false);
});

// --- 按钮夺焦：整理按钮的 mousedown 会把焦点从输入框抢走，组合输入当场丢失 ---

test('整理按钮源码合同：mousedown 上有定向焦点保护，点击仍照常触发整理', () => {
  assert.match(panelSource, /listen\(btnAutoTidy, 'mousedown'/, '整理按钮必须有 mousedown 保护');
  assert.match(
    panelSource,
    /shouldPreserveCardInputFocus\(event, document\.activeElement\)/,
    '必须用共享判定，而不是就地写一份选择器判断',
  );
  const guardBlock = panelSource.slice(
    panelSource.indexOf("listen(btnAutoTidy, 'mousedown'"),
    panelSource.indexOf("listen(btnAutoTidy, 'click'"),
  );
  assert.match(guardBlock, /event\.preventDefault\(\)/, '命中时只做一件事：拦住这次焦点迁移');
  assert.doesNotMatch(guardBlock, /autoTidyLayout\(\)/, 'mousedown 只保护焦点，整理仍由 click 触发');
  assert.match(panelSource, /listen\(btnAutoTidy, 'click', \(\) => \{\s*autoTidyLayout\(\);/, '点击仍然执行整理');
});

test('焦点判定：只拦"主键按下 + 焦点在卡片输入框"这一种情况', async () => {
  const { shouldPreserveCardInputFocus } = await load('panel-canvas-view.js');
  const cardInput = { matches: selector => selector === '.card-input' };
  const searchInput = { matches: selector => selector === '.search-input' };
  assert.equal(shouldPreserveCardInputFocus({ button: 0 }, cardInput), true);
  assert.equal(shouldPreserveCardInputFocus({ button: 1 }, cardInput), false, '中键/右键不拦');
  assert.equal(shouldPreserveCardInputFocus({ button: 2 }, cardInput), false);
  assert.equal(shouldPreserveCardInputFocus({ button: 0 }, searchInput), false, '别的输入框不归它管');
  assert.equal(shouldPreserveCardInputFocus({ button: 0 }, null), false, '没有焦点时不拦');
  assert.equal(shouldPreserveCardInputFocus({ button: 0 }, { matches: 'not-a-function' }), false);
  assert.equal(shouldPreserveCardInputFocus(null, cardInput), false);
});

test('因果对照：不拦焦点则组合输入被打断，拦下则原样保留', async () => {
  const { shouldPreserveCardInputFocus } = await load('panel-canvas-view.js');
  // 最小模型复现浏览器默认行为：按钮拿到焦点 → 输入框 blur → preedit 丢失
  const simulate = (guarded) => {
    const state = { focus: 'card-input', preedit: 'ni hao', prevented: false };
    const event = { button: 0, preventDefault() { state.prevented = true; } };
    const active = { matches: selector => state.focus === 'card-input' && selector === '.card-input' };
    if (guarded && shouldPreserveCardInputFocus(event, active)) event.preventDefault();
    if (!state.prevented) {
      state.focus = 'button';
      state.preedit = '';
    }
    return state;
  };
  const unguarded = simulate(false);
  assert.equal(unguarded.focus, 'button');
  assert.equal(unguarded.preedit, '', '没有保护时组合输入确实会丢，这就是被修的那个现象');

  const guarded = simulate(true);
  assert.equal(guarded.focus, 'card-input', '焦点留在输入框');
  assert.equal(guarded.preedit, 'ni hao', '未提交的组词内容还在');
});

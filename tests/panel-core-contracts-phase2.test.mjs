import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentController } from '../ui/assets/panel-agents.js';
import { createBattleFlow } from '../ui/assets/panel-battle-flow.js';
import { createBridge } from '../ui/assets/panel-bridge.js';
import { createBridgeIntents } from '../ui/assets/panel-bridge-intents.js';
import { createBridgeSend } from '../ui/assets/panel-bridge-send.js';
import { createSessionState } from '../ui/assets/panel-session-state.js';
import { createMergeController } from '../ui/assets/panel-merge.js';
import { createSearchController } from '../ui/assets/panel-search-controller.js';
import { createCanvasActions } from '../ui/assets/panel-canvas-actions.js';
import { createCanvasViewController } from '../ui/assets/panel-canvas-view.js';
import { createRenderer } from '../ui/assets/panel-renderer.js';
import { cardContentSignature, canReuseCardElement } from '../ui/assets/panel-render-diff.js';
import { createCardGestures } from '../ui/assets/panel-card-gestures.js';
import { createDocumentUi } from '../ui/assets/panel-document-ui.js';
import { createCardEvents } from '../ui/assets/panel-card-events.js';

function spy(value) {
  const fn = (...args) => {
    fn.calls.push(args);
    return typeof value === 'function' ? value(...args) : value;
  };
  fn.calls = [];
  return fn;
}

function asyncSpy(value = undefined) {
  return async (...args) => value instanceof Function ? value(...args) : value;
}

function element() {
  return {
    open: false,
    hidden: false,
    disabled: false,
    style: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function documentRef() {
  return { getElementById: () => null, createElement: element, addEventListener() {} };
}

function baseState() {
  const card = { id: 'card-1', parentId: null, messages: [] };
  let cards = [card];
  const session = { generation: 1, state: { ready: true, busy: false, activeId: 'session-1' } };
  const reads = { getCards: 0, getAgent: 0, bridgeRequest: 0, sessionController: 0 };
  return { card, session, reads, getCards: () => { reads.getCards++; return cards; }, setCards: next => { cards = next; } };
}

function makeAgent() {
  const state = baseState();
  const agent = { id: 'agent-1', name: 'Agent', model: 'model', provider: 'provider' };
  const deps = {
    getAgent: () => { state.reads.getAgent++; return agent; },
    setAgent: spy(),
    getReasoningEffort: spy(null),
    setReasoningEffort: spy(),
    getActiveAgentDisplay: () => element(),
    activeAgentDisplay: element(),
    isBusy: () => false,
    renderCards: spy(),
    scheduleSave: spy(),
    isDisposed: () => false,
    hana: {},
    requestHost: asyncSpy({ json: async () => ({ agents: [] }) }),
    abortable: async promise => promise,
    getSignal: () => null,
    storage: null,
  };
  return {
    deps,
    reads: () => state.reads.getAgent,
    required: ['getAgent', 'setAgent', 'getReasoningEffort', 'setReasoningEffort', 'renderCards', 'scheduleSave'],
    optionalFunctionTypes: ['isBusy'],
  };
}

function makeBridge() {
  const state = baseState();
  const deps = {
    documentRef: () => documentRef(), windowRef: null, hana: {},
    bridgeRequest: async (...args) => { state.reads.bridgeRequest++; return {}; },
    safeDetail: String, escapeHtml: String, flashMessage: spy(),
    canMutateCanvas: () => true, getGeneration: () => 1,
    createBridgeDocCard: spy(), flushSession: asyncSpy(), getCanvasId: () => 'canvas-1',
    getOwnedClaims: () => new Set(), bindBridgeSend: spy(), pollBridgeIntents: asyncSpy(),
    addCleanup: spy(), setIntervalRef: spy(() => 1), clearIntervalRef: spy(),
    listen: spy(),
    bridgeDialogEl: element(), bridgeSessionSelect: element(), bridgeKindSelect: element(),
    bridgeLeafSelect: element(), bridgeLeafField: element(), bridgePreviewEl: element(),
    bridgeErrorEl: element(), bridgeImportBtn: element(), bridgeActiveHint: element(),
  };
  return {
    deps,
    reads: () => state.reads.bridgeRequest,
    required: ['bridgeRequest', 'createBridgeDocCard', 'flushSession', 'getGeneration', 'canMutateCanvas', 'getCanvasId'],
  };
}

function makeBridgeSend() {
  const state = baseState();
  const deps = {
    bridgeRequest: async (...args) => { state.reads.bridgeRequest++; return {}; },
    safeDetail: String, escapeHtml: String, flashMessage: spy(),
    getCards: state.getCards, getSelectedCardId: () => 'card-1',
    getBridgeTargetSessionId: () => null, listen: spy(), BlobRef: null,
    isDisposed: () => false,
    // DOM is intentionally omitted: it is an optional late-bound surface for this factory.
  };
  return {
    deps,
    reads: () => state.reads.bridgeRequest,
    required: ['bridgeRequest'],
    optionalFunctionTypes: ['getCards', 'getSelectedCardId', 'getBridgeTargetSessionId', 'listen', 'flashMessage'],
  };
}

function makeSessionState() {
  const state = baseState();
  const deps = {
    documentRef: documentRef(), getCards: state.getCards, setCards: state.setCards,
    getView: () => ({ x: 0, y: 0, scale: 1 }), getSelectedCardId: () => null,
    getCurrentAgent: () => ({ id: 'agent-1', name: 'Agent', model: 'model', provider: 'provider' }),
    getReasoningEffort: () => null, getIsDisposed: () => false,
    initialCards: () => [], clearRemovedCardArchive: spy(), restoreAgent: spy(),
    updateHeaderStatus: spy(), updateTransform: spy(), renderCards: spy(), clearHistory: spy(),
    recordSnapshot: spy(), abortAllDocumentTasks: spy(), cancelAllRequests: spy(),
    getSessionController: () => state.session, getDeleteIntent: () => null,
    bus: { postMessage: spy() }, canvasId: 'canvas-1',
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'getCards', 'setCards', 'getView', 'getSelectedCardId', 'getCurrentAgent',
      'initialCards', 'clearRemovedCardArchive', 'restoreAgent', 'updateHeaderStatus',
      'updateTransform', 'renderCards', 'clearHistory', 'recordSnapshot',
      'abortAllDocumentTasks', 'cancelAllRequests', 'getSessionController', 'getIsDisposed', 'bus', 'canvasId',
    ],
  };
}

function makeBattle() {
  const state = baseState();
  const deps = {
    battleDialog: { showModal() {}, close() {} }, battlePromptInput: { value: '', focus() {} },
    battleAgentsList: { appendChild() {}, children: [], innerHTML: '' }, battleSelectedCount: element(),
    battleDialogError: element(), btnBattleClose: element(), btnBattleCancel: element(),
    btnBattleSubmit: element(), btnUseLastPrompt: element(), listen: spy(), documentRef: documentRef(),
    getAgentReasoningEffort: () => null, getAvailableAgents: () => [], loadAvailableAgents: asyncSpy([]),
    chainIsBusy: () => false, getCards: state.getCards, getSession: () => state.session,
    getIsDisposed: () => false, canMutateCanvas: () => true, cardHasParent: () => false,
    calculateBranchYPositions: () => [0], fitViewportToCluster: spy(), renderCards: spy(),
    scheduleSave: spy(), recordSnapshot: spy(), getSelectedCardId: () => null,
    sendCardPrompt: asyncSpy(), uniqueId: prefix => `${prefix}-1`, cleanups: new Set(),
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'listen', 'getAgentReasoningEffort', 'getAvailableAgents', 'loadAvailableAgents',
      'chainIsBusy', 'getCards', 'getSession', 'getIsDisposed', 'canMutateCanvas',
      'cardHasParent', 'calculateBranchYPositions', 'fitViewportToCluster', 'renderCards',
      'scheduleSave', 'recordSnapshot', 'getSelectedCardId', 'sendCardPrompt', 'uniqueId',
    ],
  };
}

function makeMerge() {
  const state = baseState();
  const deps = {
    multiSelectedCardIds: new Set(), getCards: state.getCards, getSelectedCardId: () => null,
    canMutateCanvas: () => true, isDisposed: () => false, chainIsBusy: () => false,
    calculateBranchYPositions: () => [0], fitViewportToCluster: spy(), renderCards: spy(),
    scheduleSave: spy(), recordSnapshot: spy(), sendCardPrompt: asyncSpy(), reportContextIssue: spy(), uniqueId: () => 'merge-1',
    outputFor: message => ({ body: message?.text || '' }), documentRef: documentRef(),
    listen: spy(), cleanups: new Set(),
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'multiSelectedCardIds', 'getCards', 'getSelectedCardId', 'canMutateCanvas', 'chainIsBusy',
      'calculateBranchYPositions', 'fitViewportToCluster', 'renderCards', 'scheduleSave',
      'recordSnapshot', 'sendCardPrompt', 'reportContextIssue',
    ],
    optionalFunctionTypes: ['isDisposed', 'uniqueId', 'outputFor'],
  };
}

function makeSearch() {
  const state = baseState();
  const deps = {
    getCards: state.getCards, getDocumentRef: () => documentRef(), getIsDisposed: () => false,
    selectCard: spy(), ensureCardInView: spy(), findCardsByKeyword: spy([]), getNextMatchIndex: spy(0),
    bindSearchBarController: spy(() => ({ updateCounter: spy() })),
    searchBarEl: null, searchInputEl: null, counterEl: null, btnPrev: null, btnNext: null, btnClose: null,
    listen: spy(), setTimeoutRef: callback => setTimeout(callback, 0), clearTimeoutRef: clearTimeout,
    trackTimer: spy(), untrackTimer: spy(),
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'getCards', 'getIsDisposed', 'selectCard', 'ensureCardInView',
      'findCardsByKeyword', 'getNextMatchIndex', 'bindSearchBarController', 'listen',
      'setTimeoutRef', 'clearTimeoutRef', 'trackTimer', 'untrackTimer',
    ],
  };
}

function makeActions() {
  const state = baseState();
  const deps = {
    getCards: state.getCards, setCards: state.setCards, getSelectedCardId: () => null,
    setSelectedCardId: spy(), multiSelectedCardIds: new Set(), canMutateCanvas: () => true,
    chainIsBusy: () => false, isBusy: () => false, isModalOpen: () => false,
    abortActiveRequest: spy(), abortDocumentTasksFor: spy(), calculateBranchYPositions: () => [0],
    renderCards: spy(), scheduleSave: spy(), recordSnapshot: spy(), selectCard: spy(),
    ensureCardInView: spy(), focusCardInViewport: spy(), flashMessage: spy(),
    getSessionController: () => { state.reads.sessionController++; return state.session; },
    sessionController: state.session, initialSnapshot: () => ({}), uniqueId: () => 'card-1',
    isDisposed: () => false, extractDocumentFile: asyncSpy({ ok: false }),
  };
  return {
    deps,
    reads: () => state.reads.getCards + state.reads.sessionController,
    required: [
      'getCards', 'setCards', 'getSelectedCardId', 'setSelectedCardId', 'canMutateCanvas',
      'chainIsBusy', 'abortActiveRequest', 'abortDocumentTasksFor',
      'calculateBranchYPositions', 'renderCards', 'scheduleSave', 'recordSnapshot',
      'extractDocumentFile', 'initialSnapshot',
    ],
    alternatives: ['getSessionController', 'sessionController'],
    alternativeProvidedTypeCases: [{ key: 'getSessionController', value: 'bad' }],
    optionalFunctionTypes: ['uniqueId'],
    optionalValueTypes: { multiSelectedCardIds: {} },
    optionalAbsence: ['multiSelectedCardIds', 'uniqueId'],
  };
}

function makeView() {
  const state = baseState();
  const deps = {
    getCards: state.getCards, getSelectedCardId: () => null, setSelectedCardId: spy(),
    view: { x: 0, y: 0, scale: 1 }, multiSelectedCardIds: new Set(), surface: element(),
    viewport: element(), zoomText: element(), connectorsSvg: element(), btnZoomIn: element(), btnZoomOut: element(),
    getIsSpacePressed: () => false, canMutateCanvas: () => true, renderCards: spy(), scheduleSave: spy(),
    recordSnapshot: spy(), clearMultiSelect: spy(), isDisposed: () => false, listen: spy(),
    later: spy(), documentRef: documentRef(), windowRef: {},
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'getCards', 'getSelectedCardId', 'setSelectedCardId', 'canMutateCanvas',
      'renderCards', 'scheduleSave', 'recordSnapshot', 'clearMultiSelect',
    ],
  };
}

function makeRenderer() {
  const state = baseState();
  const deps = {
    documentRef: documentRef(), getCardsLayer: () => element(), getBadgeStats: () => null,
    getEmptyState: () => null, getIsDisposed: () => false, getCards: state.getCards,
    getSelectedCardId: () => null, getCurrentAgent: () => null, getSession: () => state.session,
    getMultiSelectedCardIds: () => new Set(), activeRequests: new Map(), chainIsBusy: () => false,
    cardContentSignature: spy('sig'), canReuseCardElement: () => false,
    drain: spy(), getCardCleanups: () => new Set(), computeVisibleCards: ({ cards }) => ({ visibleCards: cards }),
    collectSubtreeCardIds: () => new Set(), cardParentIds: () => [], buildCardHtml: () => '',
    escapeHtml: String, messageMarkup: spy(''), statusText: spy(''), formatFileSize: spy(''),
    bindCardEvents: spy(), renderConnectors: spy(),
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'cardContentSignature', 'canReuseCardElement',
      'activeRequests', 'getCards', 'getCardsLayer', 'getIsDisposed', 'getSelectedCardId', 'getCurrentAgent',
      'getSession', 'getMultiSelectedCardIds', 'chainIsBusy', 'drain', 'getCardCleanups',
      'computeVisibleCards', 'collectSubtreeCardIds', 'cardParentIds', 'buildCardHtml',
      'escapeHtml', 'messageMarkup', 'statusText', 'formatFileSize', 'bindCardEvents',
      'renderConnectors',
    ],
  };
}

function makeGestures() {
  const state = baseState();
  const deps = {
    listen: spy(() => () => {}), getSession: () => state.session, getCards: state.getCards,
    getView: () => ({ scale: 1 }), getIsSpacePressed: () => false, getSelectedCardId: () => null,
    getDocumentRef: () => documentRef(), renderConnectors: spy(), scheduleSave: spy(),
    recordSnapshot: spy(), getIsDisposed: () => false, getWindowRef: () => ({}),
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'listen', 'getSession', 'getCards', 'getView', 'getSelectedCardId',
      'getIsDisposed', 'renderConnectors', 'scheduleSave', 'recordSnapshot',
    ],
    optionalFunctionTypes: ['getIsSpacePressed'],
  };
}

function makeDocumentUi() {
  const state = baseState();
  const deps = {
    extractDocumentFile: asyncSpy({ ok: false }), flashMessage: spy(),
    canMutateCanvas: () => true, getCards: state.getCards, getSession: () => state.session,
    renderCards: spy(), scheduleSave: spy(), createDocumentCard: asyncSpy(),
    getView: () => ({ x: 0, y: 0, scale: 1 }), getViewport: () => element(),
    getDropIndicator: () => element(), getIsDisposed: () => false,
    later: spy(() => 1), cancelLater: spy(),
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'extractDocumentFile', 'flashMessage', 'canMutateCanvas', 'getCards', 'getSession',
      'renderCards', 'scheduleSave', 'createDocumentCard', 'getView',
      'getIsDisposed', 'later', 'cancelLater',
    ],
    optionalFunctionTypes: ['getViewport'],
  };
}

function makeEvents() {
  const state = baseState();
  const deps = {
    listen: spy(), getCardCleanups: () => new Set(), hana: { sessions: { focus: asyncSpy() } },
    flashMessage: spy(), safeDetail: String, getSession: () => state.session, getCards: state.getCards,
    getIsDisposed: () => false, getIsSpacePressed: () => false, getSelectedCardId: () => null,
    getDocumentRef: () => documentRef(), getNavigator: () => null,
    activeRequests: new Map(), paintMessage: spy(), ChatError: class extends Error {},
    chainIsBusy: () => false, openBattleDialog: asyncSpy(),
    documentUi: { attachFilesToCard: asyncSpy(false), removeStagedAttachment: spy(), hideDropIndicator: spy() },
    cardGestures: { beginCardDrag: spy(), bindResizeHandles: spy() },
    createBranchCard: spy(), closeCardHierarchy: spy(), cycleCardStatusStamp: spy(null),
    selectCard: spy(), toggleMultiSelectCard: spy(), clearMultiSelect: spy(), renderCards: spy(),
    renderConnectors: spy(), scheduleSave: spy(), recordSnapshot: spy(), canMutateCanvas: () => true,
    sendCardPrompt: asyncSpy(), cancelCardRequest: spy(), findCardAncestorChain: spy([]),
    cardParentIds: () => [], formatCardChainMarkdown: spy(''), buildTopologyOutline: spy(''), openContextPreview: () => {}, openRefManager: () => {},
  };
  return {
    deps,
    reads: () => state.reads.getCards,
    required: [
      'listen', 'getCardCleanups', 'flashMessage', 'safeDetail', 'getCards',
      'getIsDisposed', 'chainIsBusy', 'openBattleDialog', 'createBranchCard', 'closeCardHierarchy',
      'cycleCardStatusStamp', 'selectCard', 'toggleMultiSelectCard', 'clearMultiSelect',
      'renderCards', 'renderConnectors', 'scheduleSave', 'recordSnapshot', 'canMutateCanvas',
      'sendCardPrompt', 'cancelCardRequest', 'findCardAncestorChain', 'cardParentIds',
      'formatCardChainMarkdown', 'activeRequests', 'documentUi', 'cardGestures',
    ],
    optionalFunctionTypes: ['getIsSpacePressed', 'getDocumentRef', 'getNavigator'],
  };
}

function makeBridgeIntents() {
  const deps = {
    hana: {}, requestHost: asyncSpy({ json: async () => ({}) }), bridgeRequest: asyncSpy({ intents: [] }),
    canMutateCanvas: () => true, getGeneration: () => 1, getCanvasId: () => 'canvas-1', deliverIntent: asyncSpy(),
  };
  return { deps, reads: () => 0, required: ['canMutateCanvas', 'getGeneration', 'getCanvasId', 'deliverIntent'] };
}

const specs = [
  ['agents', createAgentController, makeAgent],
  ['bridge', createBridge, makeBridge],
  ['bridge-send', createBridgeSend, makeBridgeSend],
  ['bridge-intents', createBridgeIntents, makeBridgeIntents],
  ['session-state', createSessionState, makeSessionState],
  ['battle-flow', createBattleFlow, makeBattle],
  ['merge', createMergeController, makeMerge],
  ['search-controller', createSearchController, makeSearch],
  ['canvas-actions', createCanvasActions, makeActions],
  ['canvas-view', createCanvasViewController, makeView],
  ['renderer', createRenderer, makeRenderer],
  ['gestures', createCardGestures, makeGestures],
  ['document-ui', createDocumentUi, makeDocumentUi],
  ['card-events', createCardEvents, makeEvents],
];

test('bridge-send: optional card/target/listen/feedback surfaces may be absent when bridgeRequest is present', () => {
  assert.doesNotThrow(() => createBridgeSend({
    bridgeRequest: async () => ({ sessions: [] }),
  }));
});

test('core factories: one required business callback fails fast and late getter is not read at construction', () => {
  const issues = [];
  for (const [name, factory, make] of specs) {
    const valid = make();
    try {
      factory(valid.deps);
    } catch (error) {
      issues.push(`${name}: valid harness threw ${error?.message || error}`);
      continue;
    }
    if (valid.reads() !== 0) issues.push(`${name}: constructor read late getter`);

    for (const required of valid.required) {
      const missing = make().deps;
      delete missing[required];
      try {
        factory(missing);
      } catch (error) {
        if (!(error instanceof TypeError)) issues.push(`${name}: missing ${required} threw ${error?.constructor?.name || 'unknown'}`);
        continue;
      }
      issues.push(`${name}: missing ${required} did not throw`);
    }

    for (const optional of valid.optionalFunctionTypes || []) {
      const wrong = make().deps;
      wrong[optional] = 'wrong-type';
      try {
        factory(wrong);
      } catch (error) {
        if (!(error instanceof TypeError)) issues.push(`${name}: optional ${optional} wrong type threw ${error?.constructor?.name || 'unknown'}`);
        continue;
      }
      issues.push(`${name}: optional ${optional} wrong type did not throw`);
    }

    for (const [optional, wrongValue] of Object.entries(valid.optionalValueTypes || {})) {
      const wrong = make().deps;
      wrong[optional] = wrongValue;
      try {
        factory(wrong);
      } catch (error) {
        if (!(error instanceof TypeError)) issues.push(`${name}: optional ${optional} wrong value type threw ${error?.constructor?.name || 'unknown'}`);
        continue;
      }
      issues.push(`${name}: optional ${optional} wrong value type did not throw`);
    }

    for (const optional of valid.optionalAbsence || []) {
      const absent = make();
      delete absent.deps[optional];
      try {
        factory(absent.deps);
        if (absent.reads() !== 0) issues.push(`${name}: optional ${optional} absence path read late getter`);
      } catch (error) {
        issues.push(`${name}: optional ${optional} absence threw ${error?.message || error}`);
      }
    }

    for (const { key, value } of valid.alternativeProvidedTypeCases || []) {
      const bad = make().deps;
      bad[key] = value;
      try {
        factory(bad);
      } catch (error) {
        if (!(error instanceof TypeError)) issues.push(`${name}: invalid provided ${key} threw ${error?.constructor?.name || 'unknown'}`);
        continue;
      }
      issues.push(`${name}: invalid provided ${key} did not throw`);
    }

    if (valid.alternatives) {
      const [getterKey, legacyKey] = valid.alternatives;
      const neither = make().deps;
      delete neither[getterKey];
      delete neither[legacyKey];
      try {
        factory(neither);
        issues.push(`${name}: neither ${getterKey} nor ${legacyKey} did not throw`);
      } catch (error) {
        if (!(error instanceof TypeError)) issues.push(`${name}: neither session dependency threw ${error?.constructor?.name || 'unknown'}`);
      }
      for (const omit of [getterKey, legacyKey]) {
        const alternative = make();
        delete alternative.deps[omit];
        try {
          factory(alternative.deps);
          if (alternative.reads() !== 0) issues.push(`${name}: alternative ${omit} path read late getter`);
        } catch (error) {
          issues.push(`${name}: ${omit} omitted with alternative present threw ${error?.message || error}`);
        }
      }
    }
  }
  assert.deepEqual(issues, [], issues.join('; '));
});

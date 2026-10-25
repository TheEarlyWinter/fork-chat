import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatEngine } from '../ui/assets/panel-chat-engine.js';
import { createHistoryController } from '../ui/assets/panel-history-controller.js';
import { createSessionState } from '../ui/assets/panel-session-state.js';
import { createBridgeIntents } from '../ui/assets/panel-bridge-intents.js';

class TestChatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function engineDeps(overrides = {}) {
  const card = { id: 'card-1', parentId: null, messages: [] };
  const session = { generation: 1 };
  const deps = {
    hana: { id: 'hana-test' },
    runChat: async () => ({ text: '可见正文' }),
    ChatError: TestChatError,
    safeDetail: value => String(value),
    activeRequests: new Map(),
    getCards: () => [card],
    getSession: () => session,
    getAgent: () => ({ id: 'agent-1', name: 'Agent', provider: 'provider', model: 'model' }),
    getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null,
    buildContextPlan: (targetCard, { pendingUserMessage }) => ({
      messages: [{
        role: 'user',
        content: pendingUserMessage
          ? `context:${targetCard.id}|${pendingUserMessage.text}`
          : `context:${targetCard.id}`,
      }],
      errors: [],
      warnings: [],
      isRequestReady: true,
    }),
    reportContextIssue: () => {},
    getIsDisposed: () => false,
    canMutateCanvas: () => true,
    uniqueId: prefix => `${prefix}-1`,
    paintMessage: () => {},
    renderCards: () => {},
    scheduleSave: () => {},
    cardParentIds: current => (current?.parentId ? [current.parentId] : []),
  };
  return { deps: { ...deps, ...overrides }, card, session };
}

const requiredEngineFunctions = [
  'runChat', 'safeDetail', 'getCards', 'getSession', 'getAgent',
  'getReasoningEffort', 'getAgentReasoningEffort', 'buildContextPlan', 'reportContextIssue',
  'getIsDisposed', 'canMutateCanvas', 'uniqueId', 'paintMessage',
  'renderCards', 'scheduleSave', 'cardParentIds',
];

test('panel-chat-engine: missing required function dependencies fail at construction', () => {
  for (const key of requiredEngineFunctions) {
    const { deps } = engineDeps();
    delete deps[key];
    assert.throws(
      () => createChatEngine(deps),
      TypeError,
      `缺失 ${key} 时 createChatEngine 必须立即 TypeError`,
    );
  }
  assert.throws(() => createChatEngine({}), TypeError);

  const missingChatError = engineDeps();
  delete missingChatError.deps.ChatError;
  assert.throws(() => createChatEngine(missingChatError.deps), TypeError);

  const missingActiveRequests = engineDeps();
  delete missingActiveRequests.deps.activeRequests;
  assert.throws(() => createChatEngine(missingActiveRequests.deps), TypeError);
});

test('panel-history-controller: only the six required function dependencies are fail-fast', () => {
  const required = ['getCards', 'setCards', 'setSelectedCardId', 'renderCards', 'renderConnectors', 'scheduleSave'];
  const base = {
    getCards: () => [],
    setCards: () => {},
    setSelectedCardId: () => {},
    renderCards: () => {},
    renderConnectors: () => {},
    scheduleSave: () => {},
  };

  for (const key of required) {
    const deps = { ...base };
    delete deps[key];
    assert.throws(
      () => createHistoryController(deps),
      TypeError,
      `缺失 ${key} 时 createHistoryController 必须立即 TypeError`,
    );
  }

  assert.doesNotThrow(() => createHistoryController(base), 'archive 与 DOM 相关依赖可选');
});

test('panel-history-controller: invalid getCards is rejected during record and undo instead of saving an empty canvas', () => {
  let cards = [{ id: 'a', x: 0, y: 0 }];
  const history = createHistoryController({
    getCards: () => cards,
    setCards: next => { cards = next; },
    setSelectedCardId: () => {},
    renderCards: () => {},
    renderConnectors: () => {},
    scheduleSave: () => {},
  });
  history.recordSnapshot(cards, 'a');
  history.recordSnapshot(cards, 'a');
  cards = null;

  assert.throws(() => history.recordSnapshot([], null), TypeError);
  assert.throws(() => history.undo(), TypeError);
});

test('panel-session-state: captureSnapshot rejects invalid getCards instead of persisting an empty canvas', () => {
  const view = { x: 0, y: 0, scale: 1 };
  const state = createSessionState({
    documentRef: { getElementById: () => null },
    getCards: () => null,
    setCards: () => {},
    getSelectedCardId: () => null,
    getView: () => view,
    getCurrentAgent: () => ({ id: 'agent', name: 'Agent', model: 'model', provider: 'provider' }),
    getReasoningEffort: () => null,
    getIsDisposed: () => false,
    initialCards: () => [],
    clearRemovedCardArchive: () => {},
    restoreAgent: () => {},
    updateHeaderStatus: () => {},
    updateTransform: () => {},
    renderCards: () => {},
    clearHistory: () => {},
    recordSnapshot: () => {},
    abortAllDocumentTasks: () => {},
    cancelAllRequests: () => {},
    getSessionController: () => ({ generation: 1 }),
    bus: { postMessage() {} },
    canvasId: 'canvas-1',
  });

  assert.throws(() => state.captureSnapshot(), TypeError);
});

function sessionStateCaptureDeps(documentRef) {
  const card = {
    id: 'card-1',
    draft: '已有草稿',
    savedScrollTop: 0,
    messages: [{ requestId: 'req-1', asidesOpen: false }],
  };
  const view = { x: 12, y: 24, scale: 1.25 };
  return {
    documentRef,
    getCards: () => [card],
    setCards: () => {},
    getSelectedCardId: () => card.id,
    getView: () => view,
    getCurrentAgent: () => ({ id: 'agent', name: 'Agent', model: 'model', provider: 'provider' }),
    getReasoningEffort: () => null,
    getIsDisposed: () => false,
    initialCards: () => [],
    clearRemovedCardArchive: () => {},
    restoreAgent: () => {},
    updateHeaderStatus: () => {},
    updateTransform: () => {},
    renderCards: () => {},
    clearHistory: () => {},
    recordSnapshot: () => {},
    abortAllDocumentTasks: () => {},
    cancelAllRequests: () => {},
    getSessionController: () => ({ state: { activeId: 'session-1' } }),
    bus: { postMessage() {} },
    canvasId: 'canvas-1',
  };
}

test('panel-session-state: optional documentRef preserves model snapshot without DOM and rejects malformed DOM objects', () => {
  for (const documentRef of [undefined, null]) {
    const deps = sessionStateCaptureDeps(documentRef);
    const sourceCard = deps.getCards()[0];
    const state = createSessionState(deps);
    const snapshot = state.captureSnapshot();
    assert.deepEqual(snapshot.cards, [{
      id: 'card-1',
      draft: '已有草稿',
      savedScrollTop: 0,
      messages: [{ requestId: 'req-1', asidesOpen: false }],
    }]);
    assert.deepEqual(snapshot.view, { x: 12, y: 24, scale: 1.25 });
    assert.notStrictEqual(snapshot.cards[0], sourceCard, 'captureSnapshot 必须保留 clone 语义');
  }

  assert.throws(
    () => createSessionState(sessionStateCaptureDeps({})),
    TypeError,
    '显式提供但缺少 getElementById 的 documentRef 必须在构造期拒绝',
  );
});

test('panel-chat-engine: getCards must return an array instead of silently falling back to []', () => {
  const { deps, card } = engineDeps({ getCards: () => null });
  const engine = createChatEngine(deps);
  assert.throws(() => engine.chainIsBusy(card), TypeError);
});

test('panel-bridge-intents: required identity/gate/delivery functions fail with TypeError, not a generic Error', () => {
  for (const key of ['canMutateCanvas', 'getGeneration', 'getCanvasId', 'deliverIntent']) {
    const deps = {
      canMutateCanvas: () => true,
      getGeneration: () => 1,
      getCanvasId: () => 'canvas-test',
      deliverIntent: async () => {},
    };
    delete deps[key];
    assert.throws(() => createBridgeIntents(deps), TypeError, `缺失 ${key} 必须是 TypeError`);
  }
});

test('panel-chat-engine: optional documentRef may be absent while a normal request still completes', async () => {
  const { deps, card } = engineDeps();
  assert.equal('documentRef' in deps, false);
  const engine = createChatEngine(deps);

  await engine.sendCardPrompt(card, '没有 DOM 依赖的问题');

  assert.equal(card.messages.at(-1).status, 'completed');
  assert.equal(card.messages.at(-1).text, '可见正文');
});

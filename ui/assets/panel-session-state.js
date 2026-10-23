import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertString, assertMethod } from './panel-contracts.js';
import { setCardDraft, setCardSavedScrollTop, setMessageAsidesOpen } from './panel-cards.js';
import { normalizeForkSnapshot } from './fork-session-store.js';

/**
 * 会话快照的拍取与应用，以及跨窗口的状态广播。
 *
 * 应用快照有两件事不能省：
 * 一是先丢掉上一份删除留档——卡片 id 在新会话里会从头复用（card-1、card-2……），
 * 留着旧留档，撤销时可能把别的会话的内容塞进本会话的同 id 卡片；
 * 二是重绘时 preserve 传 false，那是另一份数据，不该继承这份的 DOM 状态。
 */

export function createSessionState(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createSessionState: deps must be an object');
  }

  assertFunctions(deps, [
    'getCards', 'setCards', 'getView', 'getSelectedCardId', 'getCurrentAgent',
    'getIsDisposed', 'initialCards', 'clearRemovedCardArchive', 'restoreAgent',
    'updateHeaderStatus', 'updateTransform', 'renderCards', 'clearHistory',
    'recordSnapshot', 'abortAllDocumentTasks', 'cancelAllRequests',
    'getSessionController'
  ], 'createSessionState');

  assertObject(deps.bus, 'bus', 'createSessionState');
  assertMethod(deps.bus, 'postMessage', 'createSessionState');
  assertString(deps.canvasId, 'canvasId', 'createSessionState');

  if (deps.documentRef != null) {
    assertObject(deps.documentRef, 'documentRef', 'createSessionState');
    assertMethod(deps.documentRef, 'getElementById', 'createSessionState');
  }

  assertOptionalFunctions(deps, ['getDeleteIntent', 'getReasoningEffort', 'reportIssue', 'resetTransientUI'], 'createSessionState');

  const {
    reportIssue = () => {},
    resetTransientUI,
    documentRef,
    getCards,
    setCards,
    getView,
    getSelectedCardId,
    getCurrentAgent,
    getReasoningEffort,
    getIsDisposed,
    initialCards,
    clearRemovedCardArchive,
    restoreAgent,
    updateHeaderStatus,
    updateTransform,
    renderCards,
    clearHistory,
    recordSnapshot,
    abortAllDocumentTasks,
    cancelAllRequests,
    getSessionController,
    getDeleteIntent,
    bus,
    canvasId,
  } = deps;

  function snapshotAgent() {
    const { id, name, model, provider } = getCurrentAgent();
    const effort = typeof getReasoningEffort === 'function' ? getReasoningEffort() : null;
    return { id, name, model, provider, ...(effort ? { reasoningEffort: effort } : {}) };
  }

  function initialSnapshot() {
    return {
      cards: initialCards(),
      view: { x: 60, y: 40, scale: 1 },
      agent: snapshotAgent(),
    };
  }

  /** 拍一份快照前，先把只存在于 DOM 里的东西收回数据：草稿、滚动位置、折叠状态。 */
  function captureSnapshot() {
    const doc = documentRef;
    const cards = getCards();
    if (!Array.isArray(cards)) throw new TypeError('createSessionState: getCards must return an array');
    for (const card of cards) {
      const input = doc?.getElementById?.(`input-${card.id}`);
      if (input && typeof input.value === 'string') setCardDraft(card, input.value);
      const body = doc?.getElementById?.(`body-${card.id}`);
      if (typeof body?.scrollTop === 'number') setCardSavedScrollTop(card, body.scrollTop);
      for (const message of card.messages) {
        if (!message.requestId) continue;
        const details = doc?.getElementById?.(`asides-${message.requestId}`);
        if (typeof details?.open === 'boolean') setMessageAsidesOpen(message, details.open);
      }
    }
    const view = getView();
    return JSON.parse(JSON.stringify({
      cards,
      view: { x: view.x, y: view.y, scale: view.scale },
      agent: snapshotAgent(),
    }));
  }

  function applySnapshot(snapshot) {
    if (getIsDisposed()) return;
    if (typeof resetTransientUI === 'function') {
      try { resetTransientUI(); } catch {}
    }
    const view = getView();
    if (typeof clearRemovedCardArchive === 'function') clearRemovedCardArchive();
    clearHistory();

    if (!snapshot) {
      setCards([]);
      view.x = 60; view.y = 40; view.scale = 1; view.isDragging = false;
      updateHeaderStatus(); updateTransform(); renderCards(false);
      return;
    }

    // 从存储回到活卡片时重新规范化：引用要重新冻结，否则下游可以就地改写快照
    let appliedCards = snapshot.cards;
    if (Array.isArray(snapshot.cards) && snapshot.cards.some(card => Array.isArray(card?.contextRefs))) {
      try {
        appliedCards = normalizeForkSnapshot(snapshot).cards;
      } catch (err) {
        reportIssue?.(`会话里的上下文引用有问题，已按原样打开：${err?.message || err}`);
      }
    }
    setCards(appliedCards);
    Object.assign(view, snapshot.view, { isDragging: false });
    restoreAgent(snapshot.agent);
    updateHeaderStatus(); updateTransform(); renderCards(false);
    recordSnapshot(appliedCards, getSelectedCardId());
  }

  function cancelSessionRequests(reason) {
    abortAllDocumentTasks();
    cancelAllRequests(reason);
  }

  function publishSessionState(targetPanelId) {
    if (getIsDisposed()) return;
    const sessionController = getSessionController();
    if (!sessionController) return;
    const state = sessionController.state;
    const deleteIntent = typeof getDeleteIntent === 'function' ? getDeleteIntent() : null;
    bus.postMessage({
      type: 'FORK_SESSION_STATE',
      canvasId,
      targetPanelId,
      activeId: state.activeId,
      ready: state.ready,
      busy: state.busy || Boolean(deleteIntent),
      saving: state.saving,
      dirty: state.dirty,
      error: state.error,
      agent: snapshotAgent(),
    });
  }

  return { initialSnapshot, captureSnapshot, applySnapshot, cancelSessionRequests, publishSessionState };
}

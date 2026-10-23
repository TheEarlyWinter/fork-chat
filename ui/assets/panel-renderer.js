import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertMethod, assertCardsArray } from './panel-contracts.js';
import { setCardDraft, setMessageAsidesOpen, setCardSavedScrollTop, setCardScrollToEnd } from './panel-cards.js';

/**
 * 卡片层的重建。
 *
 * 这里有个容易被改坏的守卫：输入法正在组词时绝不重建 DOM。
 * 重建会把正在编辑的那个 input 换掉，候选框消失、拼音变成裸字母。
 * 组词期间只记一个待办标记，compositionend 之后补一次。
 */

export function createRenderer(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createRenderer: deps must be an object');
  }

  assertFunctions(deps, [
    'getCards', 'getCardsLayer', 'getSelectedCardId', 'getCurrentAgent',
    'getSession', 'getMultiSelectedCardIds', 'chainIsBusy', 'drain',
    'getCardCleanups', 'computeVisibleCards', 'collectSubtreeCardIds',
    'cardParentIds', 'buildCardHtml', 'escapeHtml', 'messageMarkup',
    'statusText', 'formatFileSize', 'bindCardEvents', 'renderConnectors',
    'getIsDisposed'
  ], 'createRenderer');

  assertObject(deps.activeRequests, 'activeRequests', 'createRenderer');
  assertMethod(deps.activeRequests, 'has', 'createRenderer');

  assertObject(deps.documentRef, 'documentRef', 'createRenderer');
  assertMethod(deps.documentRef, 'getElementById', 'createRenderer');
  assertMethod(deps.documentRef, 'createElement', 'createRenderer');

  assertOptionalFunctions(deps, ['getBadgeStats', 'getEmptyState'], 'createRenderer');

  const {
    documentRef,
    getCardsLayer,
    getBadgeStats = () => null,
    getEmptyState = () => null,
    getIsDisposed,
    getCards,
    getSelectedCardId,
    getCurrentAgent,
    getSession,
    getMultiSelectedCardIds,
    activeRequests,
    chainIsBusy,
    drain,
    getCardCleanups,
    computeVisibleCards,
    collectSubtreeCardIds,
    cardParentIds,
    buildCardHtml,
    escapeHtml,
    messageMarkup,
    statusText,
    formatFileSize,
    bindCardEvents,
    renderConnectors,
  } = deps;

  let composingInputId = null;
  let pendingRenderCards = false;

  function renderCards(preserve = true) {
    if (getIsDisposed()) return;
    if (composingInputId) {
      pendingRenderCards = true;
      return;
    }

    const doc = documentRef;
    const cardsLayer = getCardsLayer();
    const cards = assertCardsArray(getCards(), 'renderer');
    const selectedCardId = getSelectedCardId();
    const multiSelected = getMultiSelectedCardIds();

    // 重绘前先把用户已经敲进去的东西、以及滚动位置收回来，
    // 不然一重绘草稿就没了、长回答也跳回顶部。
    // preserve=false 是切会话时用的：那是另一份数据，不该继承这份的 DOM 状态。
    if (preserve) {
      for (const input of cardsLayer.querySelectorAll?.('.card-input') || []) {
        const card = cards.find(item => `input-${item.id}` === input.id);
        if (card) setCardDraft(card, input.value);
      }
      for (const card of cards) {
        const body = doc.getElementById(`body-${card.id}`);
        if (typeof body?.scrollTop === 'number') setCardSavedScrollTop(card, body.scrollTop);
        for (const message of card.messages) {
          if (!message.requestId) continue;
          const asides = doc.getElementById(`asides-${message.requestId}`);
          if (typeof asides?.open === 'boolean') setMessageAsidesOpen(message, asides.open);
        }
      }
    }

    const focused = preserve ? doc.activeElement : null;
    const focusId = /^(input-|asides-toggle-)/.test(focused?.id || '') ? focused.id : null;
    const selection = focusId?.startsWith('input-') ? [focused.selectionStart, focused.selectionEnd] : null;

    drain(getCardCleanups());
    cardsLayer.innerHTML = '';

    const { visibleCards } = computeVisibleCards({ cards, cardParentIds });
    const currentAgent = getCurrentAgent();
    const session = getSession();

    visibleCards.forEach(card => {
      const cardEl = doc.createElement('div');
      cardEl.className = 'chat-card';
      cardEl.id = `dom-${card.id}`;
      cardEl.style.left = `${card.x}px`;
      cardEl.style.top = `${card.y}px`;
      cardEl.style.width = `${card.width}px`;
      if (typeof card.height === 'number') {
        cardEl.style.height = `${card.height}px`;
        cardEl.classList.add('has-custom-height');
      }

      const busy = activeRequests.has(card.id);
      const chainBusy = chainIsBusy(card);
      if (multiSelected.has(card.id)) {
        cardEl.classList.add('is-multi-selected');
      } else if (card.id === selectedCardId) {
        cardEl.classList.add('is-selected-card');
      }
      if (card.statusStamp) {
        cardEl.classList.add(`is-stamp-${card.statusStamp}`);
      }

      const descendantsCount = collectSubtreeCardIds({ cards, rootCardId: card.id, cardParentIds }).size;
      cardEl.innerHTML = buildCardHtml({
        card,
        childCount: descendantsCount,
        currentAgent,
        isSelected: card.id === selectedCardId,
        isMultiSelected: multiSelected.has(card.id),
        isBusy: busy,
        chainBusy,
        escapeHtml,
        messageMarkup,
        statusText,
        formatFileSize,
        isReady: Boolean(session?.state.ready) && !session.state.busy,
      });

      bindCardEvents(cardEl, card);
      cardsLayer.appendChild(cardEl);

      const bodyEl = cardEl.querySelector(`#body-${card.id}`);
      if (bodyEl) {
        if (typeof card.height === 'number') {
          bodyEl.style.maxHeight = 'none';
          bodyEl.style.flex = '1 1 0';
        }
        // scrollToEnd 是流式输出时打的一次性标记：这一帧要贴底。
        bodyEl.scrollTop = card.scrollToEnd || card.savedScrollTop === undefined
          ? bodyEl.scrollHeight
          : card.savedScrollTop;
      }
      setCardScrollToEnd(card, false);
    });

    if (focusId) {
      const restored = doc.getElementById(focusId);
      restored?.focus?.({ preventScroll: true });
      if (selection?.every(Number.isInteger)) restored?.setSelectionRange?.(...selection);
    }

    const branchCount = cards.reduce((count, card) => count + cardParentIds(card).length, 0);
    const badgeStats = getBadgeStats();
    if (badgeStats) badgeStats.textContent = `${cards.length} 卡片 · ${branchCount} 追问分支`;
    renderConnectors();
    const emptyState = getEmptyState();
    if (emptyState) emptyState.hidden = cards.length > 0;
  }

  function onCompositionStart(event) {
    if (event?.target?.classList?.contains?.('card-input')) {
      composingInputId = event.target.id || '';
    }
  }

  function onCompositionEnd() {
    composingInputId = null;
    if (pendingRenderCards && !getIsDisposed()) {
      pendingRenderCards = false;
      renderCards();
    }
  }

  return {
    renderCards,
    onCompositionStart,
    onCompositionEnd,
    isComposing: () => Boolean(composingInputId),
  };
}

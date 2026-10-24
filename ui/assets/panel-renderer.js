import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertMethod, assertCardsArray } from './panel-contracts.js';
import { setCardDraft, clearCardDraft, setMessageAsidesOpen, setCardSavedScrollTop, setCardScrollToEnd } from './panel-cards.js';

/**
 * 卡片层的重建。
 *
 * 这里有个容易被改坏的守卫：输入法正在组词时绝不重建 DOM。
 * 重建会把正在编辑的那个 input 换掉，候选框消失、拼音变成裸字母。
 * 完整重绘在组词期间只记待办，compositionend 之后补一次；纯布局更新
 * 不替换任何输入节点，可以直接更新坐标。
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
    'getIsDisposed', 'cardContentSignature', 'canReuseCardElement'
  ], 'createRenderer');

  assertObject(deps.activeRequests, 'activeRequests', 'createRenderer');
  assertMethod(deps.activeRequests, 'has', 'createRenderer');

  assertObject(deps.documentRef, 'documentRef', 'createRenderer');
  assertMethod(deps.documentRef, 'getElementById', 'createRenderer');
  assertMethod(deps.documentRef, 'createElement', 'createRenderer');

  assertOptionalFunctions(deps, ['getBadgeStats', 'getEmptyState', 'onBeforeRender', 'onAfterRender'], 'createRenderer');

  const {
    documentRef,
    getCardsLayer,
    getBadgeStats = () => null,
    getEmptyState = () => null,
    onBeforeRender,
    onAfterRender,
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
    cardContentSignature,
    canReuseCardElement,
    formatFileSize,
    bindCardEvents,
    renderConnectors,
  } = deps;

  let composingInputId = null;
  let pendingRenderCards = false;

  // 整理只改变坐标。复用完整且仍绑定活卡的 DOM，避免拆掉输入框、
  // 光标和 IME 会话；结构发生变化时才回退到下方的完整重绘。
  function renderLayoutOnly() {
    const cardsLayer = getCardsLayer();
    if (typeof cardsLayer?.querySelectorAll !== 'function') return false;
    const cards = assertCardsArray(getCards(), 'renderer:layout');
    const { visibleCards } = computeVisibleCards({ cards, cardParentIds });
    const mounted = new Set(cardsLayer.querySelectorAll('.chat-card'));
    if (mounted.size !== visibleCards.length) return false;

    const entries = [];
    for (const card of visibleCards) {
      const element = documentRef.getElementById(`dom-${card.id}`);
      if (!mounted.has(element) || element.__boundCard !== card) return false;
      const input = element.querySelector?.('.card-input');
      if ((!card.isDoc && !input) || (input && (
        input.__boundCard !== card || input.id !== `input-${card.id}`
      ))) return false;
      entries.push({ card, element, input });
    }

    // 全量核验后再收拢草稿，确保布局后的保存拿到当前输入，而非旧值。
    // 不写 input.value，也不 drain/rebind：原生输入现场保持原样。
    for (const { card, input } of entries) {
      if (input) {
        if (input.value) setCardDraft(card, input.value);
        else clearCardDraft(card);
      }
      const body = documentRef.getElementById(`body-${card.id}`);
      if (typeof body?.scrollTop === 'number') setCardSavedScrollTop(card, body.scrollTop);
      for (const message of card.messages) {
        if (!message.requestId) continue;
        const asides = documentRef.getElementById(`asides-${message.requestId}`);
        if (typeof asides?.open === 'boolean') setMessageAsidesOpen(message, asides.open);
      }
    }
    if (typeof onBeforeRender === 'function') {
      try { onBeforeRender(); } catch {}
    }
    if (getIsDisposed()) return true;
    const liveCards = new Set(getCards());
    if (entries.some(({ card, element }) => (
      !liveCards.has(card) || element.__boundCard !== card
      || documentRef.getElementById(`dom-${card.id}`) !== element
    ))) {
      // 结构对不上了：这次布局作废，必须交回完整重绘，
      // 返回 true 会让调用方以为已经画完，结果是整次渲染被跳过。
      return false;
    }
    for (const { card, element } of entries) {
      element.style.left = `${card.x}px`;
      element.style.top = `${card.y}px`;
    }
    renderConnectors();
    if (typeof onAfterRender === 'function') {
      try { onAfterRender(); } catch {}
    }
    return true;
  }

  function renderCards(preserve = true, options = {}) {
    if (getIsDisposed()) return;
    if (preserve && options?.layoutOnly === true && renderLayoutOnly()) return;
    if (typeof onBeforeRender === 'function') {
      try { onBeforeRender(); } catch {}
    }
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
        const cardEl = input.closest?.('.chat-card') || (card ? doc.getElementById(`dom-${card.id}`) : null);
        const bound = input.__boundCard || cardEl?.__boundCard;
        if (card) {
          if (bound && bound !== card) {
            // 来源 DOM 属于已失效的同 ID 旧卡对象，绝不覆盖同 ID 新卡草稿
            continue;
          }
          if (input.value) setCardDraft(card, input.value);
          else clearCardDraft(card);
        }
      }
      for (const card of cards) {
        const body = doc.getElementById(`body-${card.id}`);
        const cardEl = doc.getElementById(`dom-${card.id}`);
        const bound = cardEl?.__boundCard;
        if (cardEl && bound && bound !== card) continue;
        if (typeof body?.scrollTop === 'number') setCardSavedScrollTop(card, body.scrollTop);
        for (const message of card.messages) {
          if (!message.requestId) continue;
          const asides = doc.getElementById(`asides-${message.requestId}`);
          if (typeof asides?.open === 'boolean') setMessageAsidesOpen(message, asides.open);
        }
      }
    }

    // 增量重绘：先回填现场（滚动/折叠）并收集可复用元素。
    // 全部可见卡签名未变 → 走轻量轨道：不 drain 不清场，只挪位/调选中态（流式高频路径）。
    // 任何一张卡需要重建 → 整体走重建轨道（drain+清场），复用元素重新摘挂。
    // 两条轨道互斥：轻量轨道保持全部事件绑定存活，重建轨道靠重绑恢复。
    const renderContext = { agent: getCurrentAgent() };
    const reusable = new Map(); // cardId -> element
    for (const card of cards) {
      const body = doc.getElementById(`body-${card.id}`);
      const cardEl = doc.getElementById(`dom-${card.id}`);
      const bound = cardEl?.__boundCard;
      if (cardEl && bound && bound !== card) continue;
      if (typeof body?.scrollTop === 'number') setCardSavedScrollTop(card, body.scrollTop);
      for (const message of card.messages) {
        if (!message.requestId) continue;
        const asides = doc.getElementById(`asides-${message.requestId}`);
        if (typeof asides?.open === 'boolean') setMessageAsidesOpen(message, asides.open);
      }
      if (cardEl && canReuseCardElement(card, cardContentSignature(card, renderContext), cardEl)) {
        reusable.set(card.id, cardEl);
      }
    }

    const { visibleCards } = computeVisibleCards({ cards, cardParentIds });
    const allReusable = visibleCards.length > 0
      && visibleCards.every(card => reusable.has(card.id))
      && visibleCards.every(card => reusable.get(card.id).__boundCard === card);
    if (allReusable) {
      // 轻量轨道：所有元素已在层内且内容未变，仅同步几何与选中态
      if (typeof onBeforeRender === 'function') { try { onBeforeRender(); } catch {} }
      if (getIsDisposed()) return;
      for (const card of visibleCards) {
        const el = reusable.get(card.id);
        el.style.left = `${card.x}px`;
        el.style.top = `${card.y}px`;
        el.classList[card.id === selectedCardId ? 'add' : 'remove']('is-selected-card');
        el.classList[multiSelected.has(card.id) ? 'add' : 'remove']('is-multi-selected');
      }
      renderConnectors();
      const badgeStats = getBadgeStats();
      if (badgeStats) {
        const branchCount = cards.reduce((count, card) => count + cardParentIds(card).length, 0);
        badgeStats.textContent = `${cards.length} 卡片 · ${branchCount} 追问分支`;
      }
      if (typeof onAfterRender === 'function') { try { onAfterRender(); } catch {} }
      return;
    }

    const focused = preserve ? doc.activeElement : null;
    const focusId = /^(input-|asides-toggle-)/.test(focused?.id || '') ? focused.id : null;
    const selection = focusId?.startsWith('input-') ? [focused.selectionStart, focused.selectionEnd] : null;

    drain(getCardCleanups());
    cardsLayer.innerHTML = '';

    const currentAgent = getCurrentAgent();
    const session = getSession();

    // 重建轨道：保守契约 —— 结构不完整或任何签名变化就整体重建，不做部分复用。
    // （部分复用会让「不完整必须 full fallback」的语义失效，也把事件绑定生命周期搞复杂。）
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
      cardEl.__boundCard = card;
      cardEl.__contentSignature = cardContentSignature(card, renderContext);
      const inputEl = cardEl.querySelector?.('.card-input') || cardEl.querySelector?.(`#input-${card.id}`);
      if (inputEl) inputEl.__boundCard = card;
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

    if (typeof onAfterRender === 'function') {
      try { onAfterRender(); } catch {}
    }
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

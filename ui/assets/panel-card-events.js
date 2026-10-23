/**
 * 一张卡片上除了拖拽与缩放之外的全部事件：发送、取消、分支、关闭、
 * 标记盖戳、整链导出、折叠、附件、多选、来源跳转。
 *
 * 每次重绘都会 drain 掉 cardCleanups 再重绑，所以这里挂的监听全进那个 Set，
 * 否则卡片重画十次就留十份监听，点一下发十条消息。
 */

import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertMethod, assertCardsArray } from './panel-contracts.js';
import { setCardDraft, clearCardDraft, getCardDraft, setMessageAsidesOpen, setCardStatusStamp } from './panel-cards.js';

export function createCardEvents(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createCardEvents: deps must be an object');
  }

  assertFunctions(deps, [
    'listen', 'getCardCleanups', 'flashMessage', 'safeDetail', 'getCards',
    'getIsDisposed', 'chainIsBusy', 'openBattleDialog', 'createBranchCard',
    'closeCardHierarchy', 'cycleCardStatusStamp', 'selectCard',
    'toggleMultiSelectCard', 'clearMultiSelect', 'renderCards', 'renderConnectors',
    'scheduleSave', 'recordSnapshot', 'canMutateCanvas', 'sendCardPrompt',
    'cancelCardRequest', 'findCardAncestorChain', 'cardParentIds',
    'formatCardChainMarkdown'
  ], 'createCardEvents');

  assertObject(deps.documentUi, 'documentUi', 'createCardEvents');
  assertMethod(deps.documentUi, 'attachFilesToCard', 'createCardEvents');
  assertMethod(deps.documentUi, 'removeStagedAttachment', 'createCardEvents');
  assertMethod(deps.documentUi, 'hideDropIndicator', 'createCardEvents');

  assertObject(deps.cardGestures, 'cardGestures', 'createCardEvents');
  assertMethod(deps.cardGestures, 'beginCardDrag', 'createCardEvents');
  assertMethod(deps.cardGestures, 'bindResizeHandles', 'createCardEvents');

  assertObject(deps.activeRequests, 'activeRequests', 'createCardEvents');
  assertMethod(deps.activeRequests, 'get', 'createCardEvents');

  assertOptionalFunctions(deps, [
    'getDocumentRef', 'getNavigator', 'getIsSpacePressed',
    'getSelectedCardId'
  ], 'createCardEvents');

  const {
    listen,
    getCardCleanups,
    hana,
    flashMessage,
    safeDetail,
    getSession,
    getCards,
    getIsDisposed,
    getIsSpacePressed,
    getSelectedCardId,
    getDocumentRef,
    getNavigator,
    activeRequests,
    paintMessage,
    ChatError,
    chainIsBusy,
    openBattleDialog,
    documentUi,
    cardGestures,
    createBranchCard,
    closeCardHierarchy,
    cycleCardStatusStamp,
    selectCard,
    toggleMultiSelectCard,
    clearMultiSelect,
    renderCards,
    renderConnectors,
    scheduleSave,
    recordSnapshot,
    canMutateCanvas,
    sendCardPrompt,
    cancelCardRequest,
    findCardAncestorChain,
    cardParentIds,
    formatCardChainMarkdown,
  } = deps;

  const cardsNow = () => assertCardsArray(getCards(), 'card-events');
  const doc = () => (typeof getDocumentRef === 'function' ? getDocumentRef() : null);

  function bindCardEvents(cardEl, card) {
    const on = (target, type, handler, options) => listen(target, type, handler, options, getCardCleanups());
    const header = cardEl.querySelector('[data-drag-handle="true"]');
    const inputEl = cardEl.querySelector(`#input-${card.id}`);
    const btnSend = cardEl.querySelector('[data-action="send"]');
    const btnBattle = cardEl.querySelector('[data-action="battle"]');
    const btnClose = cardEl.querySelector('[data-action="close"]');
    const btnBranch = cardEl.querySelector('[data-action="branch"]');
    const btnBranchBattle = cardEl.querySelector('[data-action="branch-battle"]');
    const btnCancel = cardEl.querySelector('[data-action="cancel"]');
    const btnAttach = cardEl.querySelector('[data-action="attach"]');
    const fileInput = cardEl.querySelector(`#file-${card.id}`);
    const stagedBar = cardEl.querySelector('.staged-attachments-bar');

    // 跳回本体：只定位会话，不声称定位到具体某条消息
    on(cardEl.querySelector('[data-action="jump-source"]'), 'click', async (e) => {
      e.stopPropagation();
      if (!card.sourceRef?.sessionId) return;
      try {
        await hana.sessions.focus({ sessionId: card.sourceRef.sessionId });
      } catch (err) {
        flashMessage(`跳回失败：${safeDetail(err?.message || String(err))}`);
      }
    });

    // 折叠区的开合状态要存，不然重绘后又弹回去
    for (const message of card.messages) {
      if (!message.requestId) continue;
      const asides = cardEl.querySelector(`#asides-${message.requestId}`);
      if (!asides) continue;
      asides.open = Boolean(message.asidesOpen);
      on(asides, 'toggle', () => {
        if (message.asidesOpen !== asides.open) {
          setMessageAsidesOpen(message, asides.open);
          scheduleSave();
        }
      });
    }

    on(cardEl, 'mousedown', (e) => {
      if (typeof getIsSpacePressed === 'function' && getIsSpacePressed()) return;
      if (!e.target?.closest?.('input, textarea, button, [contenteditable="true"]')) {
        const active = doc()?.activeElement;
        if (active && active !== doc()?.body && typeof active.blur === 'function') {
          active.blur();
        }
      }
      if (e.shiftKey) {
        e.stopPropagation();
        toggleMultiSelectCard(card.id);
        return;
      }
      clearMultiSelect();
      selectCard(card.id, false);
    });

    on(inputEl, 'focus', () => {
      selectCard(card.id, true);
    });

    inputEl.value = getCardDraft(card);
    on(inputEl, 'input', () => {
      setCardDraft(card, inputEl.value);
      scheduleSave();
    });

    on(btnCancel, 'click', () => {
      const active = activeRequests.get(card.id);
      if (!active || active.terminalSeen) return;
      if (doc()?.activeElement === btnCancel) inputEl.focus({ preventScroll: true });
      cancelCardRequest(card.id, '用户取消了本次等待。');
    });

    const openBattle = (e) => {
      e.stopPropagation();
      if (chainIsBusy(card) || !cardsNow().includes(card)) return;
      void openBattleDialog(card, inputEl.value.trim());
    };
    on(btnBattle, 'click', openBattle);
    on(btnBranchBattle, 'click', openBattle);

    on(btnAttach, 'click', (e) => {
      e.stopPropagation();
      if (chainIsBusy(card) || !cardsNow().includes(card)) return;
      fileInput?.click();
    });

    on(fileInput, 'change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      fileInput.value = ''; // 先清空，同一个文件再选一次也要能触发 change
      await documentUi.attachFilesToCard(card, files);
    });

    on(stagedBar, 'click', (e) => {
      const removeBtn = e.target.closest('[data-action="remove-attachment"]');
      if (!removeBtn) return;
      e.stopPropagation();
      documentUi.removeStagedAttachment(card, parseInt(removeBtn.getAttribute('data-index'), 10));
    });

    // 卡片级文件拖拽
    on(cardEl, 'dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
        cardEl.classList.add('card-drop-active');
      }
    });

    on(cardEl, 'dragleave', (e) => {
      if (e.target === cardEl || !cardEl.contains(e.relatedTarget)) {
        cardEl.classList.remove('card-drop-active');
      }
    });

    on(cardEl, 'drop', async (e) => {
      if (!canMutateCanvas() || !cardsNow().includes(card)) return;
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      cardEl.classList.remove('card-drop-active');
      documentUi.hideDropIndicator();
      await documentUi.attachFilesToCard(card, Array.from(e.dataTransfer.files));
    });

    on(header, 'mousedown', (e) => {
      cardGestures.beginCardDrag({ card, cardEl, event: e });
    });

    cardGestures.bindResizeHandles({ card, cardEl });

    const doSend = async () => {
      if (chainIsBusy(card) || !cardsNow().includes(card)) return;
      const text = inputEl.value.trim();
      const hasStaged = Array.isArray(card.stagedAttachments) && card.stagedAttachments.length > 0;
      if (!text && !hasStaged) return;
      const staged = hasStaged ? [...card.stagedAttachments] : [];
      card.stagedAttachments = [];
      if (doc()?.activeElement === btnSend) inputEl.focus({ preventScroll: true });
      inputEl.value = '';
      clearCardDraft(card);
      await sendCardPrompt(card, text, { attachments: staged });
    };

    on(btnSend, 'click', doSend);
    on(inputEl, 'keydown', (e) => {
      // 输入法正在组词时回车是选词，不是发送
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        doSend();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        createBranchCard(card, { autoFocus: true });
        return;
      }
      if (e.key === 'Escape') {
        inputEl.blur();
        return;
      }
    });

    on(btnBranch, 'click', (e) => {
      e.stopPropagation();
      if (getIsDisposed()) return;
      createBranchCard(card, { autoFocus: true });
    });

    on(btnClose, 'click', (e) => {
      e.stopPropagation();
      closeCardHierarchy(card);
    });

    // 循环盖戳：星标 / 采纳 / 否决
    const btnStamp = cardEl.querySelector('[data-action="cycle-stamp"]');
    if (btnStamp) {
      on(btnStamp, 'click', (e) => {
        e.stopPropagation();
        if (getIsDisposed()) return;
        setCardStatusStamp(card, cycleCardStatusStamp(card.statusStamp));
        renderCards();
        scheduleSave();
        recordSnapshot(cardsNow(), card.id);
      });
    }

    // 顺藤摸瓜：整链导出为 Markdown 并复制
    const btnExportChain = cardEl.querySelector('[data-action="export-chain"]');
    if (btnExportChain) {
      on(btnExportChain, 'click', async (e) => {
        e.stopPropagation();
        if (getIsDisposed()) return;
        const chain = findCardAncestorChain({ cards: cardsNow(), targetCardId: card.id, cardParentIds });
        if (!chain || chain.length === 0) {
          flashMessage('未找到该卡片的推导链路');
          return;
        }
        const markdown = formatCardChainMarkdown(chain, { title: `链路推导：${card.title || '长文'}` });
        try {
          const nav = typeof getNavigator === 'function' ? getNavigator() : null;
          if (nav?.clipboard?.writeText) {
            await nav.clipboard.writeText(markdown);
          } else {
            const root = doc();
            const ta = root.createElement('textarea');
            ta.value = markdown;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            root.body.appendChild(ta);
            ta.select();
            root.execCommand('copy');
            root.body.removeChild(ta);
          }
          flashMessage(`已顺藤摸瓜将 ${chain.length} 个节点的完整推导长文复制到剪贴板！`);
        } catch (err) {
          flashMessage(`导出复制失败：${safeDetail(err?.message || String(err))}`);
        }
      });
    }

    // 折叠/展开子分支
    const btnCollapseList = cardEl.querySelectorAll('[data-action="toggle-collapse"]');
    btnCollapseList.forEach(btn => {
      on(btn, 'click', (e) => {
        e.stopPropagation();
        if (getIsDisposed()) return;
        card.isCollapsed = !card.isCollapsed;
        renderCards();
        renderConnectors();
        scheduleSave();
        recordSnapshot(cardsNow(), card.id);
      });
    });
  }

  return { bindCardEvents };
}

/**
 * 一张卡片上除了拖拽与缩放之外的全部事件：发送、取消、分支、关闭、
 * 标记盖戳、整链导出、折叠、附件、多选、来源跳转。
 *
 * 每次重绘都会 drain 掉 cardCleanups 再重绑，所以这里挂的监听全进那个 Set，
 * 否则卡片重画十次就留十份监听，点一下发十条消息。
 */

import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertMethod, assertCardsArray } from './panel-contracts.js';
import { setCardDraft, clearCardDraft, getCardDraft, setMessageAsidesOpen, setCardStatusStamp } from './panel-cards.js';
import { createInputRecoveryBuffer } from './panel-input-recovery.js';
import { createClipboardWriter } from './panel-clipboard.js';
import { bindCardExportHandlers } from './panel-card-export.js';

// 兼容旧入口：调用方仍可从本模块取到工厂，实现已搬到 panel-input-recovery.js
export { createInputRecoveryBuffer };

/**
 * 上下文开关绑定（两段式确认，防误触）。
 * 单击只弹确认态（文案+样式），3 秒无操作或指针离开自动还原；
 * 确认态下再点一次才真正切换 contextMode。
 * rc.1 实机验收教训：旧版单击即切换，坐标误触把卡片静默设为 exclude。
 */
export function bindContextToggle({ cardEl, card, on, getIsDisposed, canMutateCanvas, renderCards, scheduleSave, recordSnapshot, cardsNow = () => [], setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  const btn = cardEl?.querySelector?.('[data-action="toggle-context-mode"]');
  if (!btn) return;
  let confirmTimer = null;
  const label = () => card.contextMode === 'exclude' ? '不向后续分支提供上下文' : '向后续分支提供上下文';
  const armConfirm = () => {
    btn.dataset.confirm = '1';
    btn.textContent = card.contextMode === 'exclude' ? '确认恢复提供上下文？' : '确认停止提供上下文？';
    btn.classList.add('is-confirming');
    if (confirmTimer) cancel(confirmTimer);
    confirmTimer = schedule(() => disarmConfirm(), 3000);
  };
  const disarmConfirm = () => {
    if (confirmTimer) { cancel(confirmTimer); confirmTimer = null; }
    delete btn.dataset.confirm;
    btn.classList.remove('is-confirming');
    btn.textContent = label();
  };
  on(btn, 'click', (e) => {
    e.stopPropagation();
    if (getIsDisposed() || !canMutateCanvas()) return;
    if (btn.dataset.confirm !== '1') { armConfirm(); return; }
    disarmConfirm();
    if (card.contextMode === 'exclude') delete card.contextMode;
    else card.contextMode = 'exclude';
    renderCards();
    scheduleSave();
    recordSnapshot(cardsNow(), card.id);
  });
  on(btn, 'pointerleave', () => { if (btn.dataset.confirm === '1') disarmConfirm(); });
}

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
    'formatCardChainMarkdown', 'buildTopologyOutline', 'openContextPreview', 'openRefManager'
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
    buildTopologyOutline,
    openContextPreview,
    openRefManager,
  } = deps;

  const cardsNow = () => assertCardsArray(getCards(), 'card-events');
  const doc = () => (typeof deps.getDocumentRef === 'function' ? deps.getDocumentRef() : (typeof document !== 'undefined' ? document : null));

  // 实例级有界恢复缓冲
  const recoverableBuffer = deps.recoveryBuffer || createInputRecoveryBuffer({
    getSession: deps.getSession,
    getGeneration: deps.getGeneration,
    getCards: deps.getCards,
  });

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
    for (const message of (Array.isArray(card.messages) ? card.messages : [])) {
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
      // 正文是用来选字的，不是用来选卡的：在这里改选中会把划词的目标带偏
      if (e.target?.closest?.('.msg-bubble')) {
        e.stopPropagation();
        return;
      }
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
      if (doc()?.activeElement === btnCancel) inputEl?.focus?.({ preventScroll: true });
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
      // 原生文件选择器会挡住主线程，回来时卡片可能已经进入请求或被锁定
      if (chainIsBusy(card) || !canMutateCanvas()) {
        flashMessage('这张卡现在正忙，文件没有挂上去');
        return;
      }
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

      // 发送前捕获初始前镜像与代际
      const sendGeneration = typeof getSession === 'function' ? getSession()?.generation : null;
      const targetCard = card;
      const capturedInputEl = inputEl;
      const inputBefore = inputEl.value;
      const draftBefore = card.draft;
      const hasDraftPropBefore = Object.prototype.hasOwnProperty.call(card, 'draft');
      const rawAttachmentsBefore = card.stagedAttachments;
      const attachmentsCountBefore = Array.isArray(rawAttachmentsBefore) ? rawAttachmentsBefore.length : 0;
      const attachmentsMembersBefore = Array.isArray(rawAttachmentsBefore) ? [...rawAttachmentsBefore] : [];

      const onAccepted = (meta) => {
        // 步骤 0：焦点保护——focus 动作可能触发 DOM 事件，必须先 focus 再做完整前镜像核对
        if (doc()?.activeElement === btnSend && capturedInputEl) {
          try { capturedInputEl.focus?.({ preventScroll: true }); } catch {}
        }

        // 步骤 1：完整前镜像与活对象强校验
        if (meta?.cardId && meta.cardId !== targetCard.id) return;
        if (meta?.generation !== undefined && sendGeneration !== null && meta.generation !== sendGeneration) return;

        const currentGen = typeof getSession === 'function' ? getSession()?.generation : null;
        if (currentGen !== sendGeneration) return;

        // 校验当前卡片活对象身份
        const activeCards = cardsNow();
        if (!activeCards.includes(targetCard) || activeCards.find(c => c.id === targetCard.id) !== targetCard) return;

        // 校验当前输入框 DOM 挂载与引用
        if (capturedInputEl.isConnected === false) return;
        const domInput = doc()?.getElementById?.(`input-${targetCard.id}`);
        if (domInput && domInput !== capturedInputEl) return;

        // 校验输入框值是否仍为 inputBefore（未被用户后续编辑）
        if (capturedInputEl.value !== inputBefore) return;

        // 校验 draft own 状态与值是否未变
        const currentHasDraft = Object.prototype.hasOwnProperty.call(targetCard, 'draft');
        if (currentHasDraft !== hasDraftPropBefore || targetCard.draft !== draftBefore) return;

        // 校验附件数组引用及每个原成员身份
        if (targetCard.stagedAttachments !== rawAttachmentsBefore) return;
        if (Array.isArray(targetCard.stagedAttachments)) {
          if (targetCard.stagedAttachments.length !== attachmentsCountBefore) return;
          for (let i = 0; i < attachmentsCountBefore; i++) {
            if (targetCard.stagedAttachments[i] !== attachmentsMembersBefore[i]) return;
          }
        }

        // 步骤 2：分步清理与事务修改记录
        let didClearAttachments = false;
        let didClearInput = false;
        let didClearDraft = false;
        let cleanupError = null;
        let clearedAttachmentsInstance = null;

        try {
          // 清理附件：替换数组、不修改原数组
          const newEmptyAttachments = [];
          targetCard.stagedAttachments = newEmptyAttachments;
          clearedAttachmentsInstance = newEmptyAttachments;
          didClearAttachments = true;
        } catch (err) {
          cleanupError = cleanupError || err;
        }

        try {
          // 清理输入框
          capturedInputEl.value = '';
          didClearInput = true;
        } catch (err) {
          cleanupError = cleanupError || err;
        }

        try {
          // 清理草稿
          clearCardDraft(targetCard);
          didClearDraft = true;
        } catch (err) {
          cleanupError = cleanupError || err;
        }

        if (cleanupError) {
          // 清理异常：分步回滚已修改字段，恢复回原附件数组与原成员对象
          let allRestored = true;

          const stillCurrentGen = typeof getSession === 'function' ? getSession()?.generation : null;
          const stillActiveCards = cardsNow();
          const cardStillValid = (stillCurrentGen === sendGeneration) &&
            stillActiveCards.includes(targetCard) &&
            (stillActiveCards.find(c => c.id === targetCard.id) === targetCard);

          if (cardStillValid) {
            if (didClearDraft) {
              try {
                // 仅当 draft 仍是本事务清理后的状态时才恢复
                if (targetCard.draft === undefined && !Object.prototype.hasOwnProperty.call(targetCard, 'draft')) {
                  if (hasDraftPropBefore) setCardDraft(targetCard, draftBefore);
                  else clearCardDraft(targetCard);
                }
              } catch {
                allRestored = false;
              }
            }

            if (didClearInput) {
              try {
                // 仅当 inputEl 仍是本事务清空后的值时才恢复
                if (capturedInputEl.value === '') {
                  capturedInputEl.value = inputBefore;
                }
              } catch {
                allRestored = false;
              }
            }

            if (didClearAttachments) {
              try {
                // 仅当 attachments 仍是本事务设置的那同一个空数组实例时，才恢复回原附件数组；避免覆盖后续编辑新建的空数组
                if (targetCard.stagedAttachments === clearedAttachmentsInstance) {
                  targetCard.stagedAttachments = rawAttachmentsBefore;
                }
              } catch {
                allRestored = false;
              }
            }
          } else {
            allRestored = false;
          }

          // 恢复再次抛错或清理未完成也安全隔离、提示且保留受控有界可恢复副本
          if (!didClearAttachments || !didClearInput || !didClearDraft || !allRestored) {
            try {
              recoverableBuffer.save({
                cardId: targetCard.id,
                cardRef: targetCard,
                generation: sendGeneration,
                inputValue: inputBefore,
                draft: draftBefore,
                hasDraftProp: hasDraftPropBefore,
                stagedAttachments: rawAttachmentsBefore,
              });
            } catch {}
          }

          try {
            flashMessage(`输入没能清干净，已尝试按原样放回：${safeDetail(cleanupError?.message || String(cleanupError))}`);
          } catch {}
          throw cleanupError;
        }
      };

      // 仅调用 sendCardPrompt；无条件恢复分支已删除，未进接受边界保持零修改
      await sendCardPrompt(card, text, { attachments: rawAttachmentsBefore, onAccepted });
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

    // 是否向后续分支提供上下文。这是策略，不是标签：不动卡片内容，也不删历史。
    bindContextToggle({ cardEl, card, on, getIsDisposed, canMutateCanvas, renderCards, scheduleSave, recordSnapshot, cardsNow });

    const btnContextPreview = cardEl.querySelector('[data-action="preview-context"]');
    if (btnContextPreview) {
      on(btnContextPreview, 'click', (e) => {
        e.stopPropagation();
        if (getIsDisposed()) return;
        openContextPreview(card);
      });
    }

    const btnManageRefs = cardEl.querySelector('[data-action="manage-refs"]');
    if (btnManageRefs) {
      on(btnManageRefs, 'click', (e) => {
        e.stopPropagation();
        if (getIsDisposed()) return;
        openRefManager(card);
      });
    }

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

    // 导出与剪贴板在 panel-card-export.js / panel-clipboard.js，这里只做接线
    bindCardExportHandlers({
      cardEl, card, on, getIsDisposed, cardsNow, cardParentIds,
      buildTopologyOutline, findCardAncestorChain, formatCardChainMarkdown,
      copyText: createClipboardWriter({ doc, getNavigator }),
      flashMessage, safeDetail,
    });

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

  return {
    bindCardEvents,
    recoverableBuffer,
    recoveryBuffer: recoverableBuffer,
    getRecoveryBuffer: () => recoverableBuffer,
    dispose: () => recoverableBuffer.clear(),
    clear: () => recoverableBuffer.clear(),
  };
}

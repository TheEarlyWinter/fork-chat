/**
 * 一张卡片上除了拖拽与缩放之外的全部事件：发送、取消、分支、关闭、
 * 标记盖戳、整链导出、折叠、附件、多选、来源跳转。
 *
 * 每次重绘都会 drain 掉 cardCleanups 再重绑，所以这里挂的监听全进那个 Set，
 * 否则卡片重画十次就留十份监听，点一下发十条消息。
 */

import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertMethod, assertCardsArray } from './panel-contracts.js';
import { setCardDraft, clearCardDraft, getCardDraft, setMessageAsidesOpen, setCardStatusStamp } from './panel-cards.js';

/**
 * 生产受控有界恢复缓冲工厂（默认容量 8 份 FIFO）
 * 绑定代际与卡片活对象身份，不写 localStorage、不记正文日志
 */
export function createInputRecoveryBuffer({ getSession, getGeneration, getCards, maxCapacity = 8 } = {}) {
  const validCapacity = Number.isInteger(maxCapacity) && maxCapacity > 0 ? maxCapacity : 8;
  const bufferEntries = [];
  const currentGen = () => {
    if (typeof getSession === 'function') return getSession()?.generation ?? null;
    if (typeof getGeneration === 'function') return getGeneration();
    return null;
  };
  const activeCards = () => (typeof getCards === 'function' ? getCards() : null);

  return {
    save(entry) {
      if (!entry || !entry.cardId) return;
      const existingIdx = bufferEntries.findIndex(e => e.cardId === entry.cardId);
      if (existingIdx !== -1) bufferEntries.splice(existingIdx, 1);
      if (bufferEntries.length >= validCapacity) {
        bufferEntries.shift();
      }
      bufferEntries.push({
        cardId: entry.cardId,
        cardRef: entry.cardRef,
        generation: entry.generation,
        inputValue: entry.inputValue,
        draft: entry.draft,
        hasDraftProp: entry.hasDraftProp,
        stagedAttachments: entry.stagedAttachments,
        timestamp: Date.now(),
      });
    },

    get(cardId) {
      const gen = currentGen();
      const cards = activeCards();
      const idx = bufferEntries.findIndex(e => e.cardId === cardId);
      if (idx === -1) return null;
      const entry = bufferEntries[idx];
      // 代际变化或卡片活对象已失效（包括 cards 为空列表），主动失效并清除
      const genMismatch = gen !== null && entry.generation !== gen;
      const cardMismatch = Array.isArray(cards) && !cards.includes(entry.cardRef);

      if (genMismatch || cardMismatch) {
        bufferEntries.splice(idx, 1);
        return null;
      }
      return {
        cardId: entry.cardId,
        generation: entry.generation,
        cardRef: entry.cardRef,
        hasDraft: entry.hasDraftProp,
        hasAttachments: Array.isArray(entry.stagedAttachments) && entry.stagedAttachments.length > 0,
        inputValue: entry.inputValue,
        draft: entry.draft,
        stagedAttachments: entry.stagedAttachments,
      };
    },

    has(cardId) {
      return Boolean(this.get(cardId));
    },

    restore(cardId, { targetCard, inputEl, generation } = {}) {
      const gen = currentGen();
      const cards = activeCards();
      const idx = bufferEntries.findIndex(e => e.cardId === cardId);
      if (idx === -1) return false;
      const entry = bufferEntries[idx];

      // 强校验：代际、活对象身份必须严格匹配
      if (gen !== null && entry.generation !== gen) {
        bufferEntries.splice(idx, 1);
        return false;
      }
      if (generation !== undefined && generation !== entry.generation) return false;
      if (Array.isArray(cards)) {
        if (cards.length === 0) {
          bufferEntries.splice(idx, 1);
          return false;
        }
        if (!cards.includes(targetCard) || !cards.includes(entry.cardRef)) return false;
      }
      if (targetCard && entry.cardRef && targetCard !== entry.cardRef) return false;

      // 绝不覆盖后续编辑：如果卡片当前已有新输入、新草稿或新附件，拒绝覆盖
      if (inputEl && inputEl.value !== '') return false;
      if (targetCard && targetCard.draft !== undefined && targetCard.draft !== '') return false;
      if (targetCard && Array.isArray(targetCard.stagedAttachments) && targetCard.stagedAttachments.length > 0) return false;

      let draftOk = true;
      let attOk = true;
      let inputOk = true;

      if (targetCard) {
        try {
          if (entry.hasDraftProp) setCardDraft(targetCard, entry.draft);
          else clearCardDraft(targetCard);
        } catch {
          draftOk = false;
        }

        try {
          if (Array.isArray(entry.stagedAttachments)) {
            targetCard.stagedAttachments = entry.stagedAttachments;
          }
        } catch {
          attOk = false;
        }
      }

      if (inputEl) {
        try {
          inputEl.value = entry.inputValue;
        } catch {
          inputOk = false;
        }
      }

      if (draftOk && attOk && inputOk) {
        bufferEntries.splice(idx, 1);
        return true;
      }
      return false;
    },

    clear() {
      bufferEntries.length = 0;
    },

    dispose() {
      bufferEntries.length = 0;
    },

    size() {
      return bufferEntries.length;
    },
  };
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

    // 是否向后续分支提供上下文。这是策略，不是标签：不动卡片内容，也不删历史
    const btnContextMode = cardEl.querySelector('[data-action="toggle-context-mode"]');
    if (btnContextMode) {
      on(btnContextMode, 'click', (e) => {
        e.stopPropagation();
        if (getIsDisposed()) return;
        if (card.contextMode === 'exclude') delete card.contextMode;
        else card.contextMode = 'exclude';
        renderCards();
        scheduleSave();
        recordSnapshot(cardsNow(), card.id);
      });
    }

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

    // 两个导出入口共用同一套剪贴板路径：优先异步 API，退回复制文本框
    const copyText = async text => {
      const nav = typeof getNavigator === 'function' ? getNavigator() : null;
      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(text);
        return;
      }
      const root = doc();
      const ta = root.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      root.body.appendChild(ta);
      ta.select();
      root.execCommand('copy');
      root.body.removeChild(ta);
    };

    // 结构大纲：只导节点与父边，不含正文，可以放心给人看
    const btnExportTopology = cardEl.querySelector('[data-action="export-topology"]');
    if (btnExportTopology) {
      on(btnExportTopology, 'click', async (e) => {
        e.stopPropagation();
        if (getIsDisposed()) return;
        try {
          const outline = buildTopologyOutline({
            cards: cardsNow(),
            targetCard: card,
            title: `结构大纲：${card.title || '长文'}`,
          });
          await copyText(outline);
          flashMessage('已复制结构大纲（只含节点与父边，不含正文）');
        } catch (err) {
          flashMessage(`结构大纲导出失败：${safeDetail(err?.message || String(err))}`);
        }
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
          await copyText(markdown);
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

  return {
    bindCardEvents,
    recoverableBuffer,
    recoveryBuffer: recoverableBuffer,
    getRecoveryBuffer: () => recoverableBuffer,
    dispose: () => recoverableBuffer.clear(),
    clear: () => recoverableBuffer.clear(),
  };
}

/**
 * 输入恢复缓冲。
 *
 * 发送被接受后，输入框会清空；如果接下来某一步清理失败，需要把用户
 * 原本写的内容放回去。这个工厂只管"记一份可撤销的前镜像"：
 * 有界、绑定代际与活卡身份、不写 localStorage、不记正文日志。
 *
 * 与卡片事件无关，独立成文件便于单独测试与替换。
 */

import { setCardDraft, clearCardDraft } from './panel-cards.js';


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

/**
 * panel-history.js
 * 画布拓扑与布局撤销/重做（Undo/Redo）历史状态管理器
 */

export const DEFAULT_MAX_HISTORY_DEPTH = 30;

/**
 * 纯函数深拷贝卡片拓扑与几何数据
 * @param {object} card 
 * @returns {object}
 */
export function cloneCardTopology(card) {
  if (!card || typeof card !== 'object') return card;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(card);
    } catch {
      // fallback in case of non-cloneable references
    }
  }
  return JSON.parse(JSON.stringify(card));
}

/**
 * 创建轻量级拓扑快照环形栈管理器
 * @param {object} options
 * @param {number} [options.maxDepth=30] 最大快照步数上限
 * @param {Function} [options.onRestore] (restoredCards, restoredSelectedId) => void
 * @returns {object}
 */
export function createHistoryManager({ maxDepth = DEFAULT_MAX_HISTORY_DEPTH, onRestore } = {}) {
  const depthLimit = typeof maxDepth === 'number' && maxDepth > 0 ? maxDepth : DEFAULT_MAX_HISTORY_DEPTH;
  let undoStack = [];
  let redoStack = [];

  return {
    recordSnapshot(cards, selectedCardId = null) {
      const clonedCards = Array.isArray(cards) ? cards.map(cloneCardTopology) : [];
      undoStack.push({
        cards: clonedCards,
        selectedCardId: selectedCardId ?? null,
      });

      if (undoStack.length > depthLimit) {
        undoStack.shift();
      }

      redoStack = [];
    },

    undo() {
      if (undoStack.length <= 1) {
        return false;
      }

      const currentState = undoStack.pop();
      redoStack.push(currentState);

      const targetState = undoStack[undoStack.length - 1];
      if (typeof onRestore === 'function') {
        const restoredCards = targetState.cards.map(cloneCardTopology);
        onRestore(restoredCards, targetState.selectedCardId);
      }
      return true;
    },

    redo() {
      if (redoStack.length === 0) {
        return false;
      }

      const nextState = redoStack.pop();
      undoStack.push(nextState);

      if (typeof onRestore === 'function') {
        const restoredCards = nextState.cards.map(cloneCardTopology);
        onRestore(restoredCards, nextState.selectedCardId);
      }
      return true;
    },

    canUndo() {
      return undoStack.length > 1;
    },

    canRedo() {
      return redoStack.length > 0;
    },

    clear() {
      undoStack = [];
      redoStack = [];
    },

    getStats() {
      return {
        undoCount: undoStack.length,
        redoCount: redoStack.length,
        maxDepth: depthLimit,
      };
    },
  };
}

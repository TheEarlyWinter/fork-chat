/** Layout history adapter: live business contents never roll back with geometry. */
import { createHistoryManager, CARD_TOPOLOGY_KEYS } from './panel-history.js';
import { applyCardTopologySnapshot } from './panel-cards.js';

export function createHistoryController(deps = {}) {
  for (const key of ['getCards', 'setCards', 'setSelectedCardId', 'renderCards', 'renderConnectors', 'scheduleSave']) {
    if (typeof deps[key] !== 'function') throw new TypeError(`createHistoryController: ${key} must be a function`);
  }
  const {
    getCards, setCards, setSelectedCardId, getRemovedCardArchive, removedCardArchive,
    renderCards, renderConnectors, scheduleSave, isDisposed, maxDepth = 30, maxRetainedBytes, onBudgetTrim,
  } = deps;
  if (onBudgetTrim !== undefined && typeof onBudgetTrim !== 'function') throw new TypeError('createHistoryController: onBudgetTrim must be a function');
  let lastBudgetTrimmedCount = 0;
  const checkDisposed = () => (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));
  function readCards() {
    const cards = getCards();
    if (!Array.isArray(cards)) throw new TypeError('createHistoryController: getCards must return an array');
    return cards;
  }
  function getArchive() {
    const archive = typeof getRemovedCardArchive === 'function' ? getRemovedCardArchive() : removedCardArchive;
    if (archive != null && ['get', 'set', 'has', 'keys', 'delete', 'clear'].some(key => typeof archive[key] !== 'function')) {
      throw new TypeError('createHistoryController: invalid removed-card archive');
    }
    return archive;
  }
  function updateArchive(cards) {
    const archive = getArchive();
    if (archive) for (const card of cards) if (archive.has(card.id)) archive.set(card.id, card);
  }
  function pruneArchive() {
    const archive = getArchive();
    const retained = manager.getRetainedCardIds();
    if (archive) for (const id of archive.keys()) if (!retained.has(id)) archive.delete(id);
    const stats = manager.getStats();
    if (stats.budgetTrimmedCount > lastBudgetTrimmedCount) {
      lastBudgetTrimmedCount = stats.budgetTrimmedCount;
      onBudgetTrim?.(stats);
    }
  }
  function applyTopology(card, snapshot) {
    applyCardTopologySnapshot(card, snapshot, CARD_TOPOLOGY_KEYS);
  }

  const manager = createHistoryManager({
    maxDepth, maxRetainedBytes,
    onRestore: (restoredCards, restoredSelectedId) => {
      const liveById = new Map(readCards().map(card => [card.id, card]));
      const archive = getArchive();
      const merged = restoredCards.map(snapshot => {
        const live = liveById.get(snapshot.id);
        // Missing cards materialize from the retained pool even when the 30-entry fast archive evicts them.
        const card = live || { ...(archive?.get(snapshot.id) || snapshot) };
        applyTopology(card, snapshot);
        return card;
      });
      setCards(merged);
      setSelectedCardId(restoredSelectedId && merged.some(card => card.id === restoredSelectedId) ? restoredSelectedId : null);
      renderCards();
      renderConnectors();
      scheduleSave();
      return merged;
    },
  });

  function syncCurrent() {
    const cards = readCards();
    updateArchive(cards);
    manager.syncCards(cards);
    pruneArchive();
  }
  function move(method) {
    if (checkDisposed() || !(method === 'undo' ? manager.canUndo() : manager.canRedo())) return false;
    syncCurrent();
    const changed = manager[method]();
    updateArchive(readCards());
    pruneArchive();
    return changed;
  }
  return {
    recordSnapshot(cards, selectedCardId = null) {
      if (checkDisposed()) return;
      updateArchive(readCards());
      manager.recordSnapshot(cards, selectedCardId);
      pruneArchive();
    },
    syncCards(cards) {
      if (checkDisposed()) return;
      updateArchive(cards);
      manager.syncCards(cards);
      pruneArchive();
    },
    undo: () => move('undo'),
    redo: () => move('redo'),
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    clear() { manager.clear(); getArchive()?.clear(); lastBudgetTrimmedCount = 0; },
    getRetainedCardIds: () => manager.getRetainedCardIds(),
    // 转发的必须与底层同一契约：返回 Set<string>，调用方可以放心 has()
    getRetainedReferenceIds() {
      const retained = manager.getRetainedReferenceIds();
      if (!(retained instanceof Set)) throw new TypeError('history manager 必须返回 Set 的引用 id 集合');
      const ids = new Set(retained);
      // 通常 archive 是内容池的子集，仍显式合并以维护对调用方承诺的全集。
      const archive = getArchive();
      if (archive) for (const cardId of archive.keys()) {
        const refs = archive.get(cardId)?.contextRefs;
        if (Array.isArray(refs)) for (const ref of refs) ids.add(ref?.id);
      }
      for (const id of ids) if (typeof id !== 'string' || !id) {
        throw new TypeError('history controller 必须返回纯字符串引用 id 集合');
      }
      return ids;
    },
    getStats: () => manager.getStats(),
  };
}

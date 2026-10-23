import { estimateReferenceBytes } from './fork-context-policy.js';

/** Topology history with one latest business-content reference per card. */
export const DEFAULT_MAX_HISTORY_DEPTH = 30;
export const DEFAULT_MAX_RETAINED_BYTES = 64 * 1024 * 1024;
export const CARD_TOPOLOGY_KEYS = Object.freeze([
  'id', 'x', 'y', 'width', 'height', 'isCollapsed', 'zIndex', 'parentId', 'parentIds', 'statusStamp',
  // 上下文策略也是用户的操作结果，撤销要能把它还原回去
  'contextMode', 'contextRefs',
]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Never inspect or copy document/message/attachment payloads for a layout step. */
export function cloneCardTopology(card) {
  if (!card || typeof card !== 'object') return card;
  const result = {};
  for (const key of CARD_TOPOLOGY_KEYS) {
    if (!own(card, key)) continue;
    if (key === 'contextRefs' && Array.isArray(card[key])) {
      // 合法活引用已经冻结；兼容调用方的可变 DTO 时只复制白名单，不改变活对象。
      result[key] = Object.freeze(card[key].map(ref => Object.isFrozen(ref) ? ref : Object.freeze({
        id: ref.id, sourceCardId: ref.sourceCardId, sourceTitle: ref.sourceTitle, text: ref.text,
      })));
      continue;
    }
    result[key] = Array.isArray(card[key]) ? [...card[key]] : card[key];
  }
  return result;
}

// Conservative logical-size estimate, not a measurement of the JavaScript heap.
// Only detached cards are measured; moving a live document never scans its text.
function estimateContentBytes(card, limit) {
  let bytes = 0;
  const seen = new Set();
  const pending = [card];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += value.length * 2;
    else if (typeof value === 'number' || typeof value === 'boolean') bytes += 8;
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) bytes += value.byteLength;
      else for (const key of Object.keys(value)) {
        // 引用在独立的 UTF-8 / ID 缓存中统一计量，不再随 detached 正文重复计数。
        if (value === card && key === 'contextRefs') continue;
        bytes += key.length * 2 + 8;
        pending.push(value[key]);
      }
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

export function createHistoryManager({
  maxDepth = DEFAULT_MAX_HISTORY_DEPTH,
  maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
  onRestore,
} = {}) {
  const depthLimit = typeof maxDepth === 'number' && Number.isFinite(maxDepth) && maxDepth >= 1
    ? Math.floor(maxDepth) : DEFAULT_MAX_HISTORY_DEPTH;
  if (!Number.isFinite(maxRetainedBytes) || maxRetainedBytes < 0) throw new RangeError('Invalid history retention budget');
  const byteLimit = Math.floor(maxRetainedBytes);
  let undoStack = [], redoStack = [];
  let liveIds = new Set();
  const contents = new Map();
  const detachedSizes = new Map();
  let retainedBytes = 0, trimmedCount = 0, budgetTrimmedCount = 0;

  function checkCards(cards) {
    if (!Array.isArray(cards)) throw new TypeError('History cards must be an array');
    const ids = new Set();
    for (const card of cards) {
      if (!card || typeof card.id !== 'string' || !card.id || ids.has(card.id)) {
        throw new TypeError('History requires unique non-empty card ids');
      }
      ids.add(card.id);
    }
    return ids;
  }

  function captureContents(cards) {
    liveIds = checkCards(cards);
    for (const card of cards) {
      contents.set(card.id, card);
      detachedSizes.delete(card.id);
    }
  }

  function collect() {
    const reachable = new Set(liveIds);
    for (const state of [...undoStack, ...redoStack]) for (const card of state.cards) reachable.add(card.id);
    retainedBytes = 0;
    for (const [id, card] of contents) {
      if (!reachable.has(id)) {
        contents.delete(id);
        detachedSizes.delete(id);
      } else if (!liveIds.has(id)) {
        if (!detachedSizes.has(id)) detachedSizes.set(id, estimateContentBytes(card, byteLimit));
        retainedBytes += detachedSizes.get(id);
      }
    }
    const historyRefs = collectHistoryReferences();
    retainedRefIds = historyRefs.ids;
    retainedRefPayload = historyRefs.payload;
    retainedBytes += historyRefs.bytes;
  }

  // 活卡持有的引用不计额外预算；历史、内容池与 detached 引用统一按 ID 计一次。
  let retainedRefIds = new Set();
  let retainedRefPayload = new Map();
  const referenceSizes = new Map();

  function referenceSize(ref) {
    const cached = referenceSizes.get(ref.id);
    if (cached?.ref === ref && Object.isFrozen(ref)) return cached.bytes;
    if (cached && (cached.sourceCardId !== ref.sourceCardId
      || cached.sourceTitle !== ref.sourceTitle || cached.text !== ref.text)) {
      throw new TypeError('History reference id has conflicting immutable content');
    }
    if (cached) return cached.bytes;
    const bytes = estimateReferenceBytes(ref);
    referenceSizes.set(ref.id, {
      ref, bytes, sourceCardId: ref.sourceCardId, sourceTitle: ref.sourceTitle, text: ref.text,
    });
    return bytes;
  }

  function collectHistoryReferences() {
    const reachable = new Map();
    const liveRefs = new Set();
    const add = (ref, live = false) => {
      if (!ref || typeof ref.id !== 'string' || !ref.id) {
        throw new TypeError('History requires non-empty reference ids');
      }
      referenceSize(ref); // 缓存命中不重扫已冻结的长正文；异内容复用 ID 必须拒绝。
      reachable.set(ref.id, ref);
      if (live) liveRefs.add(ref.id);
    };
    for (const [id, card] of contents) {
      if (Array.isArray(card.contextRefs)) for (const ref of card.contextRefs) add(ref, liveIds.has(id));
    }
    for (const state of [...undoStack, ...redoStack]) {
      for (const card of state.cards) {
        if (Array.isArray(card.contextRefs)) for (const ref of card.contextRefs) add(ref);
      }
    }
    for (const id of referenceSizes.keys()) if (!reachable.has(id)) referenceSizes.delete(id);
    let bytes = 0;
    for (const id of reachable.keys()) if (!liveRefs.has(id)) bytes += referenceSizes.get(id).bytes;
    return { bytes, ids: new Set(reachable.keys()), payload: reachable };
  }

  function enforceBudget() {
    collect();
    while (retainedBytes > byteLimit && (undoStack.length || redoStack.length)) {
      // Drop whole states, never just their payloads: no surviving undo can restore an empty shell.
      if (undoStack.length > 1) undoStack.shift();
      else if (redoStack.length) redoStack.shift(); // furthest future, not the next redo
      else undoStack.shift(); // syncCards may reveal an unrecorded removal of the last baseline
      trimmedCount += 1;
      budgetTrimmedCount += 1;
      collect();
    }
  }

  function restore(state) {
    const restored = state.cards.map(topology => {
      const content = contents.get(topology.id);
      if (!content) throw new Error(`Missing retained card: ${topology.id}`);
      const card = { ...content };
      for (const key of CARD_TOPOLOGY_KEYS) delete card[key];
      return Object.assign(card, cloneCardTopology(topology));
    });
    // The controller can preserve live object identity and return its actual installed cards.
    const installed = typeof onRestore === 'function' ? onRestore(restored, state.selectedCardId) : undefined;
    captureContents(Array.isArray(installed) ? installed : restored);
    enforceBudget();
  }

  return {
    recordSnapshot(cards, selectedCardId = null) {
      captureContents(cards);
      undoStack.push({ cards: cards.map(cloneCardTopology), selectedCardId: selectedCardId ?? null });
      if (undoStack.length > depthLimit) { undoStack.shift(); trimmedCount += 1; }
      redoStack = [];
      enforceBudget();
    },
    syncCards(cards) {
      captureContents(cards);
      enforceBudget();
    },
    undo() {
      if (undoStack.length <= 1) return false;
      redoStack.push(undoStack.pop());
      restore(undoStack[undoStack.length - 1]);
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(redoStack.pop());
      restore(undoStack[undoStack.length - 1]);
      return true;
    },
    canUndo() { return undoStack.length > 1; },
    canRedo() { return redoStack.length > 0; },
    clear() {
      undoStack = []; redoStack = [];
      liveIds.clear(); contents.clear(); detachedSizes.clear();
      // 引用缓存也要一起放掉，否则清空历史后旧正文还挂在内存里
      retainedRefIds = new Set();
      retainedRefPayload = new Map();
      referenceSizes.clear();
      retainedBytes = 0; trimmedCount = 0; budgetTrimmedCount = 0;
    },
    getRetainedCardIds() { return new Set(contents.keys()); },
    // 活卡、内容池、删除留档和历史快照里能看到的引用 id 全集
    getRetainedReferenceIds() {
      // 同步扫描 ID 也覆盖尚未来得及 recordSnapshot 的活卡字段替换，不读取正文。
      const ids = new Set();
      for (const card of contents.values()) {
        if (Array.isArray(card.contextRefs)) for (const ref of card.contextRefs) ids.add(ref.id);
      }
      for (const state of [...undoStack, ...redoStack]) {
        for (const card of state.cards) {
          if (Array.isArray(card.contextRefs)) for (const ref of card.contextRefs) ids.add(ref.id);
        }
      }
      return ids;
    },
    getStats() {
      return {
        undoCount: undoStack.length, redoCount: redoStack.length, maxDepth: depthLimit,
        retainedBytes, maxRetainedBytes: byteLimit, contentCount: contents.size, trimmedCount, budgetTrimmedCount,
      };
    },
  };
}

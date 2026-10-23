import { assertFunction, assertFunctions, assertOptionalFunctions, assertCardsArray } from './panel-contracts.js';

/**
 * 全画布搜索的界面编排：高亮、跳转、防抖。
 *
 * 纯检索与导航计算在 panel-search.js，这里只管「什么时候扫、扫完怎么画」。
 *
 * 两处容易忽略的约束：
 * 一是搜索结果是一份快照，卡片可能在这之后被删掉，跳转前必须剔除已消失的，
 * 否则会飞到一个不存在的位置，屏幕上什么都看不见；
 * 二是防抖定时器要能随面板一起清掉，不然关掉的画布还在摸已经没了的 DOM。
 */

export function createSearchController(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createSearchController: deps must be an object');
  }

  assertFunctions(deps, [
    'getCards', 'getIsDisposed', 'selectCard', 'ensureCardInView',
    'findCardsByKeyword', 'getNextMatchIndex', 'bindSearchBarController',
    'listen', 'setTimeoutRef', 'clearTimeoutRef', 'trackTimer', 'untrackTimer'
  ], 'createSearchController');

  assertOptionalFunctions(deps, ['getDocumentRef'], 'createSearchController');

  const {
    getCards,
    getDocumentRef,
    getIsDisposed,
    selectCard,
    ensureCardInView,
    findCardsByKeyword,
    getNextMatchIndex,
    bindSearchBarController,
    searchBarEl,
    searchInputEl,
    counterEl,
    btnPrev,
    btnNext,
    btnClose,
    listen,
    setTimeoutRef,
    clearTimeoutRef,
    trackTimer,
    untrackTimer,
  } = deps;

  let searchMatches = [];
  let currentSearchIndex = -1;
  let searchDebounceTimer = null;
  let controller = null;

  const cardsNow = () => assertCardsArray(getCards(), 'search-controller');
  const doc = () => (typeof getDocumentRef === 'function' ? getDocumentRef() : null);
  const listItem = id => doc()?.getElementById?.(`dom-${id}`) || null;

  function clearSearchHighlights() {
    for (const card of cardsNow()) {
      listItem(card.id)?.classList.remove('is-search-match', 'is-search-active');
    }
  }

  function focusSearchMatch(index) {
    const cards = cardsNow();
    const liveIds = new Set(cards.map(c => c.id));

    if (searchMatches.some(c => !liveIds.has(c.id))) {
      const anchored = searchMatches[index];
      const kept = searchMatches.filter(c => liveIds.has(c.id));
      searchMatches = kept;
      if (!kept.length) {
        currentSearchIndex = -1;
        controller?.updateCounter?.(-1, 0);
        return;
      }
      const nextIndex = anchored ? kept.findIndex(c => c.id === anchored.id) : -1;
      index = nextIndex >= 0 ? nextIndex : Math.min(index, kept.length - 1);
      currentSearchIndex = index;
    }

    if (index < 0 || index >= searchMatches.length) return;

    for (const card of cards) listItem(card.id)?.classList.remove('is-search-active');

    const target = searchMatches[index];
    if (!target) return;
    listItem(target.id)?.classList.add('is-search-active');
    selectCard(target.id, false);
    ensureCardInView(target);
  }

  function runSearch(query) {
    clearSearchHighlights();
    searchMatches = findCardsByKeyword({ cards: cardsNow(), query });
    if (searchMatches.length > 0) {
      currentSearchIndex = 0;
      for (const card of searchMatches) listItem(card.id)?.classList.add('is-search-match');
      focusSearchMatch(0);
    } else {
      currentSearchIndex = -1;
    }
    controller.updateCounter(currentSearchIndex, searchMatches.length);
  }

  controller = bindSearchBarController({
    searchBarEl,
    inputEl: searchInputEl,
    counterEl,
    btnPrev,
    btnNext,
    btnClose,
    onSearch: (query) => {
      // 每敲一个字就全画布扫一遍，卡片一多就明显卡顿。空查询例外：清空要立刻见效。
      if (searchDebounceTimer) clearTimeoutRef(searchDebounceTimer);
      const run = () => {
        searchDebounceTimer = null;
        if (getIsDisposed()) return;
        runSearch(query);
      };
      if (!query) { run(); return; }
      searchDebounceTimer = setTimeoutRef(run, 120);
      trackTimer(searchDebounceTimer);
    },
    onNavigate: (direction) => {
      if (searchMatches.length === 0) return;
      currentSearchIndex = getNextMatchIndex({
        currentIndex: currentSearchIndex,
        totalCount: searchMatches.length,
        direction,
      });
      focusSearchMatch(currentSearchIndex);
      controller.updateCounter(currentSearchIndex, searchMatches.length);
    },
    onClose: () => {
      if (searchDebounceTimer) {
        clearTimeoutRef(searchDebounceTimer);
        untrackTimer(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      clearSearchHighlights();
      searchMatches = [];
      currentSearchIndex = -1;
    },
    listen,
  });

  return {
    controller,
    clearSearchHighlights,
    focusSearchMatch,
    getMatches: () => searchMatches,
    getIndex: () => currentSearchIndex,
  };
}

/**
 * 画布视图、连线、选择与导航控制器模块
 *
 * 负责画布视口矩阵更新、平移/缩放交互绑定与销毁、卡片选中、按键焦点导航、
 * 贝塞尔连线渲染、集群视野对齐（含真实 DOM 高度回退阶梯与折叠包围盒过滤）
 * 以及一键树状自动排版。
 * 严禁在顶层访问裸 window 或 document，不反向依赖 panel.js。
 */

import { renderConnectorsLayer, renderReferenceConnectors } from './panel-connectors.js';
import { cardParentIds, cardHasParent } from './panel-context.js';
import {
  computeVisibleCards,
  calculateBranchYPositions as calculateBranchYPositionsLayout,
  fitViewportToCluster as fitViewportToClusterLayout,
  computeAutoTidyPositions,
} from './panel-layout.js';
import {
  applyViewportTransform,
  bindViewportController,
  computeCenterOnCard,
  computeEnsureCardVisible,
} from './panel-viewport.js';
import { findCardByDirection } from './panel-shortcuts.js';
import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertCardsArray } from './panel-contracts.js';
import { setCardGeometry } from './panel-cards.js';

export function createCanvasViewController(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createCanvasViewController: deps must be an object');
  }

  assertFunctions(deps, [
    'getCards', 'getSelectedCardId', 'setSelectedCardId', 'canMutateCanvas',
    'renderCards', 'scheduleSave', 'recordSnapshot', 'clearMultiSelect'
  ], 'createCanvasViewController');

  assertObject(deps.view, 'view', 'createCanvasViewController');

  assertOptionalFunctions(deps, [
    'listen', 'later', 'getIsSpacePressed', 'isDisposed'
  ], 'createCanvasViewController');

  const {
    getCards,
    getSelectedCardId,
    setSelectedCardId,
    view,
    multiSelectedCardIds,
    surface,
    viewport,
    zoomText,
    connectorsSvg,
    refConnectorsSvg,
    btnZoomIn,
    btnZoomOut,
    getIsSpacePressed,
    canMutateCanvas,
    renderCards,
    scheduleSave,
    recordSnapshot,
    clearMultiSelect,
    isDisposed,
    listen,
    later,
    documentRef,
    windowRef,
  } = deps;

  const getDoc = () => (typeof documentRef === 'function' ? documentRef() : (documentRef || (typeof document !== 'undefined' ? document : null)));
  const getWin = () => (typeof windowRef === 'function' ? windowRef() : (windowRef || (typeof window !== 'undefined' ? window : null)));
  const checkDisposed = () => (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));

  // 更新画布平移与缩放矩阵
  function updateTransform() {
    if (checkDisposed()) return;
    applyViewportTransform({ surface, viewport, zoomText, view, isDisposed: checkDisposed() });
    scheduleSave?.();
  }

  // 绘制所有卡片之间的贝塞尔曲线（支持单亲与多亲收敛节点）
  function renderConnectors() {
    if (checkDisposed()) return;
    const cards = assertCardsArray(getCards(), 'canvas-view:renderConnectors');
    const { visibleCards } = computeVisibleCards({ cards, cardParentIds });
    renderConnectorsLayer({
      svg: connectorsSvg,
      cards: visibleCards,
      cardParentIds,
      cardHasParent,
      documentRef: getDoc(),
    });
    // 引用虚线单独一层：不混进父边的元素计数与复用键，缺端点自然不画
    renderReferenceConnectors({
      svg: refConnectorsSvg,
      cards: visibleCards,
      documentRef: getDoc(),
    });
  }

  // 视口自动对齐与缩放以完整容纳目标卡片集群
  function fitViewportToCluster(clusterCards) {
    if (checkDisposed() || !Array.isArray(clusterCards) || clusterCards.length === 0) return;
    const doc = getDoc();
    // 卡片的 data 高度不一定等于屏幕上的高度（长文档卡会被 CSS 撑开），
    // 先按 DOM 实测补一次，否则算出来的垂直中心偏高。
    const measured = clusterCards.map(c => {
      const el = doc?.getElementById?.(`dom-${c.id}`);
      const h = el?.offsetHeight;
      return (typeof h === 'number' && h > 0) ? { ...c, height: h } : c;
    });
    fitViewportToClusterLayout(measured, { viewport, view });
    updateTransform();
  }

  // 计算分支子卡片在 Y 轴上的防重叠目标坐标
  function calculateBranchYPositions(parentCard, count, targetX) {
    const cards = assertCardsArray(getCards(), 'canvas-view:calculateBranchYPositions');
    return calculateBranchYPositionsLayout(parentCard, count, targetX, cards);
  }

  // 选中指定卡片，并可联动聚焦其输入框
  function selectCard(cardId, focusInput = false) {
    if (checkDisposed()) return;
    if (setSelectedCardId) setSelectedCardId(cardId);
    const cards = assertCardsArray(getCards(), 'canvas-view:selectCard');
    const doc = getDoc();
    cards.forEach(c => {
      const el = doc?.getElementById?.(`dom-${c.id}`);
      if (el) {
        if (c.id === cardId) el.classList.add('is-selected-card');
        else el.classList.remove('is-selected-card');
      }
    });
    if (cardId && focusInput) {
      const inputEl = doc?.getElementById?.(`input-${cardId}`);
      inputEl?.focus?.({ preventScroll: true });
    }
  }

  // 视口平移边界检查：确保卡片完全可见
  function ensureCardInView(card) {
    if (checkDisposed() || !card) return;
    const vpRect = viewport?.getBoundingClientRect?.() || { width: 1000, height: 700 };
    const next = computeEnsureCardVisible({
      card,
      view,
      viewportWidth: vpRect.width || 1000,
      viewportHeight: vpRect.height || 700,
      margin: 60,
    });
    if (next.x !== view.x || next.y !== view.y) {
      view.x = next.x;
      view.y = next.y;
      updateTransform();
    }
  }

  // 视口平移居中指定卡片（高防偏离：支持真实 DOM 高度回退阶梯与呼吸脉冲高亮）
  function focusCardInViewport(card) {
    if (checkDisposed() || !card) return;
    const vpRect = viewport?.getBoundingClientRect?.() || { width: 1000, height: 700 };
    const cardW = card.width || 360;
    // 高度不能写死：长文档卡能到八九百像素，按 340 算出来的中心会明显偏上
    const doc = getDoc();
    const domEl = doc?.getElementById?.(`dom-${card.id}`);
    const cardH = (typeof domEl?.offsetHeight === 'number' && domEl.offsetHeight > 0)
      ? domEl.offsetHeight
      : (card.height || 360);
    const next = computeCenterOnCard({
      card: { ...card, width: cardW, height: cardH },
      viewportWidth: vpRect.width || 1000,
      viewportHeight: vpRect.height || 700,
      scale: view.scale,
    });

    view.x = next.x;
    view.y = next.y;
    updateTransform();

    const el = doc?.getElementById?.(`dom-${card.id}`);
    if (el) {
      el.classList.add('is-imported-pulse');
      const scheduleLater = typeof later === 'function' ? later : (cb, ms) => setTimeout(cb, ms);
      scheduleLater(() => {
        el.classList.remove('is-imported-pulse');
      }, 2000);
    }
  }

  // 依据拓扑关系（父、子、兄、弟）通过键盘方向键移动焦点卡片
  function navigateCardFocus(direction) {
    const cards = assertCardsArray(getCards(), 'canvas-view:navigateCardFocus');
    const selectedCardId = getSelectedCardId ? getSelectedCardId() : null;
    const target = findCardByDirection({
      cards,
      selectedCardId,
      direction,
      cardParentIds,
      cardHasParent,
    });
    if (target) {
      selectCard(target.id, false);
      ensureCardInView(target);
    }
  }

  /** 当前真正显示在画布上的卡片（折叠的子分支不算） */
  function visibleCardsForFraming() {
    const cards = assertCardsArray(getCards(), 'canvas-view:visibleCardsForFraming');
    try {
      const { visibleCards } = computeVisibleCards({ cards, cardParentIds });
      return visibleCards.length ? visibleCards : cards;
    } catch {
      return cards;
    }
  }

  // 树状一键自动整理排版算法 (Auto-Tidy Engine)
  function autoTidyLayout() {
    if (canMutateCanvas && !canMutateCanvas()) return;
    const cards = assertCardsArray(getCards(), 'canvas-view:autoTidyLayout');
    if (!cards || cards.length === 0) return;
    const positions = computeAutoTidyPositions(cards, cardParentIds);
    cards.forEach(c => {
      const pos = positions.get(c.id);
      if (pos) {
        setCardGeometry(c, { x: pos.x, y: pos.y });
      }
    });

    renderCards?.();
    scheduleSave?.();
    // 只框可见的那部分。折叠起来的子孙如果也参与包围盒，
    // 视野会被压得很小，屏幕上留一大片空白。
    fitViewportToCluster(visibleCardsForFraming());
    const selectedCardId = getSelectedCardId ? getSelectedCardId() : null;
    recordSnapshot?.(cards, selectedCardId);
  }

  // 重置或居中视口：有卡片居中可见集群，无卡片重置到初始原点 (60, 40, scale=1)
  function resetView() {
    if (checkDisposed()) return;
    const cards = assertCardsArray(getCards(), 'canvas-view:resetView');
    if (cards.length > 0) {
      fitViewportToCluster(visibleCardsForFraming());
      return;
    }
    view.x = 60;
    view.y = 40;
    view.scale = 1;
    updateTransform();
  }

  let viewportController = null;

  function bind() {
    if (viewportController) return viewportController;
    viewportController = bindViewportController({
      viewport,
      surface,
      zoomText,
      btnZoomIn,
      btnZoomOut,
      view,
      getState: () => ({
        isDisposed: checkDisposed(),
        isSpacePressed: typeof getIsSpacePressed === 'function' ? getIsSpacePressed() : false,
        onCanvasMouseDown: () => {
          clearMultiSelect?.();
          selectCard(null);
        },
      }),
      onTransformChange: () => {
        scheduleSave?.();
      },
      listen,
      windowRef: getWin(),
    });
    return viewportController;
  }

  function cleanup() {
    if (viewportController) {
      viewportController.cleanup();
      viewportController = null;
    }
  }

  return {
    updateTransform,
    renderConnectors,
    fitViewportToCluster,
    calculateBranchYPositions,
    selectCard,
    ensureCardInView,
    focusCardInViewport,
    navigateCardFocus,
    autoTidyLayout,
    visibleCardsForFraming,
    resetView,
    bind,
    cleanup,
  };
}

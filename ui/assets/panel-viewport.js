/**
 * panel-viewport.js
 * 画布二维视口（平移、缩放、聚焦定位与坐标投影）独立控制引擎
 */

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2.2;
export const DEFAULT_GRID_SIZE = 24;

/**
 * 限制视口缩放比例在安全阈值区间内
 */
export function clampScale(scale, min = MIN_SCALE, max = MAX_SCALE) {
  if (typeof scale !== 'number' || Number.isNaN(scale)) return 1.0;
  return Math.min(Math.max(scale, min), max);
}

/**
 * 以视口指定坐标 (mouseX, mouseY) 为锚点计算缩放后的新坐标与缩放比例
 * 几何约束：缩放中心在缩放前后相对于视口屏幕的位置保持恒定
 */
export function computeZoomAtPoint({ view, mouseX, mouseY, factor, min = MIN_SCALE, max = MAX_SCALE }) {
  if (!view) return { x: 0, y: 0, scale: 1.0 };
  const currentScale = view.scale || 1.0;
  const newScale = clampScale(currentScale * factor, min, max);
  if (newScale === currentScale) {
    return { x: view.x, y: view.y, scale: currentScale };
  }

  const ratio = newScale / currentScale;
  const newX = mouseX - (mouseX - view.x) * ratio;
  const newY = mouseY - (mouseY - view.y) * ratio;

  return {
    x: Math.round(newX * 100) / 100,
    y: Math.round(newY * 100) / 100,
    scale: newScale,
  };
}

/**
 * 计算将指定卡片平移居中至视口中央所需的 (x, y) 坐标
 */
export function computeCenterOnCard({ card, viewportWidth = 1000, viewportHeight = 700, scale = 1.0 }) {
  if (!card) return { x: 0, y: 0 };
  const cardW = card.width || 340;
  const cardH = card.height || 360;
  return {
    x: Math.round(viewportWidth / 2 - (card.x + cardW / 2) * scale),
    y: Math.round(viewportHeight / 2 - (card.y + cardH / 2) * scale),
  };
}

/**
 * 计算卡片超出视口安全边界时的平移修正量
 * 如果卡片完全在安全视口内，返回原有 (view.x, view.y)
 */
export function computeEnsureCardVisible({ card, view, viewportWidth = 1000, viewportHeight = 700, margin = 40 }) {
  if (!card || !view) return { x: 0, y: 0 };
  const scale = view.scale || 1.0;
  const screenX = card.x * scale + view.x;
  const screenY = card.y * scale + view.y;
  const cardW = (card.width || 340) * scale;
  const cardH = (card.height || 360) * scale;

  let nextX = view.x;
  let nextY = view.y;

  if (screenX < margin) {
    nextX += (margin - screenX);
  } else if (screenX + cardW > viewportWidth - margin) {
    nextX -= (screenX + cardW - (viewportWidth - margin));
  }

  if (screenY < margin) {
    nextY += (margin - screenY);
  } else if (screenY + cardH > viewportHeight - margin) {
    nextY -= (screenY + cardH - (viewportHeight - margin));
  }

  return {
    x: Math.round(nextX),
    y: Math.round(nextY),
  };
}

/**
 * 将视口状态同步应用至 DOM 容器变换与背景网格
 */
export function applyViewportTransform({ surface, viewport, zoomText, view, isDisposed = false, gridSize = DEFAULT_GRID_SIZE }) {
  if (isDisposed || !view) return;
  if (surface && surface.style) {
    surface.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }
  if (zoomText) {
    zoomText.textContent = `${Math.round(view.scale * 100)}%`;
  }
  if (viewport && viewport.style) {
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    viewport.style.backgroundSize = `${gridSize * view.scale}px ${gridSize * view.scale}px`;
  }
}

/**
 * 绑定画布视口拖拽平移、滚轮以指针为中心缩放与缩放按钮交互
 * 返回包含 updateTransform 及 cleanup 闭环销毁回调的控制器对象
 */
export function bindViewportController({
  viewport,
  surface,
  zoomText,
  btnZoomIn,
  btnZoomOut,
  view,
  getState = () => ({ isDisposed: false, isSpacePressed: false }),
  onTransformChange = () => {},
  listen,
  windowRef = typeof window !== 'undefined' ? window : null,
}) {
  const cleanups = [];
  const addListener = (target, event, handler, options) => {
    if (!target) return;
    if (typeof listen === 'function') {
      cleanups.push(listen(target, event, handler, options));
    } else if (typeof target.addEventListener === 'function') {
      target.addEventListener(event, handler, options);
      cleanups.push(() => target.removeEventListener(event, handler, options));
    }
  };

  const updateTransform = () => {
    const state = getState();
    if (state.isDisposed) return;
    applyViewportTransform({ surface, viewport, zoomText, view, isDisposed: state.isDisposed });
    onTransformChange();
  };

  // 1. 视口按键按下 (mousedown)
  if (viewport) {
    addListener(viewport, 'mousedown', (e) => {
      const state = getState();
      if (state.isDisposed || e.button !== 0) return;

      if (state.isSpacePressed) {
        view.isDragging = true;
        view.dragStartX = e.clientX - view.x;
        view.dragStartY = e.clientY - view.y;
        viewport.classList?.add('is-dragging-canvas');
        e.preventDefault?.();
        return;
      }

      if (e.target?.closest?.('.chat-card, .floating-zoom-bar, .canvas-header, .floating-merge-toolbar')) {
        return;
      }

      state.onCanvasMouseDown?.(e);

      view.isDragging = true;
      view.dragStartX = e.clientX - view.x;
      view.dragStartY = e.clientY - view.y;
      viewport.classList?.add('is-dragging-canvas');
    });

    // 2. 滚轮以鼠标坐标为中心缩放 (wheel)
    addListener(viewport, 'wheel', (e) => {
      const state = getState();
      if (state.isDisposed) return;
      // 卡片内部的正文区自己要能滚。以前这里无条件接管滚轮，
      // 结果鼠标停在长回答上滚一下就变成画布缩放，卡片里根本翻不动。
      const scrollHost = e.target?.closest?.('.card-body, .bridge-preview, .card-attachment-body');
      if (scrollHost) {
        const canScroll = (scrollHost.scrollHeight || 0) > (scrollHost.clientHeight || 0) + 1;
        if (canScroll) return;
      }
      e.preventDefault?.();

      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      const rect = viewport.getBoundingClientRect?.() || { left: 0, top: 0 };
      const mouseX = e.clientX - (rect.left || 0);
      const mouseY = e.clientY - (rect.top || 0);

      const next = computeZoomAtPoint({
        view,
        mouseX,
        mouseY,
        factor: zoomFactor,
      });

      view.x = next.x;
      view.y = next.y;
      view.scale = next.scale;

      updateTransform();
    }, { passive: false });
  }

  // 3. 全局鼠标移动与释放 (mousemove / mouseup)
  if (windowRef) {
    addListener(windowRef, 'mousemove', (e) => {
      const state = getState();
      if (state.isDisposed || !view.isDragging) return;
      view.x = e.clientX - view.dragStartX;
      view.y = e.clientY - view.dragStartY;
      updateTransform();
    });

    addListener(windowRef, 'mouseup', () => {
      if (view.isDragging) {
        view.isDragging = false;
        viewport?.classList?.remove('is-dragging-canvas');
      }
    });
  }

  // 4. 缩放控制按钮 (Zoom In / Out)
  const zoomIn = () => {
    const state = getState();
    if (state.isDisposed) return;
    view.scale = clampScale(view.scale * 1.15);
    updateTransform();
  };

  const zoomOut = () => {
    const state = getState();
    if (state.isDisposed) return;
    view.scale = clampScale(view.scale * 0.85);
    updateTransform();
  };

  const resetView = () => {
    const state = getState();
    if (state.isDisposed) return;
    view.x = 60;
    view.y = 40;
    view.scale = 1.0;
    view.isDragging = false;
    updateTransform();
  };

  if (btnZoomIn) addListener(btnZoomIn, 'click', zoomIn);
  if (btnZoomOut) addListener(btnZoomOut, 'click', zoomOut);

  return {
    updateTransform,
    zoomIn,
    zoomOut,
    resetView,
    cleanup: () => {
      while (cleanups.length > 0) {
        const disposeFn = cleanups.pop();
        try { disposeFn?.(); } catch {}
      }
      if (view) view.isDragging = false;
      viewport?.classList?.remove('is-dragging-canvas');
    },
  };
}

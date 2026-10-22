/**
 * 卡片上的两种鼠标手势：拖 header 移动，拖右/下/右下角改尺寸。
 *
 * 两者共用同一套收尾逻辑——鼠标拖出窗口再松手时 window 收不到 mouseup，
 * 所以 mouseup 和 blur 都要能结束手势，否则类和光标会一直粘着。
 */

const MIN_WIDTH = 260;
const MAX_WIDTH = 1200;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 1600;

export function createCardGestures(deps) {
  const {
    listen,
    getSession,
    getCards,
    getView,
    getIsSpacePressed,
    getSelectedCardId,
    getDocumentRef,
    renderConnectors,
    scheduleSave,
    recordSnapshot,
    getIsDisposed,
    getWindowRef,
  } = deps;

  const cardsNow = () => getCards() || [];
  // window 由入口注入：这个模块在测试里是原生 import 的，拿不到 VM 里的全局。
  const win = () => (typeof getWindowRef === 'function' ? getWindowRef() : null);
  const doc = () => (typeof getDocumentRef === 'function' ? getDocumentRef() : null);

  function canStart() {
    const session = getSession();
    return Boolean(session && session.state && session.state.ready && !session.state.busy);
  }

  /** 拖 header 移动卡片。 */
  function beginCardDrag({ card, cardEl, event }) {
    if (typeof getIsSpacePressed === 'function' && getIsSpacePressed()) return;

    const active = doc()?.activeElement;
    if (active && active !== doc()?.body && typeof active.blur === 'function') {
      active.blur();
    }
    event.stopPropagation();
    if (!canStart()) return;

    const session = getSession();
    const generation = session.generation;
    const startMouseX = event.clientX;
    const startMouseY = event.clientY;
    const startCardX = card.x;
    const startCardY = card.y;
    const scale = () => getView().scale || 1;

    const onMouseMove = (moveEvent) => {
      if (getSession().generation !== generation || !cardsNow().includes(card)) return;
      const dx = (moveEvent.clientX - startMouseX) / scale();
      const dy = (moveEvent.clientY - startMouseY) / scale();
      card.x = Math.round(startCardX + dx);
      card.y = Math.round(startCardY + dy);
      cardEl.style.left = `${card.x}px`;
      cardEl.style.top = `${card.y}px`;
      renderConnectors();
    };

    const onMouseUp = () => {
      stopMove();
      stopUp();
      stopBlur();
      if (getSession().generation !== generation) return;
      scheduleSave();
      // 只挪了几个像素也算动过位置，那就得记一步，不然撤销回不去。
      if (card.x !== startCardX || card.y !== startCardY) {
        recordSnapshot(cardsNow(), getSelectedCardId());
      }
    };

    const stopMove = listen(win(), 'mousemove', onMouseMove);
    const stopUp = listen(win(), 'mouseup', onMouseUp);
    const stopBlur = listen(win(), 'blur', onMouseUp);
  }

  /**
   * 三个缩放手柄共用一套逻辑，靠 direction 区分改宽、改高还是都改。
   * 卡片的初始高度优先读 DOM 实测值——样式表给的默认高度和实际渲染可能不一致。
   */
  function bindResizeHandle({ card, cardEl, handle, direction }) {
    if (!handle || handle.__resizeBound) return;
    handle.__resizeBound = true;

    listen(handle, 'mousedown', (e) => {
      if (typeof getIsSpacePressed === 'function' && getIsSpacePressed()) return;
      e.stopPropagation();
      e.preventDefault();
      if (!canStart()) return;

      const session = getSession();
      const generation = session.generation;
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;
      const startWidth = card.width || 340;
      const startHeight = card.height || cardEl.offsetHeight || 360;
      const bodyEl = doc();

      cardEl.classList.add('is-resizing');
      bodyEl?.body?.classList.add('is-card-resizing');
      if (direction === 'bottom') bodyEl?.body?.classList.add('resizing-s');
      else if (direction === 'corner') bodyEl?.body?.classList.add('resizing-se');
      else bodyEl?.body?.classList.add('resizing-ew');

      const clearClasses = () => {
        cardEl.classList.remove('is-resizing');
        bodyEl?.body?.classList.remove('is-card-resizing', 'resizing-s', 'resizing-se', 'resizing-ew');
      };

      const onMouseMove = (moveEvent) => {
        if (getSession().generation !== generation || !cardsNow().includes(card)) return;
        const scale = getView().scale || 1;
        const dx = (moveEvent.clientX - startMouseX) / scale;
        const dy = (moveEvent.clientY - startMouseY) / scale;

        if (direction === 'right' || direction === 'corner') {
          const next = Math.min(Math.max(Math.round(startWidth + dx), MIN_WIDTH), MAX_WIDTH);
          card.width = next;
          cardEl.style.width = `${next}px`;
        }
        if (direction === 'bottom' || direction === 'corner') {
          const next = Math.min(Math.max(Math.round(startHeight + dy), MIN_HEIGHT), MAX_HEIGHT);
          card.height = next;
          cardEl.style.height = `${next}px`;
          cardEl.classList.add('has-custom-height');
          const inner = cardEl.querySelector(`#body-${card.id}`);
          if (inner) {
            inner.style.maxHeight = 'none';
            inner.style.flex = '1 1 0';
          }
        }
        renderConnectors();
      };

      const onMouseUp = () => {
        clearClasses();
        stopMove();
        stopUp();
        stopBlur();
        if (getSession().generation !== generation) return;
        scheduleSave();
        if (card.width !== startWidth || card.height !== startHeight) {
          recordSnapshot(cardsNow(), getSelectedCardId());
        }
      };

      const stopMove = listen(win(), 'mousemove', onMouseMove);
      const stopUp = listen(win(), 'mouseup', onMouseUp);
      const stopBlur = listen(win(), 'blur', onMouseUp);
    });
  }

  /** 一张卡片的全部缩放手柄。旧的 [data-action="resize-card"] 和右侧手柄是同一个方向。 */
  function bindResizeHandles({ card, cardEl }) {
    bindResizeHandle({ card, cardEl, handle: cardEl.querySelector('[data-direction="right"]'), direction: 'right' });
    bindResizeHandle({ card, cardEl, handle: cardEl.querySelector('[data-direction="bottom"]'), direction: 'bottom' });
    bindResizeHandle({ card, cardEl, handle: cardEl.querySelector('[data-direction="corner"]'), direction: 'corner' });
    bindResizeHandle({ card, cardEl, handle: cardEl.querySelector('[data-action="resize-card"]'), direction: 'right' });
  }

  /** 面板销毁时清掉可能残留的手势类名。 */
  function clearGestureClasses() {
    const root = doc();
    root?.body?.classList.remove('is-card-resizing', 'resizing-s', 'resizing-se', 'resizing-ew');
    for (const card of cardsNow()) {
      root?.getElementById?.(`dom-${card.id}`)?.classList.remove('is-resizing', 'card-drop-active');
    }
  }

  return { beginCardDrag, bindResizeHandles, clearGestureClasses };
}

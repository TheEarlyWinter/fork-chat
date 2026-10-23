/**
 * 界面通用反馈服务模块 (Toast / Flash Message)
 *
 * 独立管理悬浮提示的 DOM 创建、文本更新、淡入淡出及定时销毁生命周期。
 * 严禁在顶层访问裸 window 或 document，严格遵守 fail-fast 依赖与时钟生命周期管理。
 */

export function createFeedbackService(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createFeedbackService: deps must be an object');
  }

  const {
    documentRef,
    later,
    cancelLater,
    isDisposed = () => false,
  } = deps;

  if (later !== undefined && typeof later !== 'function') {
    throw new TypeError("createFeedbackService: optional 'later' must be a function");
  }
  if (cancelLater !== undefined && typeof cancelLater !== 'function') {
    throw new TypeError("createFeedbackService: optional 'cancelLater' must be a function");
  }
  if (isDisposed !== undefined && typeof isDisposed !== 'function') {
    throw new TypeError("createFeedbackService: optional 'isDisposed' must be a function");
  }

  const getDoc = () => (typeof documentRef === 'function' ? documentRef() : (documentRef || null));
  const checkDisposed = () => (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));

  let localDisposed = false;
  let flashTimerId = null;

  function flashMessage(text) {
    if (localDisposed || checkDisposed()) return;
    const doc = getDoc();
    if (!doc) return;

    let el = doc.getElementById ? doc.getElementById('fork-flash') : null;
    if (!el && doc.createElement) {
      el = doc.createElement('div');
      el.id = 'fork-flash';
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:60px', 'transform:translateX(-50%)',
        'max-width:min(560px, 78vw)', 'padding:11px 17px', 'border-radius:6px',
        'font-size:12.5px', 'line-height:1.75', 'z-index:9999', 'pointer-events:none',
        'transition:opacity .35s', 'background:#40221f', 'color:#f6ece9',
        'border:1px solid #6b3a34', 'font-family:inherit', 'box-shadow:0 6px 20px rgba(0,0,0,.22)',
      ].join(';');
      doc.body?.appendChild?.(el);
    }
    if (!el) return;

    el.textContent = String(text ?? '');
    el.style.opacity = '1';

    if (typeof cancelLater === 'function' && flashTimerId != null) {
      cancelLater(flashTimerId);
      flashTimerId = null;
    }
    if (typeof later === 'function') {
      flashTimerId = later(() => {
        if (!localDisposed && !checkDisposed() && el) {
          el.style.opacity = '0';
        }
      }, 4600);
    }
  }

  function dispose() {
    if (localDisposed) return;
    localDisposed = true;
    if (typeof cancelLater === 'function' && flashTimerId != null) {
      cancelLater(flashTimerId);
      flashTimerId = null;
    }
    const doc = getDoc();
    const el = doc?.getElementById ? doc.getElementById('fork-flash') : null;
    if (el) {
      el.style.opacity = '0';
    }
  }

  return {
    flashMessage,
    dispose,
    isDisposed: () => localDisposed || checkDisposed(),
  };
}

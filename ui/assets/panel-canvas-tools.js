/**
 * panel-canvas-tools.js
 * 画布控制岛视口辅助工具：全屏沉浸模式与快捷键速查对话框
 *
 * 严格遵守单向依赖与 fail-fast 契约，不反向引用 panel.js，不访问裸全局 DOM。
 */

import { assertFunction, assertObject } from './panel-contracts.js';

export function createCanvasTools(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createCanvasTools: deps must be an object');
  }

  const {
    documentRef,
    fullscreenTarget,
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen,
    flashMessage,
    isDisposed = () => false,
  } = deps;

  // 依赖 fail-fast 断言
  assertObject(documentRef, 'documentRef', 'createCanvasTools');
  assertObject(fullscreenTarget, 'fullscreenTarget', 'createCanvasTools');
  assertObject(btnFullscreen, 'btnFullscreen', 'createCanvasTools');
  assertObject(btnShortcuts, 'btnShortcuts', 'createCanvasTools');
  assertObject(shortcutsDialog, 'shortcutsDialog', 'createCanvasTools');
  assertObject(btnShortcutsClose, 'btnShortcutsClose', 'createCanvasTools');
  assertFunction(listen, 'listen', 'createCanvasTools');
  assertFunction(flashMessage, 'flashMessage', 'createCanvasTools');

  let localDisposed = false;
  const checkDisposed = () => localDisposed || (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));

  const cleanups = [];
  const addListener = (target, event, handler) => {
    if (!target) return;
    const unsub = listen(target, event, handler);
    if (typeof unsub === 'function') cleanups.push(unsub);
  };

  let previousActiveElement = null;

  function restoreFocus() {
    if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
      try {
        previousActiveElement.focus();
      } catch {}
    }
    previousActiveElement = null;
  }

  // 1. 快捷键帮助 Dialog
  function openShortcuts() {
    if (checkDisposed()) return;
    try {
      previousActiveElement = documentRef.activeElement || null;
      if (typeof shortcutsDialog.showModal === 'function') {
        shortcutsDialog.showModal();
      } else {
        flashMessage('当前环境不支持快捷键速查对话框。');
      }
    } catch {
      if (checkDisposed()) return;
      flashMessage('无法打开快捷键速查对话框。');
    }
  }

  function closeShortcuts() {
    if (checkDisposed()) return;
    try {
      if (typeof shortcutsDialog.close === 'function') {
        shortcutsDialog.close();
      } else {
        flashMessage('当前环境不支持关闭快捷键对话框。');
      }
    } catch {
      if (checkDisposed()) return;
      flashMessage('无法关闭快捷键速查对话框。');
    }
    restoreFocus();
  }

  addListener(btnShortcuts, 'click', (e) => {
    e?.preventDefault?.();
    openShortcuts();
  });

  addListener(btnShortcutsClose, 'click', (e) => {
    e?.preventDefault?.();
    closeShortcuts();
  });

  // 原生 dialog 触发 close 事件（包含 Escape 关闭）时归还焦点
  addListener(shortcutsDialog, 'close', () => {
    if (checkDisposed()) return;
    restoreFocus();
  });

  // 2. 全屏能力检测与状态管理
  function isFullscreenCapable() {
    return Boolean(
      documentRef.fullscreenEnabled &&
      typeof fullscreenTarget.requestFullscreen === 'function' &&
      typeof documentRef.exitFullscreen === 'function'
    );
  }

  function syncFullscreenButtonState() {
    if (checkDisposed()) return;
    const capable = isFullscreenCapable();
    if (!capable) {
      try {
        btnFullscreen.disabled = true;
        btnFullscreen.setAttribute?.('aria-disabled', 'true');
        btnFullscreen.setAttribute?.('aria-pressed', 'false');
        const disabledLabel = '全屏模式（当前环境不可用）';
        btnFullscreen.title = disabledLabel;
        btnFullscreen.setAttribute?.('aria-label', disabledLabel);
      } catch {}
      return;
    }

    try {
      btnFullscreen.disabled = false;
      btnFullscreen.removeAttribute?.('aria-disabled');
      const isFullscreen = documentRef.fullscreenElement === fullscreenTarget;
      btnFullscreen.setAttribute?.('aria-pressed', String(isFullscreen));
      const label = isFullscreen ? '退出全屏' : '全屏模式';
      btnFullscreen.title = label;
      btnFullscreen.setAttribute?.('aria-label', label);
    } catch {}
  }

  // 初始化按钮状态
  syncFullscreenButtonState();

  addListener(documentRef, 'fullscreenchange', () => {
    syncFullscreenButtonState();
  });

  addListener(btnFullscreen, 'click', async (e) => {
    e?.preventDefault?.();
    if (checkDisposed()) return;

    if (!isFullscreenCapable()) {
      flashMessage('当前宿主环境不支持全屏模式。');
      return;
    }

    const isFullscreen = documentRef.fullscreenElement === fullscreenTarget;
    if (isFullscreen) {
      try {
        await documentRef.exitFullscreen();
      } catch {
        if (checkDisposed()) return;
        flashMessage('退出全屏失败。');
      }
    } else {
      try {
        await fullscreenTarget.requestFullscreen();
      } catch {
        if (checkDisposed()) return;
        flashMessage('全屏模式被禁止或请求失败。');
      }
    }
  });

  function dispose() {
    if (localDisposed) return;
    localDisposed = true;
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      try { cleanup?.(); } catch {}
    }
    previousActiveElement = null;
  }

  return {
    dispose,
  };
}

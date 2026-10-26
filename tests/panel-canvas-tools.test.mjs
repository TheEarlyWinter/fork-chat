import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasTools } from '../ui/assets/panel-canvas-tools.js';

test('createCanvasTools: 依赖 fail-fast 校验与结构检查', () => {
  assert.throws(
    () => createCanvasTools(null),
    /deps must be an object/,
    '必须传入 deps 对象'
  );

  assert.throws(
    () => createCanvasTools({}),
    /required/i,
    '缺少核心依赖必须抛错'
  );
});

test('createCanvasTools: 不支持全屏时点击全屏按钮降级并提示，不伪造成功', async () => {
  const flashCalls = [];
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => {};
  };

  const btnFullscreen = {
    disabled: false,
    title: '',
    setAttribute: (k, v) => { btnFullscreen[k] = v; },
    getAttribute: (k) => btnFullscreen[k],
  };
  const btnShortcuts = {};
  const btnShortcutsClose = {};
  const shortcutsDialog = { showModal: () => {}, close: () => {} };
  const documentRef = {
    fullscreenEnabled: false,
    fullscreenElement: null,
    activeElement: null,
  };
  const fullscreenTarget = {};

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget,
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: (msg) => flashCalls.push(msg),
  });

  // 断言初始化能力检测：禁用按钮并给出不可用说明
  assert.equal(btnFullscreen.disabled, true, '不支持全屏时必须设置 btnFullscreen.disabled = true');
  assert.equal(btnFullscreen['aria-disabled'], 'true', '不支持全屏时必须设置 aria-disabled="true"');
  assert.match(btnFullscreen.title, /不可用|不支持/, 'title 应明确说明全屏在当前环境不可用');
  assert.match(btnFullscreen['aria-label'], /不可用|不支持/, 'aria-label 应明确说明不可用');

  const clickHandler = listeners.find(l => l.target === btnFullscreen && l.event === 'click')?.handler;
  assert.ok(clickHandler, '应绑定全屏按钮点击');

  clickHandler({ preventDefault: () => {} });
  assert.equal(flashCalls.length, 1, '应调用 flashMessage 提示全屏不支持');
  assert.match(flashCalls[0], /当前宿主环境不支持全屏模式/, '提示语应包含明确的不支持说明');
  assert.notEqual(btnFullscreen['aria-pressed'], 'true', '不得伪造全屏成功');

  tools.dispose();
});

test('createCanvasTools: 支持全屏时进入与退出成功，fullscreenchange 同步按钮状态', async () => {
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => {};
  };

  const btnFullscreen = {
    disabled: true,
    title: '',
    ariaLabel: '',
    setAttribute: (k, v) => { btnFullscreen[k] = v; },
    getAttribute: (k) => btnFullscreen[k],
    removeAttribute: (k) => { delete btnFullscreen[k]; },
  };
  const btnShortcuts = {};
  const btnShortcutsClose = {};
  const shortcutsDialog = { showModal: () => {}, close: () => {} };

  let fsTarget = null;
  const documentRef = {
    fullscreenEnabled: true,
    get fullscreenElement() { return fsTarget; },
    exitFullscreen: async () => {
      fsTarget = null;
    },
  };

  const fullscreenTarget = {
    requestFullscreen: async () => {
      fsTarget = fullscreenTarget;
    },
  };

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget,
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: () => {},
  });

  // 支持时启用
  assert.equal(btnFullscreen.disabled, false, '支持全屏时 disabled 应为 false');
  assert.equal(btnFullscreen['aria-disabled'], undefined, '支持全屏时应移除 aria-disabled');
  assert.equal(btnFullscreen.title, '全屏模式', '支持全屏初始 title 应为全屏模式');

  const clickHandler = listeners.find(l => l.target === btnFullscreen && l.event === 'click')?.handler;
  const fsChangeHandler = listeners.find(l => l.target === documentRef && l.event === 'fullscreenchange')?.handler;
  assert.ok(fsChangeHandler, '应监听 documentRef 的 fullscreenchange 事件');

  // 点击进入全屏
  await clickHandler({ preventDefault: () => {} });
  assert.equal(fsTarget, fullscreenTarget, '应调用 requestFullscreen');

  // 触发 fullscreenchange
  fsChangeHandler();
  assert.equal(btnFullscreen['aria-pressed'], 'true', '进入全屏后 aria-pressed 应为 true');
  assert.equal(btnFullscreen.title, '退出全屏', '进入全屏后 title 应为退出全屏');

  // 点击退出全屏
  await clickHandler({ preventDefault: () => {} });
  assert.equal(fsTarget, null, '应调用 exitFullscreen');

  // 再次触发 fullscreenchange（模拟外部或 ESC 退出）
  fsChangeHandler();
  assert.equal(btnFullscreen['aria-pressed'], 'false', '退出全屏后 aria-pressed 应为 false');
  assert.equal(btnFullscreen.title, '全屏模式', '退出全屏后 title 应恢复为全屏模式');

  tools.dispose();
});

test('createCanvasTools: 全屏请求拒绝时捕获异常并提示，不产生未捕获 Promise', async () => {
  const flashCalls = [];
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => {};
  };

  const btnFullscreen = {
    setAttribute: (k, v) => { btnFullscreen[k] = v; },
    getAttribute: (k) => btnFullscreen[k],
  };
  const btnShortcuts = {};
  const btnShortcutsClose = {};
  const shortcutsDialog = { showModal: () => {}, close: () => {} };

  let requestCalled = false;
  const documentRef = {
    fullscreenEnabled: true,
    fullscreenElement: null,
    exitFullscreen: async () => {},
  };
  const fullscreenTarget = {
    requestFullscreen: () => {
      requestCalled = true;
      return Promise.reject(new Error('Permission denied by user or host'));
    },
  };

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget,
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: (msg) => flashCalls.push(msg),
  });

  const clickHandler = listeners.find(l => l.target === btnFullscreen && l.event === 'click')?.handler;
  // 点击请求被拒绝
  await clickHandler({ preventDefault: () => {} });
  assert.equal(requestCalled, true, '必须调用 requestFullscreen');
  assert.equal(flashCalls.length, 1, '全屏被拒应调用 flashMessage');
  assert.match(flashCalls[0], /全屏模式被禁止或请求失败/, '提示语应包含明确的拒绝原因');

  tools.dispose();
});

test('createCanvasTools: 进入全屏等待期间调用 dispose，后续 reject 不得 flashMessage', async () => {
  const flashCalls = [];
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => {};
  };

  const btnFullscreen = {
    setAttribute: (k, v) => { btnFullscreen[k] = v; },
    getAttribute: (k) => btnFullscreen[k],
  };
  const btnShortcuts = {};
  const btnShortcutsClose = {};
  const shortcutsDialog = { showModal: () => {}, close: () => {} };

  let rejectRequest;
  const requestPromise = new Promise((_, rej) => { rejectRequest = rej; });

  const documentRef = {
    fullscreenEnabled: true,
    fullscreenElement: null,
    exitFullscreen: async () => {},
  };
  const fullscreenTarget = {
    requestFullscreen: () => requestPromise,
  };

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget,
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: (msg) => flashCalls.push(msg),
  });

  const clickHandler = listeners.find(l => l.target === btnFullscreen && l.event === 'click')?.handler;
  const dispatchPromise = clickHandler({ preventDefault: () => {} });

  // 在等待期间销毁
  tools.dispose();

  // 随后 Promise 被拒绝
  rejectRequest(new Error('late rejection'));
  await dispatchPromise;

  assert.equal(flashCalls.length, 0, 'dispose 后即使全屏失败也严禁调用 flashMessage 或触碰 UI');
});

test('createCanvasTools: 退出全屏等待期间调用 dispose，后续 reject 不得 flashMessage', async () => {
  const flashCalls = [];
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => {};
  };

  const btnFullscreen = {
    setAttribute: (k, v) => { btnFullscreen[k] = v; },
    getAttribute: (k) => btnFullscreen[k],
  };
  const btnShortcuts = {};
  const btnShortcutsClose = {};
  const shortcutsDialog = { showModal: () => {}, close: () => {} };

  let rejectExit;
  const exitPromise = new Promise((_, rej) => { rejectExit = rej; });

  const fullscreenTarget = {
    requestFullscreen: async () => {},
  };
  const documentRef = {
    fullscreenEnabled: true,
    fullscreenElement: fullscreenTarget,
    exitFullscreen: () => exitPromise,
  };

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget,
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: (msg) => flashCalls.push(msg),
  });

  const clickHandler = listeners.find(l => l.target === btnFullscreen && l.event === 'click')?.handler;
  const dispatchPromise = clickHandler({ preventDefault: () => {} });

  // 等待期间销毁
  tools.dispose();

  // 随后退出失败被拒绝
  rejectExit(new Error('exit rejected'));
  await dispatchPromise;

  assert.equal(flashCalls.length, 0, '退出全屏等待期间销毁后不得 flashMessage');
});

test('createCanvasTools: 帮助对话框打开或关闭抛错时提供可见提示，不静默吞掉', () => {
  const flashCalls = [];
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => {};
  };

  const shortcutsDialog = {
    showModal: () => { throw new Error('showModal failed'); },
    close: () => { throw new Error('close failed'); },
  };

  const btnFullscreen = { setAttribute: () => {} };
  const btnShortcuts = {};
  const btnShortcutsClose = {};
  const documentRef = { fullscreenEnabled: false, fullscreenElement: null, activeElement: null };

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget: {},
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: (msg) => flashCalls.push(msg),
  });

  const openHandler = listeners.find(l => l.target === btnShortcuts && l.event === 'click')?.handler;
  const closeHandler = listeners.find(l => l.target === btnShortcutsClose && l.event === 'click')?.handler;

  openHandler({ preventDefault: () => {} });
  assert.equal(flashCalls.length, 1, 'showModal 抛错必须提示用户');
  assert.match(flashCalls[0], /快捷键/, '应说明快捷键对话框无法打开');

  closeHandler({ preventDefault: () => {} });
  assert.equal(flashCalls.length, 2, 'close 抛错必须提示用户');
  assert.match(flashCalls[1], /快捷键/, '应说明快捷键对话框无法关闭');

  tools.dispose();
});

test('createCanvasTools: 帮助 dialog 打开、关闭与焦点归还', () => {
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => {};
  };

  let modalOpened = false;
  let closeCallback = null;
  const shortcutsDialog = {
    showModal: () => { modalOpened = true; },
    close: () => {
      modalOpened = false;
      closeCallback?.();
    },
    addEventListener: (ev, fn) => {
      if (ev === 'close') closeCallback = fn;
    },
    removeEventListener: () => {},
  };

  let focusedElement = null;
  const openerButton = {
    id: 'btn-shortcuts',
    focus: () => { focusedElement = openerButton; },
  };

  const documentRef = {
    fullscreenEnabled: false,
    fullscreenElement: null,
    activeElement: openerButton,
  };

  const btnFullscreen = { setAttribute: () => {} };
  const btnShortcuts = openerButton;
  const btnShortcutsClose = {};

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget: {},
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: () => {},
  });

  const openHandler = listeners.find(l => l.target === btnShortcuts && l.event === 'click')?.handler;
  const closeBtnHandler = listeners.find(l => l.target === btnShortcutsClose && l.event === 'click')?.handler;

  assert.ok(openHandler, '必须绑定快捷键打开按钮');
  assert.ok(closeBtnHandler, '必须绑定快捷键关闭按钮');

  // 打开帮助
  openHandler({ preventDefault: () => {} });
  assert.equal(modalOpened, true, '应当打开模态对话框');

  // 点击关闭按钮关闭
  closeBtnHandler({ preventDefault: () => {} });
  assert.equal(modalOpened, false, '对话框应已关闭');
  assert.equal(focusedElement, openerButton, '关闭后焦点应当归还给原触发按钮');

  // 模拟再次打开后按 Escape（原生 dialog 触发 close 事件）
  focusedElement = null;
  documentRef.activeElement = openerButton;
  openHandler({ preventDefault: () => {} });
  assert.equal(modalOpened, true);

  // 触发原生 close 事件
  const dialogCloseHandler = listeners.find(l => l.target === shortcutsDialog && l.event === 'close')?.handler;
  assert.ok(dialogCloseHandler, '必须监听 dialog close 事件');
  dialogCloseHandler();
  assert.equal(focusedElement, openerButton, 'Escape 原生关闭后焦点同样应当归还');

  tools.dispose();
});

test('createCanvasTools: dispose 幂等且销毁后迟到事件无任何副作用', async () => {
  const cleanupsCalled = [];
  const listeners = [];
  const mockListen = (target, event, handler) => {
    listeners.push({ target, event, handler });
    return () => { cleanupsCalled.push({ target, event }); };
  };

  let modalCalls = 0;
  const shortcutsDialog = {
    showModal: () => { modalCalls++; },
    close: () => {},
  };

  const btnFullscreen = { setAttribute: () => {} };
  const btnShortcuts = {};
  const btnShortcutsClose = {};
  const documentRef = { fullscreenEnabled: true, fullscreenElement: null };
  const fullscreenTarget = { requestFullscreen: async () => {} };

  const tools = createCanvasTools({
    documentRef,
    fullscreenTarget,
    btnFullscreen,
    btnShortcuts,
    shortcutsDialog,
    btnShortcutsClose,
    listen: mockListen,
    flashMessage: () => {},
  });

  assert.ok(listeners.length >= 3, '应至少绑定全屏、帮助打开、帮助关闭及全屏变化');

  // 销毁
  tools.dispose();
  tools.dispose(); // 幂等调用

  assert.ok(cleanupsCalled.length >= 3, 'dispose 应当调用全部已注册监听器的清理回调');

  // 销毁后调用遗留的 handler
  const openHandler = listeners.find(l => l.target === btnShortcuts && l.event === 'click')?.handler;
  openHandler?.({ preventDefault: () => {} });
  assert.equal(modalCalls, 0, '销毁后点击打开不得调用 showModal');
});

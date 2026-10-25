/**
 * 会话命令分发、重命名意图并发锁、删除确认状态机与状态提示 UI 控制器
 *
 * 承接原 panel.js 中的会话命令处理（rename/delete/new/switch/refresh）、
 * 删除对话框生命周期及安全 isTrusted 校验、会话状态提示。
 * 严禁在顶层访问裸 window 或 document，严格遵守 fail-fast 依赖与运行时契约。
 */

import { readRenameIntent, clearRenameIntent } from './fork-session-commands.js';
import { assertFunction, assertOptionalFunctions, assertObject, assertString, assertMethod } from './panel-contracts.js';

export function createPanelSessionUi(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createPanelSessionUi: deps must be an object');
  }

  assertOptionalFunctions(deps, ['hasActiveRequests', 'isDisposed'], 'createPanelSessionUi');

  const {
    hana,
    sessionStore,
    getSessionController,
    bus,
    canvasId,
    safeDetail,
    initialSnapshot,
    publishSessionState,
    renderCards,
    listen,
    deleteDialog,
    deleteTargetTitle,
    deleteDialogError,
    deleteDialogProgress,
    btnDeleteConfirm,
    btnDeleteCancel,
    sessionStatusEl,
    btnRetrySave,
    btnSaveCopy,
    btnNewRoot,
    btnEmptyNewSession,
    flashMessage,
    isDisposed = () => false,
    hasActiveRequests = () => false,
  } = deps;

  // 必需函数依赖 fail-fast 校验
  assertFunction(getSessionController, 'getSessionController', 'createPanelSessionUi');
  assertFunction(safeDetail, 'safeDetail', 'createPanelSessionUi');
  assertFunction(initialSnapshot, 'initialSnapshot', 'createPanelSessionUi');
  assertFunction(publishSessionState, 'publishSessionState', 'createPanelSessionUi');
  assertFunction(renderCards, 'renderCards', 'createPanelSessionUi');
  assertFunction(listen, 'listen', 'createPanelSessionUi');
  assertFunction(flashMessage, 'flashMessage', 'createPanelSessionUi');

  // 必需对象/DOM 引用校验
  assertObject(hana, 'hana', 'createPanelSessionUi');
  assertObject(sessionStore, 'sessionStore', 'createPanelSessionUi');
  assertObject(bus, 'bus', 'createPanelSessionUi');
  assertObject(deleteDialog, 'deleteDialog', 'createPanelSessionUi');
  assertObject(deleteTargetTitle, 'deleteTargetTitle', 'createPanelSessionUi');
  assertObject(deleteDialogError, 'deleteDialogError', 'createPanelSessionUi');
  assertObject(deleteDialogProgress, 'deleteDialogProgress', 'createPanelSessionUi');
  assertObject(btnDeleteConfirm, 'btnDeleteConfirm', 'createPanelSessionUi');
  assertObject(btnDeleteCancel, 'btnDeleteCancel', 'createPanelSessionUi');
  assertObject(sessionStatusEl, 'sessionStatusEl', 'createPanelSessionUi');
  assertObject(btnRetrySave, 'btnRetrySave', 'createPanelSessionUi');
  assertObject(btnSaveCopy, 'btnSaveCopy', 'createPanelSessionUi');
  assertObject(btnNewRoot, 'btnNewRoot', 'createPanelSessionUi');
  assertObject(btnEmptyNewSession, 'btnEmptyNewSession', 'createPanelSessionUi');

  assertString(canvasId, 'canvasId', 'createPanelSessionUi');

  // 构造期方法契约校验
  assertMethod(sessionStore, 'get', 'createPanelSessionUi: sessionStore');
  assertMethod(bus, 'postMessage', 'createPanelSessionUi: bus');
  assertMethod(deleteDialog, 'showModal', 'createPanelSessionUi: deleteDialog');
  assertMethod(deleteDialog, 'close', 'createPanelSessionUi: deleteDialog');

  let localDisposed = false;
  const checkDisposed = () => localDisposed || (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));

  // 重命名意图并发锁
  const activeRenameCommands = new Set();

  // 删除确认状态机
  let deleteIntent = null;
  let deleteInProgress = false;

  // 会话状态与提示暂态
  let lastPhase = '';
  let lastNotice = '';

  function replySessionCommand(message, result) {
    if (checkDisposed()) return;
    if (!message?.requestId || !message?.panelId) return;
    bus.postMessage({
      type: 'FORK_SESSION_RESULT',
      canvasId,
      targetPanelId: message.panelId,
      requestId: message.requestId,
      command: message.command,
      ...result,
    });
  }

  async function handleRenameCommand(message) {
    if (checkDisposed()) return;
    if (activeRenameCommands.has(message.requestId)) return;
    activeRenameCommands.add(message.requestId);

    const sessionCtrl = getSessionController();
    if (!sessionCtrl) {
      activeRenameCommands.delete(message.requestId);
      replySessionCommand(message, { ok: false, error: '会话控制器尚未初始化。' });
      return;
    }
    assertMethod(sessionCtrl, 'rename', 'handleRenameCommand: sessionController');

    try {
      const intent = await readRenameIntent(hana, message.requestId, message.sessionId);
      if (checkDisposed()) return;
      const result = await sessionCtrl.rename(message.sessionId, intent.title, intent.expectedTitle);
      replySessionCommand(message, result);
    } catch (err) {
      replySessionCommand(message, { ok: false, error: safeDetail(err?.message || String(err)) });
    } finally {
      activeRenameCommands.delete(message.requestId);
      await clearRenameIntent(hana, message.requestId);
    }
  }

  function dismissDeleteConfirmation(cancelled = true) {
    if (!deleteIntent || deleteInProgress) return;
    const message = deleteIntent.message;
    deleteIntent = null;
    deleteDialog.close();
    publishSessionState();
    if (cancelled) {
      replySessionCommand(message, { ok: false, cancelled: true });
    }
  }

  async function openDeleteConfirmation(message) {
    if (checkDisposed()) return;
    const sessionCtrl = getSessionController();
    if (!sessionCtrl || !sessionCtrl.state?.ready || sessionCtrl.state?.busy) {
      replySessionCommand(message, { ok: false, error: '会话正忙或尚未就绪，请稍后重试。' });
      return;
    }
    assertMethod(sessionStore, 'get', 'openDeleteConfirmation: sessionStore');

    const intent = { message, record: null };
    deleteIntent = intent;
    deleteTargetTitle.textContent = '正在读取会话…';
    deleteDialogError.textContent = '';
    deleteDialogProgress.textContent = '确认前不会删除或取消任何请求。';
    btnDeleteConfirm.disabled = true;
    btnDeleteCancel.disabled = false;
    deleteDialog.showModal();
    if (typeof btnDeleteCancel.focus === 'function') {
      btnDeleteCancel.focus();
    }
    publishSessionState();

    try {
      const record = await sessionStore.get(message.sessionId);
      if (checkDisposed() || deleteIntent !== intent) return;
      intent.record = record;
      deleteTargetTitle.textContent = record.title;
      const isCurrent = record.id === sessionCtrl.state.activeId;
      const changedElsewhere = isCurrent && record.revision > sessionCtrl.state.activeRevision;
      const activeBusy = typeof hasActiveRequests === 'function' ? hasActiveRequests() : false;
      deleteDialogProgress.textContent = changedElsewhere
        ? '已保存版本较本窗口记录更新（可能来自其他窗口）。确认后会删除最新已保存版本，以及本窗口未保存的内容。'
        : isCurrent && activeBusy
        ? '当前仍在生成，确认删除后会先停止请求。'
        : '确认后将永久删除该会话及其全部卡片记录。';
      btnDeleteConfirm.disabled = false;
    } catch (err) {
      if (!checkDisposed() && deleteIntent === intent) {
        deleteDialogError.textContent = safeDetail(err?.message || String(err));
      }
    }
  }

  // 绑定删除确认框交互
  listen(btnDeleteCancel, 'click', () => dismissDeleteConfirmation());
  listen(deleteDialog, 'cancel', event => {
    event.preventDefault();
    dismissDeleteConfirmation();
  });
  listen(btnDeleteConfirm, 'click', async event => {
    if (checkDisposed()) return;
    if (!event?.isTrusted) {
      deleteDialogError.textContent = '这次点击未被识别为本人操作，请直接用鼠标或键盘确认。';
      return;
    }
    const intent = deleteIntent;
    if (!intent?.record || deleteInProgress) return;
    deleteInProgress = true;
    btnDeleteConfirm.disabled = true;
    btnDeleteCancel.disabled = true;
    deleteDialogError.textContent = '';
    deleteDialogProgress.textContent = '正在删除…';

    const sessionCtrl = getSessionController();
    if (!sessionCtrl) {
      deleteInProgress = false;
      deleteDialogError.textContent = '会话控制器未就绪。';
      btnDeleteConfirm.disabled = false;
      btnDeleteCancel.disabled = false;
      return;
    }
    assertMethod(sessionCtrl, 'remove', 'btnDeleteConfirm: sessionController');

    const result = await sessionCtrl.remove(intent.record.id, intent.record.revision, initialSnapshot());
    if (checkDisposed()) return;
    deleteInProgress = false;
    if (result.ok) {
      dismissDeleteConfirmation(false);
      replySessionCommand(intent.message, result);
    } else {
      deleteDialogError.textContent = result.error || '删除失败，原会话尚未移除。';
      deleteDialogProgress.textContent = '可以取消，或检查存储状态后重试。';
      btnDeleteConfirm.disabled = false;
      btnDeleteCancel.disabled = false;
    }
  });

  // 绑定新建、重试与备份按钮（严禁静默 ?. 丢失）
  listen(btnEmptyNewSession, 'click', () => {
    if (checkDisposed()) return;
    const sessionCtrl = getSessionController();
    if (!sessionCtrl) {
      flashMessage('会话控制器尚未就绪，请稍候重试。');
      return;
    }
    assertMethod(sessionCtrl, 'newSession', 'btnEmptyNewSession: sessionController');
    void sessionCtrl.newSession(initialSnapshot()).catch(err => {
      flashMessage(`新建会话失败：${safeDetail(err?.message || String(err))}`);
    });
  });

  listen(btnRetrySave, 'click', () => {
    if (checkDisposed()) return;
    const sessionCtrl = getSessionController();
    if (!sessionCtrl) {
      flashMessage('会话控制器尚未就绪，无法执行保存。');
      return;
    }
    let action;
    if (sessionCtrl.state.ready) {
      assertMethod(sessionCtrl, 'retrySave', 'btnRetrySave: sessionController');
      action = sessionCtrl.retrySave();
    } else {
      action = sessionCtrl.init();
    }
    void action.catch(err => {
      flashMessage(`保存失败：${safeDetail(err?.message || String(err))}`);
    });
  });

  listen(btnSaveCopy, 'click', () => {
    if (checkDisposed()) return;
    const sessionCtrl = getSessionController();
    if (!sessionCtrl) {
      flashMessage('会话控制器尚未就绪，无法另存副本。');
      return;
    }
    assertMethod(sessionCtrl, 'saveCopy', 'btnSaveCopy: sessionController');
    void sessionCtrl.saveCopy().catch(err => {
      flashMessage(`另存副本失败：${safeDetail(err?.message || String(err))}`);
    });
  });

  // 会话状态广播与界面状态同步
  function handleSessionStateChange(state) {
    if (checkDisposed() || !state) return;
    if (state.notice && state.notice !== lastNotice) {
      lastNotice = state.notice;
      flashMessage(state.notice);
    }
    // 同一 STORAGE_QUOTA_EXCEEDED 同时覆盖 100 会话数与整库 12MiB 两种限制，
    // 底层英文不适合直接展示：统一给出泛化中文文案，不猜具体触发的是哪个限制。
    const conflictText = state.conflict === 'modified'
      ? '远端已修改，本地内容未覆盖。请确认覆盖远端并保存，或另存副本。'
      : state.conflict === 'deleted'
      ? '会话已在别处删除，请另存副本。'
      : state.conflict === 'active-changed'
      ? '其他窗口已切换当前会话，本地内容未覆盖。请重试保存或另存副本。'
      : null;
    const statusError = conflictText || (state.error
      ? (typeof state.error === 'string' && state.error.includes('STORAGE_QUOTA_EXCEEDED')
          ? '会话存储已达上限（最多 100 个会话，所有会话合计 12MiB）。本次更改未保存，原有内容未被覆盖；请备份需要保留的内容后清理不再需要的会话再重试'
          : safeDetail(state.error))
      : null);
    sessionStatusEl.textContent = statusError
      ? `${state.dirty ? '未保存' : '会话操作失败'} · ${statusError}`
      : !state.ready
      ? '正在恢复会话…'
      : !state.activeId
      ? '暂无会话 · 可点击新建会话'
      : `${state.title} · ${state.busy ? '正在切换…' : state.saving ? '保存中…' : state.dirty ? '待保存' : '已保存'}`;
    sessionStatusEl.title = sessionStatusEl.textContent;
    btnRetrySave.textContent = state.conflict === 'modified' ? '覆盖远端并保存' : '重试保存';
    btnRetrySave.hidden = !state.error || state.conflict === 'deleted';
    btnSaveCopy.hidden = !state.error || !state.ready;
    btnRetrySave.disabled = Boolean(state.busy);
    btnSaveCopy.disabled = Boolean(state.busy);
    btnNewRoot.disabled = !state.ready || Boolean(state.busy);
    const phase = `${state.ready}:${state.busy}`;
    if (lastPhase !== phase) {
      lastPhase = phase;
      renderCards();
    }
    publishSessionState();
  }

  // 跨窗口会话命令统一分发入口（要求精确目标 targetCanvasId===canvasId，缺失 target 拒绝）
  function handleSessionMessage(message) {
    if (checkDisposed()) return false;
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'FORK_SESSION_COMMAND') {
      if (message.targetCanvasId !== canvasId) return false;
      const sessionCtrl = getSessionController();
      if (!sessionCtrl) {
        replySessionCommand(message, { ok: false, error: '会话控制器尚未就绪。' });
        return true;
      }
      if (deleteIntent) {
        replySessionCommand(message, { ok: false, error: '请先处理当前删除确认。' });
        return true;
      }
      if (message.command === 'rename') {
        void handleRenameCommand(message);
        return true;
      }
      if (message.command === 'delete') {
        void openDeleteConfirmation(message);
        return true;
      }
      const operation = message.command === 'new'
        ? (assertMethod(sessionCtrl, 'newSession', 'command:new'), sessionCtrl.newSession(initialSnapshot()))
        : message.command === 'switch'
        ? (assertMethod(sessionCtrl, 'switchTo', 'command:switch'), sessionCtrl.switchTo(message.sessionId))
        : sessionCtrl.state.ready
        ? (assertMethod(sessionCtrl, 'refresh', 'command:refresh'), sessionCtrl.refresh())
        : (assertMethod(sessionCtrl, 'init', 'command:init'), sessionCtrl.init());
      void operation.catch(err => {
        replySessionCommand(message, { ok: false, error: safeDetail(err?.message || String(err)) });
      });
      return true;
    }
    return false;
  }

  function getDeleteIntent() {
    return deleteIntent;
  }

  function hasDeleteIntent() {
    return Boolean(deleteIntent);
  }

  function dispose() {
    if (localDisposed) return;
    localDisposed = true;
    activeRenameCommands.clear();
    deleteIntent = null;
    deleteInProgress = false;
    try {
      deleteDialog.close();
    } catch {}
  }

  return {
    handleSessionMessage,
    handleSessionStateChange,
    flashMessage,
    getDeleteIntent,
    hasDeleteIntent,
    dismissDeleteConfirmation,
    dispose,
    isDisposed: () => checkDisposed(),
  };
}

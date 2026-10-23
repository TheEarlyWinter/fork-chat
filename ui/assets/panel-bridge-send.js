/**
 * 桥接回传模块 (Bridge Send Controller)
 *
 * 负责画布卡片向本体会话的回传同步锁、发件箱状态管理、两阶段 prepare/confirm 协议推进。
 * 严禁在顶层访问 window / document / localStorage，所有 DOM 与跨模块依赖均由 deps 注入。
 * 严禁反向 import panel.js。
 */

import { escapeHtml as defaultEscapeHtml } from './panel-format.js';
import { safeDetail as defaultSafeDetail } from './host-api.js';
import { selectedBridgeKind as resolveBridgeKind } from './panel-bridge.js';
import { assertFunction, assertOptionalFunctions, assertCardsArray } from './panel-contracts.js';

/** 会话尾号辅助函数：同名会话靠这个区分 */
function shortId(id) {
  const text = String(id || '');
  return text.length > 8 ? text.slice(-6) : text;
}

export function createBridgeSend(deps = {}) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createBridgeSend: deps must be an object');
  }

  assertFunction(deps.bridgeRequest, 'bridgeRequest', 'createBridgeSend');
  assertOptionalFunctions(deps, [
    'isDisposed', 'safeDetail', 'escapeHtml', 'flashMessage',
    'getCards', 'getSelectedCardId', 'getBridgeTargetSessionId', 'listen'
  ], 'createBridgeSend');

  const {
    documentRef,
    isDisposed = () => false,
    bridgeRequest,
    safeDetail = defaultSafeDetail,
    escapeHtml = defaultEscapeHtml,
    flashMessage = () => {},
    getCards = () => [],
    getSelectedCardId = () => null,
    getBridgeTargetSessionId = () => null,
    bridgeSendDialogEl,
    bridgeKindSelect,
    listen,
    BlobRef = typeof Blob !== 'undefined' ? Blob : null,
  } = deps;

  let bridgeSendBusy = false;
  let bridgeSendOpening = false;
  // 一次弹窗确认流程只准备一个动作。回执丢失也保留原 actionId 与冻结正文。
  let bridgeSendAttempt = null;

  const checkDisposed = () => (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));
  const getDoc = () => (typeof documentRef === 'function' ? documentRef() : documentRef);
  const getEl = (id) => getDoc()?.getElementById(id);

  const getDialog = () => {
    if (typeof bridgeSendDialogEl === 'function') return bridgeSendDialogEl();
    if (bridgeSendDialogEl) return bridgeSendDialogEl;
    return getEl('bridge-send-dialog');
  };

  const getKindSelect = () => {
    if (typeof bridgeKindSelect === 'function') return bridgeKindSelect();
    if (bridgeKindSelect) return bridgeKindSelect;
    return getEl('bridge-kind-select');
  };

  function updateBridgeSendControls() {
    if (checkDisposed()) return;
    const locked = Boolean(bridgeSendBusy || bridgeSendAttempt?.actionId);
    const confirm = getEl('btn-bridge-send-confirm');
    if (confirm) {
      confirm.disabled = bridgeSendBusy || Boolean(bridgeSendAttempt?.completed);
      confirm.textContent = bridgeSendBusy ? '正在处理…'
        : bridgeSendAttempt?.confirmStarted ? '核对/继续原动作' : '确认投递';
    }
    const target = getEl('bridge-send-target');
    const text = getEl('bridge-send-text');
    if (target) target.disabled = locked;
    if (text) text.readOnly = locked;
    for (const id of ['btn-bridge-send-close', 'btn-bridge-send-cancel']) {
      const button = getEl(id);
      if (button) button.disabled = bridgeSendBusy;
    }
    const open = getEl('btn-bridge-send');
    if (open) open.disabled = bridgeSendBusy || bridgeSendOpening;
  }

  function closeBridgeSendDialog() {
    if (!bridgeSendBusy) getDialog()?.close();
  }

  function selectedBridgeKind() {
    return resolveBridgeKind(getKindSelect());
  }

  async function openBridgeSendDialog() {
    if (checkDisposed()) return;
    const dialog = getDialog();
    if (!dialog || dialog.open || bridgeSendBusy || bridgeSendOpening) return;
    bridgeSendOpening = true;
    // 已知完成/明确失败后的主动打开才是新流程；未知回执仍是旧流程。
    if (!bridgeSendAttempt?.confirmStarted || bridgeSendAttempt.completed) bridgeSendAttempt = null;
    updateBridgeSendControls();
    try {
      const sel = getEl('bridge-send-target');
      const meta = getEl('bridge-send-meta');
      const errEl = getEl('bridge-send-error');
      if (errEl) errEl.textContent = '';
      try {
        const data = await bridgeRequest('/api/bridge/sessions');
        // 这里保持宽松：字段缺失就当没有会话。抛错会被 open 的 catch 捕获写进错误框，
        // 反而盖掉更重要的"目标与正文已冻结"提示——那是用户此刻真正要知道的事。
        const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
        if (sel) {
          sel.innerHTML = sessions
            .map((s) => `<option value="${escapeHtml(s.sessionId)}">${escapeHtml(s.title || s.sessionId)} · ${escapeHtml(shortId(s.sessionId))}</option>`)
            .join('');
          const targetSessionId = getBridgeTargetSessionId();
          if (targetSessionId && sessions.some((s) => s.sessionId === targetSessionId)) {
            sel.value = targetSessionId;
          }
        }
      } catch (err) {
        if (checkDisposed()) return;
        if (errEl) errEl.textContent = safeDetail(err?.message || String(err));
      }
      const updateMeta = () => {
        if (checkDisposed()) return;
        const box = getEl('bridge-send-text');
        // 字节数必须按 UTF-8 真实字节算。拿字符串 length 顶替会把中文和 emoji 算少，
        // 显示一个偏小的数字比不显示更糟，所以没有 Blob 就干脆不显示。
        if (!BlobRef) return;
        const byteSize = new BlobRef([box?.value || '']).size;
        if (meta) meta.textContent = `${byteSize} 字节 / 上限 65536`;
      };
      const box = getEl('bridge-send-text');
      if (box) box.oninput = updateMeta;
      // 从当前选中卡片带一段确定性模板，不调模型生成摘要
      const cards = typeof getCards === 'function' ? assertCardsArray(getCards(), 'bridge-send:openBridgeSendDialog') : [];
      const selectedCardId = typeof getSelectedCardId === 'function' ? getSelectedCardId() : null;
      const selected = cards.find((c) => c.id === selectedCardId);
      if (box && selected && !box.value.trim()) {
        const lastAssistant = [...(selected.messages || [])].reverse().find((m) => m.role === 'assistant' && m.text);
        const excerpt = lastAssistant?.text ? lastAssistant.text.slice(0, 4000) : (selected.docContent || '').slice(0, 4000);
        box.value = `> 来自「分叉对话」的整理，原卡片：${selected.title || '未命名'}\n\n${excerpt}`;
      }
      if (bridgeSendAttempt) {
        // 关闭后重开不能把不确定的上次投递偷偷变成一个新的动作。
        if (sel) sel.value = bridgeSendAttempt.sessionId;
        if (box) box.value = bridgeSendAttempt.text;
        if (errEl && !errEl.textContent) errEl.textContent = '上次投递回执未确认；目标与正文已冻结，只能核对/继续原动作，不会重新准备。';
      }
      updateMeta();
      dialog.showModal();
    } finally {
      bridgeSendOpening = false;
      updateBridgeSendControls();
    }
  }

  async function confirmBridgeSend() {
    // disabled 不是互斥锁；程序触发、排队的第二次点击也必须被这道同步闸门挡住。
    const dialog = getDialog();
    if (checkDisposed() || !dialog?.open || bridgeSendBusy || bridgeSendAttempt?.completed) return;
    bridgeSendBusy = true;
    const sel = getEl('bridge-send-target');
    const text = getEl('bridge-send-text');
    const errEl = getEl('bridge-send-error');
    if (errEl) errEl.textContent = '';
    if (!bridgeSendAttempt) bridgeSendAttempt = {
      sessionId: sel?.value || '', text: text?.value || '', actionId: null,
      confirmStarted: false, completed: false,
    };
    const attempt = bridgeSendAttempt;
    updateBridgeSendControls();
    try {
      if (!attempt.actionId) {
        const prepared = await bridgeRequest('/api/bridge/prepare', {
          method: 'POST',
          body: JSON.stringify({ sessionId: attempt.sessionId, kind: 'send-text', text: attempt.text }),
        });
        const id = prepared?.action?.actionId;
        if (typeof id !== 'string' || !/^[\w.:@~+-]{1,200}$/.test(id)) throw new Error('准备动作的回执无效，未继续投递');
        attempt.actionId = id;
      }
      let result;
      if (attempt.confirmStarted) {
        // 上次确认可能已经到达宿主。先只读核对，不能重走 prepare。
        result = await bridgeRequest(`/api/bridge/actions/${encodeURIComponent(attempt.actionId)}`);
        if (result?.action?.actionId !== attempt.actionId) throw new Error('动作核对回执不匹配，未继续投递');
      }
      if (!attempt.confirmStarted || result?.action?.state === 'prepared') {
        attempt.confirmStarted = true;
        result = await bridgeRequest('/api/bridge/confirm', {
          method: 'POST',
          body: JSON.stringify({ actionId: attempt.actionId }),
        });
      }
      const state = result?.action?.state;
      if (result?.action?.actionId !== attempt.actionId || !['dispatching', 'accepted', 'delivered', 'failed', 'unknown'].includes(state)) {
        throw new Error('投递回执无效，请核对原动作，勿重新发送');
      }
      attempt.completed = ['accepted', 'delivered', 'failed'].includes(state);
      dialog.close();
      if (state === 'accepted' || state === 'delivered') {
        flashMessage('已投递给本体会话（已接纳 ≠ 助手已回完）。');
      } else if (state === 'failed') {
        flashMessage('原投递动作已明确失败，请查看回传记录。');
      } else {
        flashMessage(`投递状态：${state}。已保留原动作，不会自动重发。`);
      }
    } catch (err) {
      // prepare 失败从未确认，不存在宿主消息副作用；可以解锁编辑。
      // 一旦拿到 actionId，则保留它供只读核对，绝不能重新 prepare。
      if (!attempt.actionId) bridgeSendAttempt = null;
      if (errEl) errEl.textContent = `${safeDetail(err?.message || String(err))}${attempt.confirmStarted ? '；已保留原动作，请核对状态，勿重新发送。' : ''}`;
    } finally {
      bridgeSendBusy = false;
      updateBridgeSendControls();
    }
  }

  function bind(bindDeps = {}) {
    const listenFn = bindDeps.listen || listen;
    if (typeof listenFn !== 'function') return;
    const sendBtn = getEl('btn-bridge-send');
    if (sendBtn) listenFn(sendBtn, 'click', openBridgeSendDialog);
    const closeBtn = getEl('btn-bridge-send-close');
    if (closeBtn) listenFn(closeBtn, 'click', closeBridgeSendDialog);
    const cancelBtn = getEl('btn-bridge-send-cancel');
    if (cancelBtn) listenFn(cancelBtn, 'click', closeBridgeSendDialog);
    const dialog = getDialog();
    if (dialog) {
      listenFn(dialog, 'cancel', (event) => {
        if (bridgeSendBusy && event) event.preventDefault();
      });
    }
    const confirmBtn = getEl('btn-bridge-send-confirm');
    if (confirmBtn) listenFn(confirmBtn, 'click', confirmBridgeSend);
    updateBridgeSendControls();
  }

  return {
    updateBridgeSendControls,
    closeBridgeSendDialog,
    openBridgeSendDialog,
    confirmBridgeSend,
    selectedBridgeKind,
    bind,
  };
}

/**
 * 分支交接控制器：协调已保存不可变快照、祖先拓扑忙碌检查、Agent 选择、准备与确认流程。
 *
 * 遵循原则（Task 3 Round 2 状态架构）：
 * 1. 业务操作归每次独立的 op 对象拥有，彻底淘汰全局共享锁。
 * 2. 统一 isCurrent(op) 门禁：动态重新获取会话控制器，核验实例引用、generation、activeId 以及 op 闭合状态。
 * 3. 模态对话框与 loading 状态在首次异步等待（flush/caps/actions/agents）前尽早挂载并置 open，阻断背景交互；关闭后迟到响应直接废弃，杜绝复活。
 * 4. capabilities 准入（supported/available/home）严格执行，失败固定提示且绝对阻断 prepare POST。
 * 5. actions 历史查询失败 fail-closed，严禁静默漏进新准备流程。
 * 6. 历史记录与新预览共存：历史动作展示元数据与恢复入口；提供显式【新建预览】按钮，未点击前 0 POST；query 获得新 sessionId 后 focus 准确消费最新 ID。
 * 7. 显式有界遍历检查祖先忙碌状态（HANDOFF_LIMITS.maxNodes），在 prepare/confirm 发送前复核；读操作（query/focus）不被无关忙碌阻断。
 * 8. 预览正文与准备 DTO 权威一致：通过 formatHandoffTranscript 保证完整保底正文与实际 POST DTO 逐字吻合。
 */

import { buildHandoffContext } from './fork-handoff-context.js';
import { HANDOFF_LIMITS } from './fork-handoff-contract.js';
import { parentIdsOf } from './fork-snapshot.js';
import { createHandoffView } from './panel-handoff-view.js';

export function createPanelHandoff(deps = {}) {
  const {
    hana,
    requestHost,
    getSessionController,
    sessionController: initialSessionController,
    getCards = () => [],
    isCardBusy = () => false,
    flashMessage = () => {},
    safeDetail = (s) => String(s ?? ''),
    getIsDisposed = () => false,
    documentRef = (typeof document !== 'undefined' ? document : null),
  } = deps;

  let isDisposed = false;
  let activeOp = null;
  let opSeq = 0;

  const view = createHandoffView({ documentRef });

  function getActiveSessionController() {
    if (typeof getSessionController === 'function') {
      return getSessionController();
    }
    return initialSessionController || null;
  }

  function isCurrent(op) {
    if (isDisposed || getIsDisposed() || !op || op.closed || op !== activeOp) {
      return false;
    }
    const currentController = getActiveSessionController();
    if (!currentController || currentController !== op.controller) {
      return false;
    }
    const state = currentController.state;
    if (!state || state.generation !== op.generation || state.activeId !== op.activeId) {
      return false;
    }
    return true;
  }

  // 显式栈有界遍历目标及祖先节点（避免深链递归栈溢出）
  function collectAncestorsWithBoundedStack(targetCardId, allCards) {
    const cardMap = new Map();
    for (const c of allCards) {
      if (c && typeof c.id === 'string') cardMap.set(c.id, c);
    }

    const visited = new Set();
    const stack = [targetCardId];

    while (stack.length > 0) {
      const currentId = stack.pop();
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);

      if (visited.size > HANDOFF_LIMITS.maxNodes) {
        throw new Error(`依赖节点数量超过上限 (${HANDOFF_LIMITS.maxNodes})，无法交接`);
      }

      const card = cardMap.get(currentId);
      if (card) {
        const parents = parentIdsOf(card);
        for (const p of parents) {
          if (p && !visited.has(p)) stack.push(p);
        }
      }
    }
    return visited;
  }

  function checkAnyBusy(targetCardId, allCards) {
    const ancestorIds = collectAncestorsWithBoundedStack(targetCardId, allCards);
    for (const id of ancestorIds) {
      if (isCardBusy(id)) {
        return true;
      }
    }
    return false;
  }

  function buildContext(agentId, nextStep, savedSnapshot, targetCardId) {
    return buildHandoffContext({
      snapshot: savedSnapshot.snapshot,
      source: {
        canvasId: savedSnapshot.id,
        revision: savedSnapshot.revision,
        targetCardId,
      },
      targetCardId,
      agentId,
      nextStep,
    });
  }

  function applyActionResult(op, action) {
    const hasSessionId = Boolean(action.sessionId);
    const showNewPreview = Boolean(op.isHistoryMode);

    if (action.state === 'ready') {
      view.setStage('ready', { hasSessionId, showNewPreview });
    } else if (action.state === 'partial') {
      view.setError(`交接部分完成 (${action.errorCode || 'HANDOFF_PARTIAL'})，会话已创建，可点击核查。`);
      view.setStage('partial', { hasSessionId, showNewPreview });
    } else if (action.state === 'unknown') {
      view.setError('交接结果暂时无法确认，需按原动作查询；不会自动重发。');
      view.setStage('unknown', { hasSessionId, showNewPreview });
    } else if (action.state === 'importing') {
      view.setStage('importing', { hasSessionId, showNewPreview });
    } else if (action.state === 'creating' || action.state === 'running') {
      view.setStage('running', { hasSessionId, showNewPreview });
    } else if (action.state === 'failed') {
      view.setError(`交接失败：${action.errorCode || 'HANDOFF_FAILED'}`);
      view.setStage('failed', { hasSessionId, showNewPreview });
    } else if (action.state === 'prepared') {
      if (op.isHistoryMode) {
        view.setError('发现历史准备动作，但历史记录不包含正文；无法直接确认。');
        view.setStage('history-prepared', { hasSessionId, showNewPreview });
      } else {
        view.setStage('prepared', { hasSessionId });
      }
    }
  }

  async function handlePrepare(op) {
    if (!isCurrent(op) || op.isPreparing) return;
    if (!op.capsOk) {
      view.setError('宿主环境不支持分支交接或缺少主页会话权限');
      return;
    }
    if (!op.selectedAgentId) {
      view.setError('请先选择目标智能体');
      return;
    }

    try {
      if (checkAnyBusy(op.targetCardId, getCards())) {
        view.setError('目标卡片或其祖先节点正在处理中，请等待完成后再继续。');
        return;
      }
    } catch (err) {
      view.setError(safeDetail(err?.message || err));
      return;
    }

    op.isPreparing = true;
    view.setError('');
    view.setStage('preparing');

    const prepareEpoch = op.inputEpoch;

    let dto;
    try {
      dto = buildContext(op.selectedAgentId, op.nextStepText, op.savedSnapshot, op.targetCardId);
      // 先更新预览与权威转录正文，确保与 POST 的 DTO 逐字一致
      view.updatePreview(dto);
      view.markPreviewStale(null);
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError(safeDetail(err?.message || err));
      view.setStage('init');
      op.isPreparing = false;
      return;
    }

    try {
      const resp = await requestHost(hana, '/api/handoff/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      });
      const data = await resp.json();
      if (!isCurrent(op) || op.inputEpoch !== prepareEpoch) {
        return;
      }
      if (!data || !data.ok || !data.action?.actionId) {
        throw new Error(data?.error || '准备交接动作失败');
      }
      op.currentAction = data.action;
      view.setStage('prepared');
    } catch (err) {
      if (!isCurrent(op) || op.inputEpoch !== prepareEpoch) {
        return;
      }
      view.setError('准备失败：' + safeDetail(err?.message || err));
      view.setStage('init');
    } finally {
      op.isPreparing = false;
    }
  }

  async function handleConfirm(op) {
    if (!isCurrent(op) || op.isConfirming || !op.currentAction?.actionId) return;

    try {
      if (checkAnyBusy(op.targetCardId, getCards())) {
        view.setError('目标卡片或其祖先节点正在处理中，请等待完成后再继续。');
        return;
      }
    } catch (err) {
      view.setError(safeDetail(err?.message || err));
      return;
    }

    op.isConfirming = true;
    view.setError('');
    view.setStage('confirming');

    const targetActionId = op.currentAction.actionId;
    try {
      const resp = await requestHost(hana, '/api/handoff/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId: targetActionId }),
      });
      const data = await resp.json();
      if (!isCurrent(op)) return;
      if (!data || !data.ok || !data.action) {
        throw new Error(data?.error || '交接处理异常');
      }
      if (data.action.actionId !== targetActionId) {
        view.setError('确认响应动作标识不匹配');
        return;
      }
      op.currentAction = data.action;
      applyActionResult(op, data.action);
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError('确认未完成，需按原动作查询；不会自动重发。');
      view.setStage('error-recoverable');
    } finally {
      op.isConfirming = false;
    }
  }

  async function handleRecover(op) {
    if (!isCurrent(op) || op.isQuerying || !op.currentAction?.actionId) return;
    op.isQuerying = true;
    view.setError('');

    const targetActionId = op.currentAction.actionId;
    try {
      const resp = await requestHost(hana, `/api/handoff/actions/${encodeURIComponent(targetActionId)}`);
      const data = await resp.json();
      if (!isCurrent(op)) return;
      if (!data || !data.ok || !data.action) {
        throw new Error(data?.error || '查询动作状态失败');
      }
      if (data.action.actionId !== targetActionId) {
        view.setError('查询响应动作标识不匹配');
        return;
      }
      op.currentAction = data.action;
      applyActionResult(op, data.action);
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError('查询恢复失败：' + safeDetail(err?.message || err));
    } finally {
      op.isQuerying = false;
    }
  }

  async function handleFocus(op) {
    const sessionId = op.currentAction?.sessionId;
    if (!isCurrent(op) || op.isFocusing || !sessionId) return;
    op.isFocusing = true;
    try {
      await hana.sessions.focus({ sessionId });
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError('聚焦会话失败：' + safeDetail(err?.message || err) + '，您可以再次点击重试。');
    } finally {
      op.isFocusing = false;
    }
  }

  function setupHistoryView(op, action) {
    op.currentAction = action;
    const hasSessionId = Boolean(action.sessionId);

    view.renderHistory({
      action,
      hasSessionId,
      onRecover: () => handleRecover(op),
      onFocus: () => handleFocus(op),
      onNewPreview: async () => {
        if (!isCurrent(op)) return;
        if (!op.capsOk) {
          const reason = (op.caps?.reason === 'HANDOFF_PERMISSION_MISSING' || op.caps?.home === false)
            ? '缺少主页会话创建权限，无法交接'
            : '宿主环境暂不支持分支交接';
          view.setError(reason);
          return;
        }
        op.isHistoryMode = false;
        op.currentAction = null;
        await setupNewPreview(op);
      },
      onClose: () => {
        op.closed = true;
        if (activeOp === op) activeOp = null;
        view.close();
      },
    });

    applyActionResult(op, action);
  }

  async function setupNewPreview(op) {
    if (!op.agents || op.agents.length === 0) {
      let agents = [];
      try {
        const resp = await requestHost(hana, '/api/agents');
        const data = await resp.json();
        if (data && data.ok && Array.isArray(data.agents)) {
          agents = data.agents.filter(a => a && typeof a.id === 'string' && a.id.trim());
        }
      } catch {}
      if (!isCurrent(op)) return;
      if (agents.length === 0) {
        view.setError('获取可用智能体列表失败或当前无可用智能体');
        return;
      }
      op.agents = agents;
    }

    const snapshotAgentId = op.savedSnapshot.snapshot?.agent?.id || '';
    const match = op.agents.some(a => a.id === snapshotAgentId);
    op.selectedAgentId = match ? snapshotAgentId : '';
    op.nextStepText = '';
    op.inputEpoch = 0;
    op.currentAction = null;

    let initialDto = null;
    if (op.selectedAgentId) {
      try {
        initialDto = buildContext(op.selectedAgentId, op.nextStepText, op.savedSnapshot, op.targetCardId);
      } catch (err) {
        view.setError('生成交接上下文失败：' + safeDetail(err?.message || err));
        return;
      }
    }

    view.renderNewPreview({
      context: initialDto,
      agents: op.agents,
      selectedAgentId: op.selectedAgentId,
      nextStepText: op.nextStepText,
      onAgentChange: (newAgentId) => {
        if (!isCurrent(op)) return;
        op.inputEpoch++;
        op.selectedAgentId = newAgentId;
        op.currentAction = null;
        view.setError('');
        view.setStage('init');
        if (op.selectedAgentId) {
          try {
            const dto = buildContext(op.selectedAgentId, op.nextStepText, op.savedSnapshot, op.targetCardId);
            view.updatePreview(dto);
          } catch (err) {
            view.setError(safeDetail(err?.message || err));
          }
        } else {
          view.updatePreview(null);
        }
      },
      onNextStepChange: (newNextStep) => {
        if (!isCurrent(op)) return;
        op.inputEpoch++;
        op.nextStepText = newNextStep;
        op.currentAction = null;
        view.setError('');
        view.setStage('init');
        view.markPreviewStale(newNextStep);
      },
      onCopyDraft: () => {
        if (!isCurrent(op)) return;
        const targetSavedCard = op.savedSnapshot.snapshot.cards.find(c => c.id === op.targetCardId);
        const draft = typeof targetSavedCard?.draft === 'string' ? targetSavedCard.draft : '';
        if (!draft) {
          view.setError('目标卡片没有可复制的草稿');
          return;
        }
        const normalized = draft.normalize('NFC');
        const chars = Array.from(normalized).length;
        if (chars > HANDOFF_LIMITS.maxNextStepChars) {
          const msg = `草稿超出下一步字符上限 (${chars} > ${HANDOFF_LIMITS.maxNextStepChars})，无法复制。`;
          view.setError(msg);
          flashMessage(msg);
          return;
        }
        op.inputEpoch++;
        op.nextStepText = draft;
        view.setNextStepValue(draft);
        op.currentAction = null;
        view.setError('');
        view.setStage('init');
        view.markPreviewStale(draft);
      },
      onPrepare: () => handlePrepare(op),
      onConfirm: () => handleConfirm(op),
      onRecover: () => handleRecover(op),
      onFocus: () => handleFocus(op),
      onClose: () => {
        op.closed = true;
        if (activeOp === op) activeOp = null;
        view.close();
      },
    });

    view.setStage('init');
  }

  async function open(targetCardId) {
    if (isDisposed || getIsDisposed()) return;
    const cards = getCards();
    const targetCard = cards.find(c => c.id === targetCardId);
    if (!targetCard) {
      flashMessage('目标卡片不存在');
      return;
    }

    // 1. 显式有界遍历检查初始忙碌状态
    try {
      if (checkAnyBusy(targetCardId, cards)) {
        flashMessage('目标卡片或其祖先节点正在处理中，请等待完成后再继续。');
        return;
      }
    } catch (err) {
      flashMessage(safeDetail(err?.message || err));
      return;
    }

    // 2. 检查会话控制器状态
    const controller = getActiveSessionController();
    const sState = controller?.state;
    if (!sState || !sState.ready || sState.busy || sState.saving || !sState.activeId) {
      flashMessage('当前会话正在保存或正忙，请稍后重试。');
      return;
    }

    // 作废旧操作
    if (activeOp) {
      activeOp.closed = true;
    }

    const op = {
      token: ++opSeq,
      controller,
      generation: sState.generation,
      activeId: sState.activeId,
      targetCardId,
      closed: false,
      inputEpoch: 0,
      savedSnapshot: null,
      caps: null,
      capsOk: false,
      agents: [],
      historyActions: [],
      currentAction: null,
      selectedAgentId: '',
      nextStepText: '',
      isPreparing: false,
      isConfirming: false,
      isQuerying: false,
      isFocusing: false,
      isHistoryMode: false,
    };
    activeOp = op;

    // 3. 早期挂载模态对话框与 loading 态（在首次异步等待前）
    const earlyOpened = view.openLoading({
      onClose: () => {
        op.closed = true;
        if (activeOp === op) activeOp = null;
        view.close();
      },
    });
    if (!earlyOpened) {
      flashMessage('无法打开模态对话框，交接已取消。');
      op.closed = true;
      if (activeOp === op) activeOp = null;
      return;
    }

    // 4. 执行 flush 并核实版本
    try {
      await controller.flush(true);
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError('会话保存失败：' + safeDetail(err?.message || err));
      return;
    }
    if (!isCurrent(op)) return;

    // 5. 获取不可变已保存快照
    let savedSnapshot;
    try {
      savedSnapshot = controller.getSavedSnapshot();
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError('获取已保存快照失败：' + safeDetail(err?.message || err));
      return;
    }
    if (!isCurrent(op)) return;
    if (!savedSnapshot || savedSnapshot.id !== op.activeId) {
      view.setError('会话快照与当前画布不匹配');
      return;
    }
    op.savedSnapshot = savedSnapshot;

    // 6. 查询 capabilities
    let caps = null;
    try {
      const resp = await requestHost(hana, '/api/handoff/capabilities');
      caps = await resp.json();
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError('查询交接支持能力失败：' + safeDetail(err?.message || err));
      return;
    }
    if (!isCurrent(op)) return;
    op.caps = caps;
    op.capsOk = Boolean(
      caps &&
      caps.ok === true &&
      caps.supported === true &&
      caps.available === true &&
      caps.home === true
    );

    // 7. 查询历史动作 actions
    let historyActions = [];
    try {
      const resp = await requestHost(hana, '/api/handoff/actions');
      const data = await resp.json();
      if (resp.status < 200 || resp.status >= 300 || !data || !data.ok || !Array.isArray(data.actions)) {
        throw new Error(data?.error || '查询历史动作失败');
      }
      historyActions = data.actions;
    } catch (err) {
      if (!isCurrent(op)) return;
      view.setError('查询历史交接记录失败：' + safeDetail(err?.message || err) + '，请点击重试。');
      view.setStage('error-recoverable');
      return;
    }
    if (!isCurrent(op)) return;
    op.historyActions = historyActions;

    const matchingAction = historyActions.find(
      a => a?.source?.canvasId === savedSnapshot.id && a?.source?.targetCardId === targetCardId
    );

    // 8. 存在历史动作时，进入历史模式
    if (matchingAction) {
      op.isHistoryMode = true;
      op.currentAction = matchingAction;
      setupHistoryView(op, matchingAction);
      return;
    }

    // 9. 无历史动作时，若准入失败直接阻断
    if (!op.capsOk) {
      const reason = (caps?.reason === 'HANDOFF_PERMISSION_MISSING' || caps?.home === false)
        ? '缺少主页会话创建权限，无法交接'
        : '宿主环境暂不支持分支交接';
      view.setError(reason);
      return;
    }

    // 10. 进入新预览流程
    await setupNewPreview(op);
  }

  function dispose() {
    isDisposed = true;
    if (activeOp) {
      activeOp.closed = true;
      activeOp = null;
    }
    view.dispose();
  }

  return {
    open,
    dispose,
  };
}

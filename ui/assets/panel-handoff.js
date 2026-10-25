/**
 * 分支交接控制器：协调已保存不可变快照、祖先拓扑忙碌检查、Agent 选择、准备与确认流程。
 *
 * 遵循原则：
 * 1. 显式有界遍历检查祖先忙碌状态，避免深链递归栈溢出；真超限明确拒绝，不返回部分祖先。
 * 2. 严格按成功保存的不可变快照提取内容，绝不重新捕获实时画布伪装保存。
 * 3. 严格的代际与生命周期守卫（activeOpToken、generation、activeId），丢弃迟到响应。
 * 4. open、prepare、confirm、query、focus 各入口程序级单飞。
 * 5. confirm 请求严格只携带 { actionId }，网络/状态失败只支持 GET 恢复，绝不自动重试 POST。
 * 6. focus 失败仅重试 focus，绝不重新 prepare 或创建。
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
  let activeOpToken = 0;
  let isOpening = false;
  let isPreparing = false;
  let isConfirming = false;
  let isQuerying = false;
  let isFocusing = false;

  let currentAction = null;
  let currentContext = null;
  let selectedAgentId = '';
  let nextStepText = '';
  let inputEpoch = 0;

  const view = createHandoffView({ documentRef });

  function getActiveSessionController() {
    if (typeof getSessionController === 'function') {
      return getSessionController();
    }
    return initialSessionController || null;
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
        throw new Error(`依赖节点数量超过上限 ${HANDOFF_LIMITS.maxNodes}，无法继续交接。`);
      }

      const card = cardMap.get(currentId);
      if (!card) continue;

      const pids = parentIdsOf(card);
      for (const pId of pids) {
        if (pId && !visited.has(pId)) stack.push(pId);
      }
    }

    return Array.from(visited);
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

  function applyActionResult(action) {
    const hasSessionId = Boolean(action.sessionId);
    if (action.state === 'ready') {
      view.setStage('ready', { hasSessionId });
    } else if (action.state === 'partial') {
      view.setError(`交接部分完成 (${action.errorCode || 'HANDOFF_PARTIAL'})，会话已创建，可点击核查。`);
      view.setStage('partial', { hasSessionId });
    } else if (action.state === 'unknown') {
      view.setError('交接结果暂时无法确认，需按原动作查询；不会自动重发。');
      view.setStage('unknown', { hasSessionId });
    } else if (action.state === 'importing') {
      view.setStage('importing', { hasSessionId });
    } else if (action.state === 'creating' || action.state === 'running') {
      view.setStage('running', { hasSessionId });
    } else if (action.state === 'failed') {
      view.setError(`交接失败：${action.errorCode || 'HANDOFF_FAILED'}`);
      view.setStage('failed', { hasSessionId });
    }
  }

  async function handlePrepare(opToken, controller, initialGen, initialActiveId, savedSnapshot, targetCardId) {
    if (isDisposed || getIsDisposed() || isPreparing) return;
    if (!selectedAgentId) {
      view.setError('请先选择目标智能体');
      return;
    }

    isPreparing = true;
    view.setError('');
    view.setStage('preparing');

    const prepareOp = opToken;
    const prepareInputEpoch = inputEpoch;

    let dto;
    try {
      dto = buildContext(selectedAgentId, nextStepText, savedSnapshot, targetCardId);
    } catch (err) {
      view.setError(safeDetail(err?.message || err));
      view.setStage('init');
      isPreparing = false;
      return;
    }

    try {
      const resp = await requestHost(hana, '/api/handoff/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      });
      const data = await resp.json();
      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== prepareOp ||
        inputEpoch !== prepareInputEpoch ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }
      if (!data || !data.ok || !data.action?.actionId) {
        throw new Error(data?.error || '准备交接动作失败');
      }
      currentAction = data.action;
      view.setStage('prepared');
    } catch (err) {
      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== prepareOp ||
        inputEpoch !== prepareInputEpoch ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }
      view.setError('准备失败：' + safeDetail(err?.message || err));
      view.setStage('init');
    } finally {
      isPreparing = false;
    }
  }

  async function handleConfirm(opToken, controller, initialGen, initialActiveId) {
    if (isDisposed || getIsDisposed() || isConfirming || !currentAction?.actionId) return;
    isConfirming = true;
    view.setError('');
    view.setStage('confirming');

    const confirmOp = opToken;
    const targetActionId = currentAction.actionId;

    try {
      const resp = await requestHost(hana, '/api/handoff/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId: targetActionId }),
      });
      const data = await resp.json();
      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== confirmOp ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }
      if (!data || !data.ok || !data.action) {
        throw new Error(data?.error || '交接处理异常');
      }
      if (data.action.actionId !== targetActionId) {
        view.setError('确认响应动作标识不匹配');
        return;
      }
      currentAction = data.action;
      applyActionResult(data.action);
    } catch (err) {
      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== confirmOp ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }
      view.setError('确认未完成，需按原动作查询；不会自动重发。');
      view.setStage('error-recoverable');
    } finally {
      isConfirming = false;
    }
  }

  async function handleRecover(actionId, opToken, controller, initialGen, initialActiveId) {
    if (isDisposed || getIsDisposed() || isQuerying || !actionId) return;
    isQuerying = true;
    view.setError('');

    const queryOp = opToken;
    const targetActionId = actionId;

    try {
      const resp = await requestHost(hana, `/api/handoff/actions/${encodeURIComponent(targetActionId)}`);
      const data = await resp.json();
      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== queryOp ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }
      if (!data || !data.ok || !data.action) {
        throw new Error(data?.error || '查询动作状态失败');
      }
      if (data.action.actionId !== targetActionId) {
        view.setError('查询响应动作标识不匹配');
        return;
      }
      currentAction = data.action;
      applyActionResult(data.action);
    } catch (err) {
      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== queryOp ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }
      view.setError('查询恢复失败：' + safeDetail(err?.message || err));
    } finally {
      isQuerying = false;
    }
  }

  async function handleFocus(sessionId, opToken, controller, initialGen, initialActiveId) {
    if (isDisposed || getIsDisposed() || isFocusing || !sessionId) return;
    const focusOp = opToken;

    if (controller.state.generation !== initialGen || controller.state.activeId !== initialActiveId) {
      return;
    }

    isFocusing = true;
    try {
      await hana.sessions.focus({ sessionId });
    } catch (err) {
      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== focusOp ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }
      view.setError('聚焦会话失败：' + safeDetail(err?.message || err) + '，您可以再次点击重试。');
    } finally {
      isFocusing = false;
    }
  }

  async function open(targetCardId) {
    if (isOpening || isDisposed || getIsDisposed()) return;
    isOpening = true;

    try {
      const cards = getCards();
      const targetCard = cards.find(c => c.id === targetCardId);
      if (!targetCard) {
        flashMessage('目标卡片不存在');
        return;
      }

      // 1. 显式有界遍历检查目标及祖先忙碌状态（含被 exclude 的卡片）
      let relatedCardIds;
      try {
        relatedCardIds = collectAncestorsWithBoundedStack(targetCardId, cards);
      } catch (err) {
        flashMessage(safeDetail(err?.message || err));
        return;
      }

      for (const id of relatedCardIds) {
        if (isCardBusy(id)) {
          flashMessage('目标卡片或其祖先节点正在处理中，请等待完成后再继续。');
          return;
        }
      }

      // 2. 检查会话控制器状态并捕获代际
      const controller = getActiveSessionController();
      const sState = controller?.state;
      if (!sState || !sState.ready || sState.busy || sState.saving || !sState.activeId) {
        flashMessage('当前会话正在保存或正忙，请稍后重试。');
        return;
      }

      const initialGen = sState.generation;
      const initialActiveId = sState.activeId;
      const initialController = controller;
      const opToken = ++activeOpToken;

      // 3. 执行 flush 并核实版本
      try {
        await controller.flush(true);
      } catch (err) {
        flashMessage('会话保存失败：' + safeDetail(err?.message || err));
        return;
      }

      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== opToken ||
        controller !== initialController ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }

      // 4. 获取已保存不可变快照（只读 active，绝不再次 capture 伪装保存版本）
      let savedSnapshot;
      try {
        savedSnapshot = controller.getSavedSnapshot();
      } catch (err) {
        flashMessage('获取已保存快照失败：' + safeDetail(err?.message || err));
        return;
      }

      if (!savedSnapshot || savedSnapshot.id !== initialActiveId) return;

      // 5. 准入前置检查：查询 capabilities
      let caps = null;
      try {
        const resp = await requestHost(hana, '/api/handoff/capabilities');
        caps = await resp.json();
      } catch (err) {
        flashMessage('查询交接支持能力失败：' + safeDetail(err?.message || err));
        return;
      }

      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== opToken ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }



      // 6. 查询已有历史动作 actions
      let historyActions = [];
      try {
        const resp = await requestHost(hana, '/api/handoff/actions');
        const data = await resp.json();
        if (data && data.ok && Array.isArray(data.actions)) {
          historyActions = data.actions;
        }
      } catch {}

      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== opToken ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }

      const matchingAction = historyActions.find(
        a => a?.source?.canvasId === savedSnapshot.id && a?.source?.targetCardId === targetCardId
      );

      // 7. 拉取 Agent 列表
      let agents = [];
      try {
        const resp = await requestHost(hana, '/api/agents');
        const data = await resp.json();
        if (data && data.ok && Array.isArray(data.agents)) {
          agents = data.agents.filter(a => a && typeof a.id === 'string' && a.id.trim());
        }
      } catch {}

      if (
        isDisposed ||
        getIsDisposed() ||
        activeOpToken !== opToken ||
        controller.state.generation !== initialGen ||
        controller.state.activeId !== initialActiveId
      ) {
        return;
      }

      if (agents.length === 0) {
        flashMessage('获取可用智能体列表失败或当前无可用智能体');
        return;
      }

      // 8. 存在历史动作时，仅作为只读历史展示，绝不自动准备或确认
      if (matchingAction) {
        currentAction = matchingAction;
        const hasSessionId = Boolean(matchingAction.sessionId);

        const opened = view.open({
          context: null,
          agents,
          selectedAgentId: matchingAction.agentId || '',
          onAgentChange: () => {},
          onNextStepChange: () => {},
          onCopyDraft: () => {},
          onPrepare: () => {},
          onConfirm: () => {},
          onRecover: () => handleRecover(matchingAction.actionId, opToken, controller, initialGen, initialActiveId),
          onFocus: () => handleFocus(matchingAction.sessionId, opToken, controller, initialGen, initialActiveId),
          onClose: () => {
            activeOpToken++;
            currentAction = null;
          },
        });
        if (!opened) {
          flashMessage('无法打开模态对话框，交接已取消。');
          return;
        }

        if (matchingAction.state === 'ready') {
          view.setStage('ready', { hasSessionId });
        } else if (matchingAction.state === 'partial') {
          view.setError(`交接部分完成 (${matchingAction.errorCode || 'HANDOFF_PARTIAL'})，会话已创建，可点击核查。`);
          view.setStage('partial', { hasSessionId });
        } else if (matchingAction.state === 'unknown') {
          view.setError('交接结果暂时无法确认，需按原动作查询；不会自动重发。');
          view.setStage('unknown', { hasSessionId });
        } else if (matchingAction.state === 'importing') {
          view.setStage('importing', { hasSessionId });
        } else if (matchingAction.state === 'creating' || matchingAction.state === 'running') {
          view.setStage('running', { hasSessionId });
        } else if (matchingAction.state === 'failed') {
          view.setError(`交接失败：${matchingAction.errorCode || 'HANDOFF_FAILED'}`);
          view.setStage('failed', { hasSessionId });
        } else if (matchingAction.state === 'prepared') {
          view.setError('发现历史准备动作，但历史记录不包含正文；无法直接确认。');
          view.setStage('history-prepared', { hasSessionId });
        }
        return;
      }

      // 9. 无历史动作时，进入新预览流程
      const snapshotAgentId = savedSnapshot.snapshot?.agent?.id || '';
      const match = agents.some(a => a.id === snapshotAgentId);
      selectedAgentId = match ? snapshotAgentId : '';
      nextStepText = '';

      const previewAgentId = selectedAgentId || agents[0]?.id || 'default';
      try {
        currentContext = buildContext(previewAgentId, nextStepText, savedSnapshot, targetCardId);
      } catch (err) {
        flashMessage('生成交接上下文失败：' + safeDetail(err?.message || err));
        return;
      }

      inputEpoch = 0;
      currentAction = null;

      const opened = view.open({
        context: currentContext,
        agents,
        selectedAgentId,
        onAgentChange: (newAgentId) => {
          inputEpoch++;
          selectedAgentId = newAgentId;
          currentAction = null;
          view.setError('');
          view.setStage('init');
          if (selectedAgentId) {
            try {
              currentContext = buildContext(selectedAgentId, nextStepText, savedSnapshot, targetCardId);
              view.updatePreview(currentContext);
            } catch (err) {
              view.setError(safeDetail(err?.message || err));
            }
          }
        },
        onNextStepChange: (newNextStep) => {
          inputEpoch++;
          nextStepText = newNextStep;
          currentAction = null;
          view.setError('');
          view.setStage('init');
        },
        onCopyDraft: () => {
          const targetSavedCard = savedSnapshot.snapshot.cards.find(c => c.id === targetCardId);
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
          inputEpoch++;
          nextStepText = draft;
          view.setNextStepValue(draft);
          currentAction = null;
          view.setError('');
          view.setStage('init');
        },
        onPrepare: () => handlePrepare(opToken, controller, initialGen, initialActiveId, savedSnapshot, targetCardId),
        onConfirm: () => handleConfirm(opToken, controller, initialGen, initialActiveId),
        onRecover: () => handleRecover(currentAction?.actionId, opToken, controller, initialGen, initialActiveId),
        onFocus: () => handleFocus(currentAction?.sessionId, opToken, controller, initialGen, initialActiveId),
        onClose: () => {
          activeOpToken++;
          currentAction = null;
        },
      });

      if (!opened) {
        flashMessage('无法打开模态对话框，交接已取消。');
        return;
      }

      view.setStage('init');
    } finally {
      isOpening = false;
    }
  }

  function dispose() {
    isDisposed = true;
    activeOpToken++;
    if (view) {
      view.dispose();
    }
  }

  return {
    open,
    dispose,
  };
}

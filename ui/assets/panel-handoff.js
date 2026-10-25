/**
 * 分支交接控制器：协调已保存不可变快照、祖先拓扑忙碌检查、Agent 选择、准备与确认流程。
 *
 * 遵循原则（Task 3 Round 3 三种意图边界与架构规范）：
 * 1. open(targetCardId)：只读 metadata 意图。早期真正 modal/loading 挂载，直接获取 capabilities 与 actions，
 *    不得提前执行 flush/getSavedSnapshot，不被当前保存失败或祖先忙碌阻断已有历史查看与聚焦；
 *    相同 targetCardId 在途 open 请求单飞去重并复用同一 Promise。
 * 2. 历史动作选择：只读特定动作意图。支持展示与切换本画布同一目标下的多个历史动作；切换历史动作使用全新作用域，
 *    旧动作在途 query 响应决不覆盖当前选中的历史动作。
 * 3. 明确新建预览或首次无历史：建立全新 preview op（不继承旧 savedSnapshot）。
 *    彻底作废旧 op，重新核实控制器可保存态与依赖忙碌，执行 flush 成功后捕获点击时的最新 savedSnapshot（最新 revision 与内容）。
 * 4. 历史 GET 失败提供独立的 GET-only 重试回调，单飞去重，0 flush 且 0 POST。
 * 5. 保留已闭合项：动态 getSessionController、POST 前有界拓扑忙碌即时复核、严格 capabilities 准入、
 *    中性确认失败提示、ID-only focus、无假 Agent 权威正文、输入 stale 标记与同 DTO canonical 一致性。
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
  let pendingOpen = null; // { targetCardId, activeId, generation, controller, promise }

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
      // 历史模式下，若当前选中的动作已切换，丢弃旧动作迟到响应
      if (op.isHistoryMode && op.selectedActionId && op.selectedActionId !== targetActionId) {
        return;
      }
      if (!data || !data.ok || !data.action) {
        throw new Error(data?.error || '查询动作状态失败');
      }
      if (data.action.actionId !== targetActionId) {
        view.setError('查询响应动作标识不匹配');
        return;
      }
      op.currentAction = data.action;
      const idx = op.historyActions.findIndex(a => a.actionId === targetActionId);
      if (idx >= 0) op.historyActions[idx] = data.action;

      applyActionResult(op, data.action);
    } catch (err) {
      if (!isCurrent(op)) return;
      if (op.isHistoryMode && op.selectedActionId && op.selectedActionId !== targetActionId) {
        return;
      }
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

  function selectHistoryAction(op, actionId, matchingActions = op.historyActions) {
    if (!isCurrent(op)) return;
    const currentMatching = matchingActions.filter(
      a => a?.source?.canvasId === op.activeId && a?.source?.targetCardId === op.targetCardId
    );
    const targetAction = currentMatching.find(a => a.actionId === actionId) || currentMatching[0];
    if (!targetAction) return;

    op.selectedActionId = targetAction.actionId;
    op.currentAction = targetAction;

    const hasSessionId = Boolean(targetAction.sessionId);

    view.renderHistory({
      actions: currentMatching,
      selectedActionId: targetAction.actionId,
      action: targetAction,
      hasSessionId,
      onActionSelect: (newActionId) => {
        if (!isCurrent(op)) return;
        selectHistoryAction(op, newActionId, currentMatching);
      },
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
        await startNewPreview(op, { isInitial: false });
      },
      onClose: () => {
        op.closed = true;
        if (activeOp === op) activeOp = null;
        view.close();
      },
    });

    applyActionResult(op, targetAction);
  }

  async function startNewPreview(parentOp, { isInitial = false } = {}) {
    // 1. 彻底作废旧 op
    parentOp.closed = true;

    // 2. 获取当前控制器与状态
    const controller = getActiveSessionController();
    const sState = controller?.state;
    if (!sState || !sState.ready || sState.busy || sState.saving || !sState.activeId) {
      const msg = '当前会话正在保存或正忙，请稍后重试。';
      if (isInitial) {
        view.close();
        flashMessage(msg);
      } else {
        view.setError(msg);
      }
      return;
    }

    // 3. 建立全新 preview op（不继承旧 savedSnapshot！）
    const previewOp = {
      token: ++opSeq,
      controller,
      generation: sState.generation,
      activeId: sState.activeId,
      targetCardId: parentOp.targetCardId,
      closed: false,
      inputEpoch: 0,
      savedSnapshot: null,
      caps: parentOp.caps,
      capsOk: parentOp.capsOk,
      agents: parentOp.agents || [],
      currentAction: null,
      selectedAgentId: '',
      nextStepText: '',
      isPreparing: false,
      isConfirming: false,
      isQuerying: false,
      isFocusing: false,
      isHistoryMode: false,
    };
    activeOp = previewOp;

    // 4. 新预览准入校验：检查 capabilities
    if (!previewOp.capsOk) {
      const reason = (previewOp.caps?.reason === 'HANDOFF_PERMISSION_MISSING' || previewOp.caps?.home === false)
        ? '缺少主页会话创建权限，无法交接'
        : '宿主环境暂不支持分支交接';
      view.setError(reason);
      return;
    }

    // 5. 检查祖先忙碌与依赖上限
    try {
      if (checkAnyBusy(previewOp.targetCardId, getCards())) {
        const msg = '目标卡片或其祖先节点正在处理中，请等待完成后再继续。';
        if (isInitial) {
          view.close();
          flashMessage(msg);
        } else {
          view.setError(msg);
        }
        return;
      }
    } catch (err) {
      const msg = safeDetail(err?.message || err);
      if (isInitial) {
        view.close();
        flashMessage(msg);
      } else {
        view.setError(msg);
      }
      return;
    }

    // 6. 执行 flush 并核实版本
    try {
      await controller.flush(true);
    } catch (err) {
      if (!isCurrent(previewOp)) return;
      view.setError('会话保存失败：' + safeDetail(err?.message || err));
      return;
    }
    if (!isCurrent(previewOp)) return;

    // 7. 获取不可变已保存快照（重新读取最新 savedSnapshot！）
    let savedSnapshot;
    try {
      savedSnapshot = controller.getSavedSnapshot();
    } catch (err) {
      if (!isCurrent(previewOp)) return;
      view.setError('获取已保存快照失败：' + safeDetail(err?.message || err));
      return;
    }
    if (!isCurrent(previewOp)) return;
    if (!savedSnapshot || savedSnapshot.id !== previewOp.activeId) {
      view.setError('会话快照与当前画布不匹配');
      return;
    }
    previewOp.savedSnapshot = savedSnapshot;

    // 8. 获取 agents
    if (!previewOp.agents || previewOp.agents.length === 0) {
      let agents = [];
      try {
        const resp = await requestHost(hana, '/api/agents');
        const data = await resp.json();
        if (data && data.ok && Array.isArray(data.agents)) {
          agents = data.agents.filter(a => a && typeof a.id === 'string' && a.id.trim());
        }
      } catch {}
      if (!isCurrent(previewOp)) return;
      if (agents.length === 0) {
        view.setError('获取可用智能体列表失败或当前无可用智能体');
        return;
      }
      previewOp.agents = agents;
    }

    // 9. 确定默认选中 Agent 并初始化上下文
    const snapshotAgentId = savedSnapshot.snapshot?.agent?.id || '';
    const match = previewOp.agents.some(a => a.id === snapshotAgentId);
    previewOp.selectedAgentId = match ? snapshotAgentId : '';
    previewOp.nextStepText = '';
    previewOp.inputEpoch = 0;
    previewOp.currentAction = null;

    let initialDto = null;
    if (previewOp.selectedAgentId) {
      try {
        initialDto = buildContext(previewOp.selectedAgentId, previewOp.nextStepText, savedSnapshot, previewOp.targetCardId);
      } catch (err) {
        view.setError('生成交接上下文失败：' + safeDetail(err?.message || err));
        return;
      }
    }

    // 10. 渲染新预览视图
    view.renderNewPreview({
      context: initialDto,
      agents: previewOp.agents,
      selectedAgentId: previewOp.selectedAgentId,
      nextStepText: previewOp.nextStepText,
      onAgentChange: (newAgentId) => {
        if (!isCurrent(previewOp)) return;
        previewOp.inputEpoch++;
        previewOp.selectedAgentId = newAgentId;
        previewOp.currentAction = null;
        view.setError('');
        view.setStage('init');
        if (previewOp.selectedAgentId) {
          try {
            const dto = buildContext(previewOp.selectedAgentId, previewOp.nextStepText, previewOp.savedSnapshot, previewOp.targetCardId);
            view.updatePreview(dto);
          } catch (err) {
            view.setError(safeDetail(err?.message || err));
          }
        } else {
          view.updatePreview(null);
        }
      },
      onNextStepChange: (newNextStep) => {
        if (!isCurrent(previewOp)) return;
        previewOp.inputEpoch++;
        previewOp.nextStepText = newNextStep;
        previewOp.currentAction = null;
        view.setError('');
        view.setStage('init');
        view.markPreviewStale(newNextStep);
      },
      onCopyDraft: () => {
        if (!isCurrent(previewOp)) return;
        const targetSavedCard = previewOp.savedSnapshot.snapshot.cards.find(c => c.id === previewOp.targetCardId);
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
        previewOp.inputEpoch++;
        previewOp.nextStepText = draft;
        view.setNextStepValue(draft);
        previewOp.currentAction = null;
        view.setError('');
        view.setStage('init');
        view.markPreviewStale(draft);
      },
      onPrepare: () => handlePrepare(previewOp),
      onConfirm: () => handleConfirm(previewOp),
      onRecover: () => handleRecover(previewOp),
      onFocus: () => handleFocus(previewOp),
      onClose: () => {
        previewOp.closed = true;
        if (activeOp === previewOp) activeOp = null;
        view.close();
      },
    });

    view.setStage('init');
  }

  async function loadHistoryActions(op) {
    let historyActions = [];
    try {
      const resp = await requestHost(hana, '/api/handoff/actions');
      const data = await resp.json();
      if (resp.status < 200 || resp.status >= 300 || !data || !data.ok || !Array.isArray(data.actions)) {
        throw new Error(data?.error || '查询历史动作失败');
      }
      historyActions = data.actions;
    } catch (err) {
      if (!isCurrent(op)) return false;
      view.renderError({
        message: '查询历史交接记录失败：' + safeDetail(err?.message || err) + '，请点击重试。',
        onRetry: () => retryLoadHistory(op),
        onClose: () => {
          op.closed = true;
          if (activeOp === op) activeOp = null;
          view.close();
        },
      });
      return false;
    }
    if (!isCurrent(op)) return false;
    op.historyActions = historyActions;
    return true;
  }

  async function retryLoadHistory(op) {
    if (!isCurrent(op) || op.isRetrying) return;
    op.isRetrying = true;
    try {
      const ok = await loadHistoryActions(op);
      if (ok && isCurrent(op)) {
        await processHistoryOrNewPreview(op);
      }
    } finally {
      op.isRetrying = false;
    }
  }

  async function processHistoryOrNewPreview(op) {
    if (!isCurrent(op)) return;

    // 匹配当前画布与目标卡片的所有历史动作
    const matchingActions = op.historyActions.filter(
      a => a?.source?.canvasId === op.activeId && a?.source?.targetCardId === op.targetCardId
    );

    if (matchingActions.length > 0) {
      // 存在历史动作：进入历史模式（不检查 busy，不 flush，不校验快照）
      op.isHistoryMode = true;
      selectHistoryAction(op, matchingActions[0].actionId, matchingActions);
      return;
    }

    // 无历史动作：进入新预览意图
    if (!op.capsOk) {
      const reason = (op.caps?.reason === 'HANDOFF_PERMISSION_MISSING' || op.caps?.home === false)
        ? '缺少主页会话创建权限，无法交接'
        : '宿主环境暂不支持分支交接';
      view.setError(reason);
      return;
    }

    // 检查祖先忙碌与依赖上限（无历史时忙碌直接关闭并 flash，符合 C2/I1）
    try {
      if (checkAnyBusy(op.targetCardId, getCards())) {
        view.close();
        flashMessage('目标卡片或其祖先节点正在处理中，请等待完成后再继续。');
        op.closed = true;
        if (activeOp === op) activeOp = null;
        return;
      }
    } catch (err) {
      view.close();
      flashMessage(safeDetail(err?.message || err));
      op.closed = true;
      if (activeOp === op) activeOp = null;
      return;
    }

    // 启动全新新预览 scope
    await startNewPreview(op, { isInitial: true });
  }

  async function executeOpen(targetCardId, controller, sState) {
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
      caps: null,
      capsOk: false,
      agents: [],
      historyActions: [],
      selectedActionId: '',
      currentAction: null,
      isQuerying: false,
      isFocusing: false,
      isRetrying: false,
      isHistoryMode: false,
    };
    activeOp = op;

    // 早期挂载模态对话框与 loading 态（在首次异步等待前）
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

    // 1. 查询 capabilities（只读 metadata，不 flush，不 getSavedSnapshot）
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

    // 2. 查询历史动作 actions
    const ok = await loadHistoryActions(op);
    if (!ok || !isCurrent(op)) return;

    // 3. 处理历史记录或进入新预览
    await processHistoryOrNewPreview(op);
  }

  async function open(targetCardId) {
    if (isDisposed || getIsDisposed()) return;
    const cards = getCards();
    const targetCard = cards.find(c => c.id === targetCardId);
    if (!targetCard) {
      flashMessage('目标卡片不存在');
      return;
    }

    const controller = getActiveSessionController();
    const sState = controller?.state;
    if (!sState || !sState.activeId) return;

    // 如果针对同一 targetCardId、activeId、generation 的 open 已在途挂起，复用在途 Promise（单飞去重）
    if (
      pendingOpen &&
      pendingOpen.targetCardId === targetCardId &&
      pendingOpen.activeId === sState.activeId &&
      pendingOpen.generation === sState.generation &&
      pendingOpen.controller === controller
    ) {
      return pendingOpen.promise;
    }

    const openPromise = (async () => {
      try {
        await executeOpen(targetCardId, controller, sState);
      } finally {
        if (pendingOpen?.promise === openPromise) {
          pendingOpen = null;
        }
      }
    })();

    pendingOpen = {
      targetCardId,
      activeId: sState.activeId,
      generation: sState.generation,
      controller,
      promise: openPromise,
    };
    return openPromise;
  }

  function dispose() {
    isDisposed = true;
    pendingOpen = null;
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

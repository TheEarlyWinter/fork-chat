/**
 * 分支交接控制器：协调已保存不可变快照、祖先拓扑忙碌检查、Agent 选择、准备与确认流程。
 *
 * 遵循原则：
 * 1. 显式有界遍历检查祖先忙碌状态，避免深链递归溢出。
 * 2. 严格按成功保存的不可变快照提取内容，绝不重新捕获实时画布伪装保存。
 * 3. confirm 请求严格只携带 { actionId }，网络失败只支持 GET 恢复，绝不自动重试 POST。
 * 4. focus 失败仅重试 focus，绝不重新 prepare 或创建。
 */

import { buildHandoffContext } from './fork-handoff-context.js';
import { HANDOFF_LIMITS } from './fork-handoff-contract.js';
import { createHandoffView } from './panel-handoff-view.js';

export function createPanelHandoff(deps = {}) {
  const {
    hana,
    requestHost,
    sessionController,
    getCards = () => [],
    isCardBusy = () => false,
    flashMessage = () => {},
    safeDetail = (s) => String(s ?? ''),
    getIsDisposed = () => false,
    documentRef = (typeof document !== 'undefined' ? document : null),
  } = deps;

  let isDisposed = false;
  let view = createHandoffView({ documentRef });

  // 显式栈有界遍历目标及祖先节点（避免深链递归栈溢出）
  function collectAncestorsWithBoundedStack(targetCardId, allCards) {
    const cardMap = new Map();
    for (const c of allCards) {
      if (c && typeof c.id === 'string') cardMap.set(c.id, c);
    }

    const visited = new Set();
    const stack = [targetCardId];
    let iterations = 0;
    const MAX_ITERATIONS = 10000;

    while (stack.length > 0 && iterations++ < MAX_ITERATIONS) {
      const currentId = stack.pop();
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);

      const card = cardMap.get(currentId);
      if (!card) continue;

      // 提取多父或单父
      const parentIds = Array.isArray(card.parentIds)
        ? card.parentIds
        : (card.parentId ? [card.parentId] : []);

      for (const pId of parentIds) {
        if (pId && !visited.has(pId)) stack.push(pId);
      }
    }

    return Array.from(visited);
  }

  async function open(targetCardId) {
    if (isDisposed || getIsDisposed()) return;

    const cards = getCards();
    const targetCard = cards.find(c => c.id === targetCardId);
    if (!targetCard) {
      flashMessage('目标卡片不存在');
      return;
    }

    // 1. 显式有界遍历检查目标及祖先忙碌状态（含被 exclude 的卡片）
    const relatedCardIds = collectAncestorsWithBoundedStack(targetCardId, cards);
    for (const id of relatedCardIds) {
      if (isCardBusy(id)) {
        flashMessage('目标卡片或其祖先节点正在处理中，请等待完成后再继续。');
        return;
      }
    }

    // 2. 检查会话控制器状态并捕获代际
    const sState = sessionController?.state;
    if (!sState || sState.busy || sState.saving || !sState.activeId) {
      flashMessage('当前会话正在保存或正忙，请稍后重试。');
      return;
    }

    const initialGen = sessionController.state.generation;
    const initialActiveId = sessionController.state.activeId;

    // 3. 执行 flush 并核实版本
    try {
      await sessionController.flush(true);
    } catch (err) {
      flashMessage('会话保存失败：' + safeDetail(err?.message || err));
      return;
    }

    if (isDisposed || getIsDisposed() ||
        sessionController.state.generation !== initialGen ||
        sessionController.state.activeId !== initialActiveId) {
      return;
    }

    // 4. 获取已保存不可变快照（只读 active，绝不再次 capture 伪装保存版本）
    let savedSnapshot;
    try {
      savedSnapshot = sessionController.getSavedSnapshot();
    } catch (err) {
      flashMessage('获取已保存快照失败：' + safeDetail(err?.message || err));
      return;
    }

    if (!savedSnapshot || savedSnapshot.id !== initialActiveId) return;

    // 5. 拉取 Agent 列表（注意：经 profile 投影没有 state 字段，必须验证 ok === true，失败固定提示）
    let agents = [];
    try {
      const resp = await requestHost(hana, '/api/agents');
      const data = await resp.json();
      if (data && data.ok && Array.isArray(data.agents)) {
        agents = data.agents.filter(a => a && typeof a.id === 'string' && a.id.trim());
      }
    } catch {
      // 阶段固定提示，不展示 raw error，不假 fallback
    }

    if (agents.length === 0) {
      flashMessage('获取可用智能体列表失败，请稍后重试');
      return;
    }

    let selectedAgentId = agents[0].id;
    // 若列表中包含当前 agent 则优先选中
    const currentCandidate = agents.find(a => a.isCurrent);
    if (currentCandidate) selectedAgentId = currentCandidate.id;

    // 6. 构造初始 DTO 预览
    let nextStepText = '';
    let currentContext = null;

    function buildContext(agentId, nextStep) {
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

    try {
      currentContext = buildContext(selectedAgentId, nextStepText);
    } catch (err) {
      flashMessage('生成交接上下文失败：' + safeDetail(err?.message || err));
      return;
    }

    let preparedAction = null;
    let isConfirming = false;

    // 7. 打开视图
    view.open({
      context: currentContext,
      agents,
      selectedAgentId,
      onAgentChange: (newAgentId) => {
        selectedAgentId = newAgentId;
        preparedAction = null;
        view.setError('');
        view.setStage('init');
        try {
          currentContext = buildContext(selectedAgentId, nextStepText);
        } catch (err) {
          view.setError(safeDetail(err?.message || err));
        }
      },
      onNextStepChange: (newNextStep) => {
        nextStepText = newNextStep;
        preparedAction = null;
        view.setError('');
        view.setStage('init');
      },
      onCopyDraft: () => {
        // 查找保存快照中目标卡的 draft
        const targetSavedCard = savedSnapshot.snapshot.cards.find(c => c.id === targetCardId);
        const draft = typeof targetSavedCard?.draft === 'string' ? targetSavedCard.draft : '';
        if (!draft) {
          view.setError('目标卡片没有可复制的草稿');
          return;
        }
        if (draft.length > HANDOFF_LIMITS.maxNextStepChars) {
          const msg = `草稿超出下一步字符上限 (${draft.length} > ${HANDOFF_LIMITS.maxNextStepChars})，无法复制。`;
          view.setError(msg);
          flashMessage(msg);
          return;
        }
        nextStepText = draft;
        view.setNextStepValue(draft);
        preparedAction = null;
        view.setError('');
        view.setStage('init');
      },
      onPrepare: async () => {
        if (isDisposed || getIsDisposed()) return;
        view.setError('');
        view.setStage('preparing');

        let dto;
        try {
          dto = buildContext(selectedAgentId, nextStepText);
        } catch (err) {
          view.setError(safeDetail(err?.message || err));
          view.setStage('init');
          return;
        }

        try {
          const resp = await requestHost(hana, '/api/handoff/prepare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dto),
          });
          const data = await resp.json();
          if (!data || !data.ok || !data.action?.actionId) {
            throw new Error(data?.error || '准备交接动作失败');
          }
          preparedAction = data.action;
          view.setStage('prepared');
        } catch (err) {
          view.setError('准备失败：' + safeDetail(err?.message || err));
          view.setStage('init');
        }
      },
      onConfirm: async () => {
        if (!preparedAction?.actionId || isConfirming) return;
        isConfirming = true;
        view.setError('');
        view.setStage('confirming');

        const actionId = preparedAction.actionId;
        try {
          const resp = await requestHost(hana, '/api/handoff/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionId }),
          });
          const data = await resp.json();
          if (!data || !data.ok || !data.action) {
            throw new Error(data?.error || '交接处理异常');
          }
          preparedAction = data.action;
          handleActionResult(data.action);
        } catch (err) {
          // 网络失败绝不自动重发 POST，切换到 recoverable 阶段引导 GET 恢复
          view.setError('交接已发送但未收到完成确认：' + safeDetail(err?.message || err) + '。请点击“查询恢复状态”以安全恢复。');
          view.setStage('recoverable');
        } finally {
          isConfirming = false;
        }
      },
      onRecover: async () => {
        if (!preparedAction?.actionId) return;
        view.setError('');
        try {
          const resp = await requestHost(hana, `/api/handoff/actions/${encodeURIComponent(preparedAction.actionId)}`);
          const data = await resp.json();
          if (!data || !data.ok || !data.action) {
            throw new Error(data?.error || '查询动作状态失败');
          }
          preparedAction = data.action;
          handleActionResult(data.action);
        } catch (err) {
          view.setError('查询恢复失败：' + safeDetail(err?.message || err));
        }
      },
      onFocus: async () => {
        if (!preparedAction?.sessionId) return;
        try {
          await hana.sessions.focus({ sessionId: preparedAction.sessionId });
        } catch (err) {
          view.setError('聚焦会话失败：' + safeDetail(err?.message || err) + '，您可以再次点击重试。');
        }
      },
      onClose: () => {
        preparedAction = null;
      },
    });

    view.setStage('init');
  }

  function handleActionResult(action) {
    if (action.state === 'ready') {
      view.setStage('ready');
    } else if (action.state === 'partial') {
      view.setError(`交接部分完成 (${action.errorCode || 'HANDOFF_PARTIAL'})，会话已创建，可点击核查。`);
      if (action.sessionId) view.setStage('ready');
      else view.setStage('recoverable');
    } else if (action.state === 'unknown') {
      view.setError('交接结果暂时无法确认，请稍后查询恢复，切勿重复发起。');
      view.setStage('recoverable');
    } else if (action.state === 'failed') {
      view.setError(`交接失败：${action.errorCode || 'HANDOFF_FAILED'}`);
      view.setStage('init');
    }
  }

  function dispose() {
    isDisposed = true;
    if (view) {
      view.close();
      view = null;
    }
  }

  return {
    open,
    dispose,
  };
}

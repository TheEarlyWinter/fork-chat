/**
 * 画布助手偏好与列表加载模块
 *
 * 负责主画布当前助手的状态持有、思考强度读写、顶部状态栏渲染、
 * 可用助手列表远程加载缓存以及跨面板广播事件中转。
 * 严禁在顶层访问 window 或 document，不反向依赖 panel.js。
 */

export function createInitialAgent(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  return {
    id: storage?.getItem?.('fork_chat_active_agent_id') || 'hakimi',
    name: storage?.getItem?.('fork_chat_active_agent_name') || 'Hakimi',
    model: storage?.getItem?.('fork_chat_active_agent_model') || 'gemini-3.8-flash-high',
    provider: storage?.getItem?.('fork_chat_active_agent_provider') || 'gemini',
  };
}

export function getInitialReasoningEffort(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  try {
    const val = storage?.getItem?.('fork_chat_reasoning_effort');
    return val && val !== 'default' ? val : null;
  } catch {
    return null;
  }
}

export function createAgentController(deps) {
  const {
    getAgent,
    setAgent,
    getReasoningEffort,
    setReasoningEffort,
    getActiveAgentDisplay,
    activeAgentDisplay,
    isBusy,
    renderCards,
    scheduleSave,
    isDisposed,
    hana,
    requestHost,
    abortable,
    getSignal,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
  } = deps;

  let cachedAgents = [];
  let agentsLoadingPromise = null;

  function getCurrentAgent() {
    return getAgent ? getAgent() : null;
  }

  function getCurrentReasoningEffort() {
    return getReasoningEffort ? getReasoningEffort() : null;
  }

  function updateHeaderStatus() {
    const display = typeof getActiveAgentDisplay === 'function' ? getActiveAgentDisplay() : activeAgentDisplay;
    const agent = getCurrentAgent();
    if (display && agent) {
      display.textContent = `当前助手: ${agent.name} [${agent.model || 'default'}]`;
    }
  }

  function getAgentReasoningEffort(agentId) {
    if (!agentId) return null;
    try {
      const val = storage?.getItem?.(`fork_chat_agent_effort_${agentId}`);
      return val && val !== 'default' ? val : null;
    } catch {
      return null;
    }
  }

  async function loadAvailableAgents() {
    const disposed = typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed);
    if (disposed) return [];
    if (cachedAgents.length > 0) return cachedAgents;
    if (agentsLoadingPromise) return agentsLoadingPromise;

    agentsLoadingPromise = (async () => {
      const current = getCurrentAgent() || createInitialAgent(storage);
      try {
        const signal = typeof getSignal === 'function' ? getSignal() : deps.signal;
        const req = requestHost ? requestHost(hana, '/api/agents', { signal }) : Promise.reject(new Error('no requestHost'));
        const res = abortable ? await abortable(req, signal) : await req;
        const jsonPromise = res.json();
        const data = abortable ? await abortable(jsonPromise, signal) : await jsonPromise;
        const stillDisposed = typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed);
        if (!stillDisposed && Array.isArray(data?.agents)) {
          cachedAgents = data.agents;
        }
      } catch {
        const stillDisposed = typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed);
        if (!stillDisposed) cachedAgents = [current];
      } finally {
        agentsLoadingPromise = null;
      }
      return cachedAgents;
    })();

    return agentsLoadingPromise;
  }

  function handleBroadcast(message) {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'REASONING_EFFORT_CHANGED') {
      const nextEffort = message.reasoningEffort || null;
      if (setReasoningEffort) setReasoningEffort(nextEffort);
      try {
        storage?.setItem?.('fork_chat_reasoning_effort', nextEffort || 'default');
      } catch {}
      scheduleSave?.();
      return true;
    }

    if (message.type === 'AGENT_CHANGED' && message.agent) {
      // 以前忙的时候直接丢掉这条广播，于是侧边栏已经高亮了新助手，
      // 主画布还在用旧的发消息。助手选择是界面偏好，不影响快照冲突，
      // 所以照样更新，只是暂不落盘。
      const deferSave = Boolean(isBusy?.());
      const current = getCurrentAgent() || {};
      const updated = { ...current, ...message.agent };
      if (setAgent) setAgent(updated);

      if (message.reasoningEffort !== undefined) {
        const nextEffort = message.reasoningEffort || null;
        if (setReasoningEffort) setReasoningEffort(nextEffort);
        try {
          storage?.setItem?.('fork_chat_reasoning_effort', nextEffort || 'default');
        } catch {}
      }

      for (const [key, value] of Object.entries({
        id: updated.id,
        name: updated.name,
        model: updated.model,
        provider: updated.provider,
      })) {
        try {
          storage?.setItem?.(`fork_chat_active_agent_${key}`, value || '');
        } catch {}
      }

      updateHeaderStatus();
      renderCards?.();
      if (!deferSave) {
        scheduleSave?.();
      }
      return true;
    }

    if (message.type === 'MODEL_CHANGED' && message.model) {
      updateHeaderStatus();
      return true;
    }

    return false;
  }

  function restoreAgent(snapshotAgent) {
    if (!snapshotAgent) return;
    const current = getCurrentAgent() || {};
    const updated = { ...current, ...snapshotAgent };
    if (setAgent) setAgent(updated);

    const nextEffort = snapshotAgent.reasoningEffort || null;
    if (setReasoningEffort) setReasoningEffort(nextEffort);
    try {
      storage?.setItem?.('fork_chat_reasoning_effort', nextEffort || 'default');
    } catch {}

    for (const [key, value] of Object.entries({
      id: updated.id,
      name: updated.name,
      model: updated.model,
      provider: updated.provider,
    })) {
      try {
        storage?.setItem?.(`fork_chat_active_agent_${key}`, value || '');
      } catch {}
    }
  }

  return {
    getCurrentAgent,
    getCurrentReasoningEffort,
    getAgentReasoningEffort,
    loadAvailableAgents,
    getAvailableAgents: () => cachedAgents.slice(),
    handleBroadcast,
    restoreAgent,
    updateHeaderStatus,
  };
}

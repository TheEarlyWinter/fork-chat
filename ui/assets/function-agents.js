/**
 * 助手列表与思考强度管理模块
 *
 * 负责助手列表渲染、模型思考能力匹配、思考深度独立下拉菜单与搜索过滤。
 * 纯函数优先外提，涉及 DOM 操作与状态变更通过工厂函数 createAgentListController(deps) 依赖注入。
 * 严禁直接访问 window/document 全局变量，确保在 VM 测试沙箱与真实浏览器中表现一致。
 */

export const THINKING_LEVEL_LABELS = Object.freeze({
  default: '默认',
  off: '不思考（None）',
  none: '不思考（None）',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极限',
});

export const THINKING_LEVEL_ALIASES = Object.freeze({
  default: 'default',
  none: 'off',
  off: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

export function normalizeThinkingLevel(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim().toLowerCase();
  return THINKING_LEVEL_ALIASES[key] || '';
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 匹配助手绑定模型的思考能力。provider/model 精确优先，
 * 同名模型跨供应商时不能只看 id，否则会拿到别人的思考档位。
 */
export function matchAgentModel(agent, models = []) {
  if (!agent || !Array.isArray(models)) return null;
  const exact = models.find(m => m.provider && agent.provider && m.provider === agent.provider && m.model === agent.model);
  if (exact) return exact;
  const byRef = models.find(m => m.ref === `${agent.provider}/${agent.model}`);
  if (byRef) return byRef;
  const byId = models.filter(m => m.id === agent.model || m.ref === agent.model);
  return byId.length === 1 ? byId[0] : null;
}

/**
 * 助手搜索过滤纯函数
 */
export function filterAgents(agents = [], query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return agents.slice();
  return agents.filter(a => {
    return (a.name || '').toLowerCase().includes(q) ||
           (a.id || '').toLowerCase().includes(q) ||
           (a.yuan || '').toLowerCase().includes(q) ||
           (a.model || '').toLowerCase().includes(q) ||
           (a.description || '').toLowerCase().includes(q);
  });
}

export function createAgentListController(deps) {
  const {
    hana,
    requestHost,
    channel,
    getBoundCanvasId,
    agentListEl,
    agentCountEl,
    searchInput,
    btnRefresh,
    document: doc,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
  } = deps;

  let agents = [];
  let models = [];
  let loadError = '';
  let activeAgentId = storage?.getItem?.('fork_chat_active_agent_id') || 'hakimi';
  let boundSelectionId = null;
  let pendingInitialSync = false;

  function setStorageIfChanged(key, value) {
    if (!storage || !key) return;
    const strVal = String(value);
    if (storage.getItem?.(key) !== strVal) {
      storage.setItem?.(key, strVal);
    }
  }

  function getAgentReasoningEffort(agentId) {
    if (!agentId) return 'default';
    try {
      return normalizeThinkingLevel(storage?.getItem?.(`fork_chat_agent_effort_${agentId}`)) || 'default';
    } catch {
      return 'default';
    }
  }

  function setAgentReasoningEffort(agentId, effort) {
    if (!agentId) return;
    const normalized = normalizeThinkingLevel(effort) || 'default';
    try {
      if (normalized === 'default') {
        storage?.removeItem?.(`fork_chat_agent_effort_${agentId}`);
      } else {
        storage?.setItem?.(`fork_chat_agent_effort_${agentId}`, normalized);
      }
    } catch {}
  }

  function renderAgentList() {
    if (loadError) {
      if (agentCountEl) agentCountEl.textContent = '0';
      if (agentListEl) agentListEl.innerHTML = `<div class="empty-state" role="alert">${escapeHtml(loadError)}</div>`;
      return;
    }
    const query = searchInput ? searchInput.value : '';
    const filtered = filterAgents(agents, query);

    if (agentCountEl) agentCountEl.textContent = String(agents.length);

    if (filtered.length === 0) {
      if (agentListEl) {
        agentListEl.innerHTML = `<div class="empty-state">${query ? '未找到匹配的助手' : '暂无可用助手'}</div>`;
      }
      return;
    }

    if (!agentListEl) return;
    agentListEl.innerHTML = '';
    filtered.forEach(a => {
      const card = doc.createElement('div');
      const isActive = a.id === activeAgentId;
      card.className = `agent-card ${isActive ? 'active' : ''}`;
      card.id = `agent-${a.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      const matchedModel = matchAgentModel(a, models);
      const supportsReasoning = Boolean(a.reasoning || matchedModel?.reasoning);
      const rawLevels = (Array.isArray(a.thinkingLevels) && a.thinkingLevels.length > 0)
        ? a.thinkingLevels
        : (Array.isArray(matchedModel?.thinkingLevels) ? matchedModel.thinkingLevels : []);

      const availableLevels = Array.from(new Set(rawLevels
        .map(normalizeThinkingLevel)
        .filter(level => level && level !== 'default')));

      let currentEffort = getAgentReasoningEffort(a.id);
      const options = Array.from(new Set(['default', ...availableLevels]));
      if (!options.includes(currentEffort)) {
        currentEffort = 'default';
        setAgentReasoningEffort(a.id, 'default');
      }

      card.innerHTML = `
        <div class="agent-card-top">
          <span class="agent-name">
            <span class="dot-indicator"></span>
            ${escapeHtml(a.name || a.id)}
          </span>
          ${isActive ? '<span class="active-tag">对话中</span>' : `<span class="yuan-tag mono">${escapeHtml(a.yuan || 'agent')}</span>`}
        </div>
        <div class="agent-meta">
          <span class="agent-provider-badge">${escapeHtml(a.provider || 'HOST')}</span>
          <span class="mono">${escapeHtml(a.model || 'default')}</span>
        </div>
        ${a.description ? `<div class="agent-desc">${escapeHtml(a.description)}</div>` : ''}
      `;

      if (supportsReasoning && availableLevels.length > 0) {
        const thinkingRow = doc.createElement('div');
        thinkingRow.className = 'agent-thinking-row';
        thinkingRow.setAttribute('data-agent-id', a.id);

        const label = doc.createElement('span');
        label.className = 'agent-thinking-label mono';
        label.textContent = '思考深度:';
        thinkingRow.appendChild(label);

        const select = doc.createElement('select');
        select.className = 'thinking-select mono';
        select.id = `select-${a.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        select.setAttribute('aria-label', `${a.name || a.id}思考强度`);

        options.forEach(opt => {
          const option = doc.createElement('option');
          option.value = opt;
          option.textContent = THINKING_LEVEL_LABELS[opt] || opt;
          if (opt === currentEffort) option.selected = true;
          select.appendChild(option);
        });
        select.value = currentEffort;

        const stopProp = (e) => {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        };
        select.addEventListener('mousedown', stopProp);
        select.addEventListener('click', stopProp);
        select.addEventListener('change', (e) => {
          stopProp(e);
          const newEffort = select.value || 'default';
          setAgentReasoningEffort(a.id, newEffort);

          if (a.id === activeAgentId) {
            storage?.setItem?.('fork_chat_reasoning_effort', newEffort);
            const targetCanvasId = getBoundCanvasId ? getBoundCanvasId() : undefined;
            channel?.postMessage({
              type: 'REASONING_EFFORT_CHANGED',
              reasoningEffort: newEffort === 'default' ? null : newEffort,
              targetCanvasId: targetCanvasId || undefined,
            });
          }
        });

        thinkingRow.appendChild(select);
        card.appendChild(thinkingRow);
      }

      card.addEventListener('click', () => {
        boundSelectionId = a.id;
        activeAgentId = a.id;
        setStorageIfChanged('fork_chat_active_agent_id', a.id);
        setStorageIfChanged('fork_chat_active_agent_name', a.name || a.id);
        setStorageIfChanged('fork_chat_active_agent_model', a.model || '');
        setStorageIfChanged('fork_chat_active_agent_provider', a.provider || '');

        const agentEffort = getAgentReasoningEffort(a.id);
        setStorageIfChanged('fork_chat_reasoning_effort', agentEffort);

        const targetCanvasId = getBoundCanvasId ? getBoundCanvasId() : undefined;

        channel?.postMessage({
          type: 'AGENT_CHANGED',
          agent: a,
          reasoningEffort: agentEffort === 'default' ? null : agentEffort,
          targetCanvasId: targetCanvasId || undefined,
        });

        channel?.postMessage({
          type: 'REASONING_EFFORT_CHANGED',
          reasoningEffort: agentEffort === 'default' ? null : agentEffort,
          targetCanvasId: targetCanvasId || undefined,
        });

        channel?.postMessage({
          type: 'MODEL_CHANGED',
          model: {
            ref: a.provider && a.model ? `${a.provider}/${a.model}` : a.model,
            name: `${a.name} [${a.model}]`,
            id: a.model,
            provider: a.provider,
          },
          targetCanvasId: targetCanvasId || undefined,
        });

        renderAgentList();
      });

      agentListEl.appendChild(card);
    });
  }

  async function loadAgents() {
    loadError = '';
    if (agentListEl) {
      agentListEl.innerHTML = '<div class="empty-state">正在检索系统助手清单...</div>';
    }
    try {
      const res = await requestHost(hana, 'api/agents');
      const data = await res.json();
      if (data.ok && Array.isArray(data.agents) && data.agents.length > 0) {
        agents = data.agents;
        models = Array.isArray(data.models) ? data.models : [];
      } else {
        throw new Error(data.error || '未返回有效助手列表');
      }
    } catch (err) {
      agents = [];
      loadError = `助手列表加载失败：${err.message}；可点击刷新重试。`;
      renderAgentList();
      return;
    }

    // 确定当前应该激活的 Agent：
    // 若已有明确绑定的选择（来自用户手动选择或会话恢复），优先保持 boundSelectionId；
    // 否则回退读取 storage 中的全局默认 storedAgentId 或当前的 activeAgentId
    const storedAgentId = storage?.getItem?.('fork_chat_active_agent_id');
    const targetId = boundSelectionId || storedAgentId || activeAgentId;

    const current = agents.find(a => a.id === targetId) || agents[0];

    if (current) {
      activeAgentId = current.id;
      boundSelectionId = current.id;
      setStorageIfChanged('fork_chat_active_agent_id', current.id);
      setStorageIfChanged('fork_chat_active_agent_name', current.name || current.id);
      setStorageIfChanged('fork_chat_active_agent_model', current.model || '');
      setStorageIfChanged('fork_chat_active_agent_provider', current.provider || '');

      const agentEffort = getAgentReasoningEffort(current.id);
      setStorageIfChanged('fork_chat_reasoning_effort', agentEffort);

      const targetCanvasId = getBoundCanvasId ? getBoundCanvasId() : undefined;
      if (targetCanvasId) {
        pendingInitialSync = false;
        channel?.postMessage({
          type: 'AGENT_CHANGED',
          agent: current,
          reasoningEffort: agentEffort === 'default' ? null : agentEffort,
          targetCanvasId,
        });
        channel?.postMessage({
          type: 'REASONING_EFFORT_CHANGED',
          reasoningEffort: agentEffort === 'default' ? null : agentEffort,
          targetCanvasId,
        });
      } else {
        pendingInitialSync = true;
      }
    }

    renderAgentList();
  }

  function restoreAgent(agentData) {
    if (!agentData || !agentData.id) return;
    let candidateId = agentData.id;
    let candidateAgent = null;

    if (agents.length > 0) {
      candidateAgent = agents.find(a => a.id === candidateId);
      if (!candidateAgent) {
        candidateAgent = agents[0];
        candidateId = candidateAgent.id;
      }
    }

    const restoredId = candidateId;
    // 只有当恢复的是同一个 Agent ID 时，才应用该快照中记录的 reasoningEffort；
    // 若已降级回退到别的 Agent，必须保留目标 Agent 原有设置，不能被已删除 Agent 覆盖
    if (candidateId === agentData.id && agentData.reasoningEffort !== undefined) {
      setAgentReasoningEffort(restoredId, agentData.reasoningEffort || 'default');
    }

    const isInvalidCorrection = Boolean(agents.length > 0 && candidateId !== agentData.id);

    activeAgentId = restoredId;
    boundSelectionId = restoredId;
    setStorageIfChanged('fork_chat_active_agent_id', restoredId);

    // 字段更新：已存在 candidateAgent 时使用其实际元数据（缺失则写空串清理残留）；
    // 仅在真实列表未就绪时沿用原快照元数据
    if (candidateAgent) {
      setStorageIfChanged('fork_chat_active_agent_name', candidateAgent.name || candidateAgent.id);
      setStorageIfChanged('fork_chat_active_agent_model', candidateAgent.model || '');
      setStorageIfChanged('fork_chat_active_agent_provider', candidateAgent.provider || '');
    } else {
      if (agentData.name) setStorageIfChanged('fork_chat_active_agent_name', agentData.name);
      if (agentData.model) setStorageIfChanged('fork_chat_active_agent_model', agentData.model);
      if (agentData.provider) setStorageIfChanged('fork_chat_active_agent_provider', agentData.provider);
    }

    const targetCanvasId = getBoundCanvasId ? getBoundCanvasId() : undefined;
    if (targetCanvasId && candidateAgent && (isInvalidCorrection || pendingInitialSync)) {
      pendingInitialSync = false;
      const effort = getAgentReasoningEffort(candidateAgent.id);
      channel?.postMessage({
        type: 'AGENT_CHANGED',
        agent: candidateAgent,
        reasoningEffort: effort === 'default' ? null : effort,
        targetCanvasId,
      });
      channel?.postMessage({
        type: 'REASONING_EFFORT_CHANGED',
        reasoningEffort: effort === 'default' ? null : effort,
        targetCanvasId,
      });
    }

    renderAgentList();
  }

  // 绑定控件事件
  searchInput?.addEventListener('input', renderAgentList);
  btnRefresh?.addEventListener('click', loadAgents);

  return {
    renderAgentList,
    loadAgents,
    restoreAgent,
    getAgentReasoningEffort,
    setAgentReasoningEffort,
    getActiveAgentId: () => activeAgentId,
    getAgents: () => agents.slice(),
    getModels: () => models.slice(),
  };
}

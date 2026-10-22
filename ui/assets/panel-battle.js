/**
 * panel-battle.js
 * 多模型横向推导 / 对抗弹窗控制器与分支推导纯函数引擎
 */

/**
 * 校验对比推导输入合法性
 */
export function validateBattleInput({ prompt, selectedCount }) {
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmed) {
    return { ok: false, error: '请输入推导问题。' };
  }
  if (typeof selectedCount !== 'number' || selectedCount <= 0) {
    return { ok: false, error: '请至少选择一个对比助手。' };
  }
  return { ok: true, error: '' };
}

/**
 * 根据父卡片与选中的助手列表，构建多模型对比分支卡片数据
 */
export function buildBattleBranchCards({
  parentCard,
  selectedAgents = [],
  startBranchIndex = 1,
  targetX,
  yPositions = [],
  getReasoningEffort = () => null,
  uniqueId = (prefix) => `${prefix}-${Date.now().toString(36)}`,
}) {
  if (!parentCard || !Array.isArray(selectedAgents)) return [];

  return selectedAgents.map((agent, i) => {
    const branchIndex = startBranchIndex + i;
    const newId = uniqueId('battle_branch');
    const effort = getReasoningEffort(agent.id);
    const effortLabel = effort && effort !== 'default' ? ` · 思考 ${effort}` : '';

    return {
      id: newId,
      parentId: parentCard.id,
      isBattle: true,
      title: `对比 #${branchIndex} (${agent.name || agent.id}${effortLabel})`,
      x: targetX,
      y: yPositions[i] !== undefined ? yPositions[i] : (parentCard.y + i * 380),
      width: 340,
      messages: [],
    };
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 绑定对比推导弹窗控制器 (Battle Dialog Controller)
 */
export function bindBattleDialogController({
  dialog,
  promptInput,
  agentsList,
  selectedCountEl,
  errorEl,
  btnClose,
  btnCancel,
  btnSubmit,
  btnUseLastPrompt,
  loadAgents = async () => [],
  getReasoningEffort = () => null,
  onSubmit = () => {},
  listen,
  documentRef = typeof document !== 'undefined' ? document : null,
}) {
  let targetCard = null;
  const selectedAgentIds = new Set();
  const cleanups = [];
  const listCleanups = [];

  const addListener = (target, event, handler, options) => {
    if (!target) return;
    if (typeof listen === 'function') {
      cleanups.push(listen(target, event, handler, options));
    } else if (typeof target.addEventListener === 'function') {
      target.addEventListener(event, handler, options);
      cleanups.push(() => target.removeEventListener(event, handler, options));
    }
  };

  const updateSelectedCount = () => {
    if (selectedCountEl) {
      selectedCountEl.textContent = `已选 ${selectedAgentIds.size} 个`;
    }
  };

  const clearListCleanups = () => {
    while (listCleanups.length > 0) {
      const disposeFn = listCleanups.pop();
      try { disposeFn?.(); } catch {}
    }
  };

  const renderAgentsList = (agents) => {
    if (!agentsList) return;
    clearListCleanups();
    agentsList.innerHTML = '';

    agents.forEach((agent) => {
      const item = documentRef?.createElement?.('div') || { style: {}, classList: new Set() };
      const isChecked = selectedAgentIds.has(agent.id);
      item.className = `battle-agent-item ${isChecked ? 'is-selected' : ''}`;
      item.id = `battle-agent-${agent.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      const effort = getReasoningEffort(agent.id);
      const effortText = effort && effort !== 'default' ? `思考 ${effort}` : '默认思考';

      item.innerHTML = `
        <div class="battle-agent-item-left">
          <input type="checkbox" id="chk-battle-${agent.id.replace(/[^a-zA-Z0-9_-]/g, '_')}" ${isChecked ? 'checked' : ''} tabindex="-1">
          <span class="battle-agent-name">${escapeHtml(agent.name || agent.id)}</span>
        </div>
        <div class="battle-agent-item-right">
          <span class="battle-agent-model mono">${escapeHtml(agent.model || 'default')}</span>
          <span class="battle-agent-effort-badge mono">${escapeHtml(effortText)}</span>
        </div>
      `;

      const clickHandler = (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        const chk = item.querySelector?.('input[type="checkbox"]');
        const nowChecked = !selectedAgentIds.has(agent.id);
        if (nowChecked) {
          selectedAgentIds.add(agent.id);
        } else {
          selectedAgentIds.delete(agent.id);
        }
        if (chk) chk.checked = nowChecked;
        if (nowChecked) item.classList?.add?.('is-selected');
        else item.classList?.remove?.('is-selected');
        updateSelectedCount();
      };

      if (typeof listen === 'function') {
        listCleanups.push(listen(item, 'click', clickHandler));
      } else if (typeof item.addEventListener === 'function') {
        item.addEventListener('click', clickHandler);
        listCleanups.push(() => item.removeEventListener('click', clickHandler));
      }

      agentsList.appendChild(item);
    });
  };

  const close = () => {
    if (typeof dialog?.close === 'function') dialog.close();
    targetCard = null;
    clearListCleanups();
  };

  const open = async (card, initialPromptText = '') => {
    if (!card) return;
    targetCard = card;
    if (errorEl) errorEl.textContent = '';

    const lastUserMsg = card.messages?.filter(m => m.role === 'user' && !m.failed)?.at(-1)?.text || '';
    const prompt = (typeof initialPromptText === 'string' && initialPromptText.trim())
      ? initialPromptText.trim()
      : (card.draft || lastUserMsg);

    if (promptInput) {
      promptInput.value = prompt;
    }
    if (btnUseLastPrompt) {
      btnUseLastPrompt.onclick = () => {
        if (lastUserMsg && promptInput) promptInput.value = lastUserMsg;
      };
    }

    const agents = await loadAgents();
    selectedAgentIds.clear();

    if (agents.length <= 2) {
      agents.forEach(a => selectedAgentIds.add(a.id));
    } else {
      agents.slice(0, 2).forEach(a => selectedAgentIds.add(a.id));
    }

    renderAgentsList(agents);
    updateSelectedCount();

    if (typeof dialog?.showModal === 'function') {
      dialog.showModal();
      promptInput?.focus?.({ preventScroll: true });
    }
  };

  // 绑定关闭按钮与 cancel 事件
  if (btnClose) addListener(btnClose, 'click', close);
  if (btnCancel) addListener(btnCancel, 'click', close);
  if (dialog) {
    addListener(dialog, 'cancel', (e) => {
      e?.preventDefault?.();
      close();
    });
  }

  // 绑定提交按钮
  if (btnSubmit) {
    addListener(btnSubmit, 'click', async () => {
      const prompt = promptInput?.value?.trim() || '';
      const validation = validateBattleInput({ prompt, selectedCount: selectedAgentIds.size });

      if (!validation.ok) {
        if (errorEl) errorEl.textContent = validation.error;
        return;
      }
      if (errorEl) errorEl.textContent = '';

      const currentCard = targetCard;
      const selectedIds = new Set(selectedAgentIds);
      close();

      if (currentCard) {
        onSubmit({
          targetCard: currentCard,
          prompt,
          selectedAgentIds: selectedIds,
        });
      }
    });
  }

  return {
    open,
    close,
    getTargetCard: () => targetCard,
    getSelectedAgentIds: () => selectedAgentIds,
    cleanup: () => {
      while (cleanups.length > 0) {
        const disposeFn = cleanups.pop();
        try { disposeFn?.(); } catch {}
      }
      clearListCleanups();
      targetCard = null;
    },
  };
}

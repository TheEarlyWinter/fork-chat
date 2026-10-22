import { hana } from './sdk.js';
import { safeDetail, requestHost } from './host-api.js';
import { runChat, ChatError } from './chat-client.js';
import { parseAssistantOutput } from './assistant-output.js';
import { createForkSessionStore } from './fork-session-store.js';
import { createForkSessionController } from './fork-session-controller.js';
import { readRenameIntent, clearRenameIntent } from './fork-session-commands.js';

const activeRequests = new Map();
let sessionController = null;
let deleteIntent = null, deleteInProgress = false;
const activeRenameCommands = new Set();
const canvasId = uniqueId('canvas');
function uniqueId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
function chainIsBusy(card) {
  if (!sessionController?.state.ready || sessionController.state.busy) return true;
  const seen = new Set();
  while (card && !seen.has(card.id)) {
    seen.add(card.id);
    if (activeRequests.has(card.id)) return true;
    card = cards.find(parent => parent.id === card.parentId);
  }
  return false;
}
function statusText(message) {
  if (!message.requestId) return '';
  const labels = { waiting: message.waitingLong ? '仍在等待模型响应，可取消' : '等待模型响应…', generating: '生成中…', completed: '已完成', cancelled: '已停止接收', failed: '失败' };
  const error = message.error ? ` · ${message.error}` : '';
  const cancellation = message.cancelConfirmed === false && ['cancelled', 'failed'].includes(message.status) ? ` · 服务端取消未确认${message.cancelError ? `：${message.cancelError}` : ''}` : '';
  return `${labels[message.status] || '等待'}${error}${cancellation} · ${message.requestId}${message.modelRef ? ` · ${message.modelRef}` : ''}`;
}
// message.text remains the raw model reply, including explicit mood tags.
// Presentation is a projection only: never execute generated HTML or rewrite personas.
function outputFor(message) {
  return message.role === 'assistant' && !message.localOnly
    ? parseAssistantOutput(message.text || '', { streaming: Boolean(message.streaming) })
    : { body: message.text || '', blocks: [] };
}
function asidesText(output, message) {
  return output.blocks.map(block => {
    const label = { mood: '心境', pulse: '心绪', reflect: '沉思' }[block.type] || '心境';
    const state = block.closed ? '' : message.streaming ? ' · 生成中' : ' · 未闭合';
    return `${label}${state}\n${block.text}`;
  }).join('\n\n');
}
function messageMarkup(message) {
  const output = outputFor(message);
  const replyId = message.requestId ? `id="reply-${message.requestId}"` : '';
  const bubble = `<div class="msg-bubble" ${replyId} ${output.body.trim() ? '' : 'hidden'}>${escapeHtml(output.body)}</div>`;
  const docPreviewHtml = message.docPreview ? `
    <details class="doc-content-preview">
      <summary>查看文档内容提取预览 (${message.docMeta?.lineCount || 0} 行 · ${message.docMeta?.charCount || 0} 字)</summary>
      <pre class="doc-content-body">${escapeHtml(message.docPreview)}</pre>
    </details>
  ` : '';
  const attachmentsHtml = Array.isArray(message.attachments) && message.attachments.length > 0 ? `
    <div class="msg-attachments-list">
      ${message.attachments.map(att => `
        <details class="msg-attachment-item">
          <summary class="msg-attachment-header">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            <span class="msg-attachment-name">${escapeHtml(att.name)}</span>
            <span class="msg-attachment-meta">${formatFileSize(att.size)} · ${att.charCount || 0} 字</span>
          </summary>
          <pre class="msg-attachment-preview">${escapeHtml(att.preview || att.content?.slice(0, 1500) || '')}</pre>
        </details>
      `).join('')}
    </div>
  ` : '';
  if (!message.requestId || message.role !== 'assistant') return `${attachmentsHtml}${bubble}${docPreviewHtml}`;
  return `${attachmentsHtml}${bubble}${docPreviewHtml}
    <details class="assistant-asides" id="asides-${message.requestId}" ${message.asidesOpen ? 'open' : ''} ${output.blocks.length ? '' : 'hidden'}>
      <summary id="asides-toggle-${message.requestId}">心境 / 沉思</summary>
      <div class="assistant-asides-text" id="asides-text-${message.requestId}">${escapeHtml(asidesText(output, message))}</div>
    </details>`;
}
function paintMessage(message) {
  const output = outputFor(message);
  const bubble = document.getElementById(`reply-${message.requestId}`);
  if (bubble) { bubble.textContent = output.body; bubble.hidden = !output.body.trim(); }
  const asides = document.getElementById(`asides-${message.requestId}`);
  if (asides) asides.hidden = output.blocks.length === 0;
  const asideText = document.getElementById(`asides-text-${message.requestId}`);
  if (asideText) asideText.textContent = asidesText(output, message);
  const status = document.getElementById(`status-${message.requestId}`);
  if (status) status.textContent = statusText(message);
}

// 画布视图状态
const view = {
  x: 60,
  y: 40,
  scale: 1,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
};

// Each App session starts with its own independent canvas.
function initialCards() { return [
  {
    id: 'card-1',
    parentId: null,
    title: '主线对话 #01',
    x: 80,
    y: 80,
    width: 340,
    messages: [
      {
        role: 'assistant',
        localOnly: true,
        text: '你好！这里是你的第一张对话卡片。\n\n在下方输入框打入你想聊的内容开启主线；随时点击卡片右侧的 [+] 按钮，即可开辟一条独立的追问分支。'
      }
    ]
  }
]; }
let cards = initialCards();

// DOM 元素引用
const viewport = document.getElementById('viewport');
const surface = document.getElementById('surface');
const connectorsSvg = document.getElementById('connectors-svg');
const cardsLayer = document.getElementById('cards-layer');
const badgeStats = document.getElementById('badge-stats');
const activeAgentDisplay = document.getElementById('active-agent-display');
const zoomText = document.getElementById('zoom-text');
const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnResetView = document.getElementById('btn-reset-view');
const btnAutoTidy = document.getElementById('btn-auto-tidy');
const btnNewRoot = document.getElementById('btn-new-root');
const btnImportDoc = document.getElementById('btn-import-doc');
const globalDocInput = document.getElementById('global-doc-input');
const canvasDropIndicator = document.getElementById('canvas-drop-indicator');
const sessionStatusEl = document.getElementById('session-status');
const btnRetrySave = document.getElementById('btn-retry-save');
const btnSaveCopy = document.getElementById('btn-save-copy');
const deleteDialog = document.getElementById('delete-session-dialog');
const deleteTargetTitle = document.getElementById('delete-target-title');
const deleteDialogError = document.getElementById('delete-dialog-error');
const deleteDialogProgress = document.getElementById('delete-dialog-progress');
const btnDeleteConfirm = document.getElementById('btn-delete-confirm');
const btnDeleteCancel = document.getElementById('btn-delete-cancel');

// 多模型横向推导 (Battle) 对话框元素
const battleDialog = document.getElementById('battle-dialog');
const battlePromptInput = document.getElementById('battle-prompt-input');
const battleAgentsList = document.getElementById('battle-agents-list');
const battleSelectedCount = document.getElementById('battle-selected-count');
const battleDialogError = document.getElementById('battle-dialog-error');
const btnBattleClose = document.getElementById('btn-battle-close');
const btnBattleCancel = document.getElementById('btn-battle-cancel');
const btnBattleSubmit = document.getElementById('btn-battle-submit');
const btnUseLastPrompt = document.getElementById('btn-use-last-prompt');

// 多选与合并收敛 (Merge) 元素
const mergeToolbar = document.getElementById('merge-toolbar');
const mergeCountText = document.getElementById('merge-count-text');
const btnMergeSubmit = document.getElementById('btn-merge-submit');
const btnMergeCancel = document.getElementById('btn-merge-cancel');
const multiSelectedCardIds = new Set();

let battleTargetCard = null;
const battleSelectedAgentIds = new Set();

// 跨窗口同步助手与模型状态
const bus = new BroadcastChannel('fork-chat-bus');
let currentAgent = {
  id: localStorage.getItem('fork_chat_active_agent_id') || 'hakimi',
  name: localStorage.getItem('fork_chat_active_agent_name') || 'Hakimi',
  model: localStorage.getItem('fork_chat_active_agent_model') || 'gemini-3.8-flash-high',
  provider: localStorage.getItem('fork_chat_active_agent_provider') || 'gemini'
};
let currentReasoningEffort = (() => {
  try {
    const val = localStorage.getItem('fork_chat_reasoning_effort');
    return val && val !== 'default' ? val : null;
  } catch {
    return null;
  }
})();

function updateHeaderStatus() {
  if (activeAgentDisplay) {
    activeAgentDisplay.textContent = `当前助手: ${currentAgent.name} [${currentAgent.model || 'default'}]`;
  }
}
updateHeaderStatus();

bus.onmessage = (e) => {
  const message = e.data;
  if (message?.targetCanvasId && message.targetCanvasId !== canvasId) return;
  if (message?.type === 'FORK_SESSION_HELLO') {
    publishSessionState(message.panelId);
    return;
  }
  if (e.data?.type === 'REASONING_EFFORT_CHANGED') {
    currentReasoningEffort = e.data.reasoningEffort || null;
    try {
      localStorage.setItem('fork_chat_reasoning_effort', currentReasoningEffort || 'default');
    } catch {}
    sessionController?.scheduleSave();
    return;
  }
  if (message?.type === 'FORK_SESSION_COMMAND') {
    if (message.targetCanvasId !== canvasId || !sessionController) return;
    if (deleteIntent) { replySessionCommand(message, { ok: false, error: '请先处理当前删除确认。' }); return; }
    if (message.command === 'rename') { void renameSessionFromIntent(message); return; }
    if (message.command === 'delete') { void openDeleteConfirmation(message); return; }
    const operation = message.command === 'new' ? sessionController.newSession(initialSnapshot())
      : message.command === 'switch' ? sessionController.switchTo(message.sessionId)
      : sessionController.state.ready ? sessionController.refresh() : sessionController.init();
    void operation.catch(() => {});
    return;
  }
  if (e.data?.type === 'AGENT_CHANGED' && e.data.agent) {
    if (sessionController?.state.busy || deleteIntent) { publishSessionState(); return; }
    currentAgent = { ...currentAgent, ...e.data.agent };
    if (e.data.reasoningEffort !== undefined) {
      currentReasoningEffort = e.data.reasoningEffort || null;
      try { localStorage.setItem('fork_chat_reasoning_effort', currentReasoningEffort || 'default'); } catch {}
    }
    for (const [key, value] of Object.entries({ id: currentAgent.id, name: currentAgent.name, model: currentAgent.model, provider: currentAgent.provider })) {
      try { localStorage.setItem(`fork_chat_active_agent_${key}`, value || ''); } catch {}
    }
    updateHeaderStatus();
    renderCards();
    sessionController?.scheduleSave();
  } else if (e.data?.type === 'MODEL_CHANGED' && e.data.model) {
    updateHeaderStatus();
  }
};

// 更新画布平移与缩放矩阵
function updateTransform() {
  surface.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomText.textContent = `${Math.round(view.scale * 100)}%`;
  sessionController?.scheduleSave();
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  viewport.style.backgroundSize = `${24 * view.scale}px ${24 * view.scale}px`;
}

// 绘制所有卡片之间的贝塞尔曲线（支持单亲与多亲收敛节点）
function renderConnectors() {
  connectorsSvg.innerHTML = '';

  cards.forEach(child => {
    const parentIds = Array.isArray(child.parentIds) && child.parentIds.length > 0
      ? child.parentIds
      : (child.parentId ? [child.parentId] : []);

    if (parentIds.length === 0) return;

    parentIds.forEach((pId, pIndex) => {
      const parent = cards.find(c => c.id === pId);
      if (!parent) return;

      const siblings = cards.filter(c => c.parentId === parent.id || (Array.isArray(c.parentIds) && c.parentIds.includes(parent.id)));
      const sibIndex = siblings.indexOf(child);
      const sibCount = siblings.length;
      // 多分支子卡片在起点微调 Y 锚点错位，形成规整线束扇出效果
      const startOffsetY = sibCount > 1
        ? 110 + (sibIndex - (sibCount - 1) / 2) * 12
        : 110;

      // 起点：父卡片右侧边缘锚点
      const startX = parent.x + parent.width;
      const startY = parent.y + startOffsetY;

      // 终点：子卡片左侧中点（多亲合流汇入时也按线束微调终点 Y 锚点）
      const endOffsetY = parentIds.length > 1
        ? 110 + (pIndex - (parentIds.length - 1) / 2) * 14
        : 110;
      const endX = child.x;
      const endY = child.y + endOffsetY;

      const deltaX = Math.abs(endX - startX) * 0.55;

      // 平滑贝塞尔曲线
      const d = `M ${startX} ${startY} C ${startX + deltaX} ${startY}, ${endX - deltaX} ${endY}, ${endX} ${endY}`;

      // 背景粗边描边
      const pathBg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathBg.setAttribute('d', d);
      pathBg.setAttribute('fill', 'none');
      pathBg.setAttribute('stroke', '#ffffff');
      pathBg.setAttribute('stroke-width', '5');
      connectorsSvg.appendChild(pathBg);

      // 主连线
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#18181b');
      path.setAttribute('stroke-width', '1.8');
      connectorsSvg.appendChild(path);

      // 终点小微圆环
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', endX);
      circle.setAttribute('cy', endY);
      circle.setAttribute('r', '3');
      circle.setAttribute('fill', '#18181b');
      connectorsSvg.appendChild(circle);
    });
  });
}

// 读取指定助手独立配置的思考深度
function getAgentReasoningEffort(agentId) {
  if (!agentId) return null;
  try {
    const val = localStorage.getItem(`fork_chat_agent_effort_${agentId}`);
    return val && val !== 'default' ? val : null;
  } catch {
    return null;
  }
}

// 缓存系统可用助手列表
let cachedAgents = [];
let agentsLoadingPromise = null;
async function loadAvailableAgents() {
  if (cachedAgents.length > 0) return cachedAgents;
  if (agentsLoadingPromise) return agentsLoadingPromise;
  agentsLoadingPromise = (async () => {
    try {
      const res = await requestHost(hana, '/api/agents');
      const data = await res.json();
      if (Array.isArray(data?.agents)) {
        cachedAgents = data.agents;
      }
    } catch {
      cachedAgents = [currentAgent];
    } finally {
      agentsLoadingPromise = null;
    }
    return cachedAgents;
  })();
  return agentsLoadingPromise;
}

// 向上递归回溯祖先节点，拼装从根节点到当前节点的完整上下文链路
function buildChainContext(targetCard) {
  const chain = [];
  let curr = targetCard;
  const seen = new Set();
  while (curr && !seen.has(curr.id)) {
    seen.add(curr.id);
    chain.unshift(curr);
    curr = cards.find(c => c.id === curr.parentId);
  }
  const msgs = [];
  chain.forEach(c => {
    if (c.isDoc && c.docContent) {
      msgs.push({
        role: 'user',
        content: `【前置参考资料：《${c.title}》】\n${c.docContent}`,
      });
      msgs.push({
        role: 'assistant',
        content: `已阅读并完全解析前置资料《${c.title}》。将以此文档为事实基座回答后续分析推导。`,
      });
    }
    c.messages.forEach(m => {
      if (!m.text && (!m.attachments || m.attachments.length === 0)) return;
      if (m.localOnly || m.streaming || m.failed || (m.status && m.status !== 'completed')) return;

      let content = outputFor(m).body;
      if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length > 0) {
        const attSections = m.attachments.map(att =>
          `【附件资料：《${att.name}》】\n${att.content || ''}`
        ).join('\n\n');
        content = attSections ? `${attSections}\n\n${content}` : content;
      }

      msgs.push({
        role: m.role,
        content,
      });
    });
  });
  return msgs;
}

// 通用卡片流式推导发送引擎（支持单卡发送与多模型横向并发推导）
async function sendCardPrompt(card, text, options = {}) {
  if (chainIsBusy(card) || !cards.includes(card)) return;
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const attachments = Array.isArray(options.attachments) && options.attachments.length > 0 ? options.attachments : undefined;
  if (!trimmed && !attachments) return;

  const userMsg = {
    role: 'user',
    text: trimmed || (attachments ? `[已附带 ${attachments.length} 份文档资料]` : ''),
    ...(attachments ? { attachments } : {}),
  };
  card.messages.push(userMsg);

  // 祖先链路完整上下文
  const contextMessages = buildChainContext(card);

  // 新增 assistant 占位消息并进入流式态
  const requestId = uniqueId('req');
  const requestGeneration = sessionController.generation;
  const targetAgent = options.agent ? { ...options.agent } : { ...currentAgent };
  const targetEffort = options.reasoningEffort !== undefined
    ? options.reasoningEffort
    : (getAgentReasoningEffort(targetAgent.id) || currentReasoningEffort || null);

  const asstMsg = {
    role: 'assistant',
    agentId: targetAgent.id,
    agentName: targetAgent.name || 'Assistant',
    requestId,
    text: '',
    status: 'waiting',
    streaming: true,
  };
  const active = { requestId, controller: new AbortController(), message: asstMsg, terminalSeen: false };
  activeRequests.set(card.id, active);
  card.messages.push(asstMsg);
  card.scrollToEnd = true;
  renderCards();
  sessionController.scheduleSave();

  try {
    const result = await runChat(hana, {
      requestId,
      cardId: card.id,
      agentId: targetAgent.id,
      modelRef: targetAgent.provider && targetAgent.model ? `${targetAgent.provider}/${targetAgent.model}` : targetAgent.model,
      messages: contextMessages,
      ...(targetEffort && targetEffort !== 'default' ? { reasoningEffort: targetEffort } : {}),
    }, {
      signal: active.controller.signal,
      onWaiting() {
        if (sessionController.generation === requestGeneration) {
          asstMsg.waitingLong = true;
          paintMessage(asstMsg);
        }
      },
      onCancelResult(confirmed, detail) {
        if (sessionController.generation !== requestGeneration) return;
        asstMsg.cancelConfirmed = confirmed;
        asstMsg.cancelError = detail;
        paintMessage(asstMsg);
      },
      onEvent(event) {
        if (sessionController.generation !== requestGeneration || activeRequests.get(card.id) !== active || !cards.includes(card)) return;
        if (event.type === 'start') {
          const effortTag = event.reasoningEffort ? ` · 思考 ${event.reasoningEffort}` : '';
          asstMsg.modelRef = `${event.provider}/${event.model}${effortTag}`;
        }
        if (event.type === 'text-delta') {
          asstMsg.text += event.delta;
          if (event.delta) asstMsg.status = 'generating';
        }
        if (['done', 'error', 'cancelled'].includes(event.type)) active.terminalSeen = true;
        paintMessage(asstMsg);
        sessionController.scheduleSave();
        const body = document.getElementById(`body-${card.id}`);
        if (body) body.scrollTop = body.scrollHeight;
      },
    });
    if (sessionController.generation !== requestGeneration) return;
    asstMsg.text = result.text;
    if (!parseAssistantOutput(result.text).body.trim()) {
      throw new ChatError('EMPTY_BODY', '模型仅返回心境或沉思，未返回正文。');
    }
    asstMsg.status = 'completed';
  } catch (error) {
    if (sessionController.generation !== requestGeneration) return;
    const parsed = parseAssistantOutput(asstMsg.text || '');
    const isHostConverterError = (error.message && error.message.includes('The model provider could not complete the request'))
      || error.code === 'APP_MODEL_PROVIDER_ERROR';

    // 关键容错：若上游已成功吐出有效正文，但在终态由于宿主校验空思考签名报错，
    // 平滑判定为已完成，允许继续正常分支追问，绝不把可用回答直接作废！
    if (parsed.body.trim() && isHostConverterError && error.code !== 'REQUEST_CANCELLED') {
      asstMsg.failed = false;
      asstMsg.status = 'completed';
      asstMsg.error = '';
    } else {
      asstMsg.failed = true;
      asstMsg.status = error.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed';
      asstMsg.error = safeDetail(`${error.code || 'REQUEST_FAILED'}: ${error.message}`);
    }
  } finally {
    asstMsg.streaming = false;
    if (activeRequests.get(card.id) === active) activeRequests.delete(card.id);
    if (sessionController.generation === requestGeneration && cards.includes(card)) {
      card.scrollToEnd = true;
      renderCards();
      sessionController.scheduleSave();
    }
  }
}

function updateBattleSelectedCount() {
  if (battleSelectedCount) {
    battleSelectedCount.textContent = `已选 ${battleSelectedAgentIds.size} 个`;
  }
}

function renderBattleAgentsList(agents) {
  if (!battleAgentsList) return;
  battleAgentsList.innerHTML = '';

  agents.forEach(agent => {
    const item = document.createElement('div');
    const isChecked = battleSelectedAgentIds.has(agent.id);
    item.className = `battle-agent-item ${isChecked ? 'is-selected' : ''}`;
    item.id = `battle-agent-${agent.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    const effort = getAgentReasoningEffort(agent.id);
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

    item.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      const chk = item.querySelector('input[type="checkbox"]');
      const nowChecked = !battleSelectedAgentIds.has(agent.id);
      if (nowChecked) {
        battleSelectedAgentIds.add(agent.id);
      } else {
        battleSelectedAgentIds.delete(agent.id);
      }
      if (chk) chk.checked = nowChecked;
      if (nowChecked) item.classList.add('is-selected');
      else item.classList.remove('is-selected');
      updateBattleSelectedCount();
    });

    battleAgentsList.appendChild(item);
  });
}

function closeBattleDialog() {
  if (typeof battleDialog?.close === 'function') battleDialog.close();
  battleTargetCard = null;
}

async function openBattleDialog(card, initialPromptText = '') {
  if (chainIsBusy(card) || !cards.includes(card)) return;
  battleTargetCard = card;
  if (battleDialogError) battleDialogError.textContent = '';

  const lastUserMsg = card.messages.filter(m => m.role === 'user' && !m.failed).at(-1)?.text || '';
  const prompt = (typeof initialPromptText === 'string' && initialPromptText.trim())
    ? initialPromptText.trim()
    : (card.draft || lastUserMsg);

  if (battlePromptInput) {
    battlePromptInput.value = prompt;
  }
  if (btnUseLastPrompt) {
    btnUseLastPrompt.onclick = () => {
      if (lastUserMsg && battlePromptInput) battlePromptInput.value = lastUserMsg;
    };
  }

  const agents = await loadAvailableAgents();
  battleSelectedAgentIds.clear();

  if (agents.length <= 2) {
    agents.forEach(a => battleSelectedAgentIds.add(a.id));
  } else {
    agents.slice(0, 2).forEach(a => battleSelectedAgentIds.add(a.id));
  }

  renderBattleAgentsList(agents);
  updateBattleSelectedCount();

  if (typeof battleDialog?.showModal === 'function') {
    battleDialog.showModal();
    battlePromptInput?.focus?.({ preventScroll: true });
  }
}

function fitViewportToCluster(clusterCards) {
  if (!clusterCards || clusterCards.length === 0) return;
  const minX = Math.min(...clusterCards.map(c => c.x));
  const maxX = Math.max(...clusterCards.map(c => c.x + (c.width || 340)));
  const minY = Math.min(...clusterCards.map(c => c.y));
  const maxY = Math.max(...clusterCards.map(c => c.y + 360));

  const padX = 80;
  const padY = 80;
  const clusterWidth = (maxX - minX) + padX * 2;
  const clusterHeight = (maxY - minY) + padY * 2;

  const vpRect = viewport?.getBoundingClientRect?.() || { width: 1000, height: 700 };
  const vpWidth = vpRect.width || 1000;
  const vpHeight = vpRect.height || 700;

  const targetScale = Math.min(1.0, Math.max(0.45, Math.min(vpWidth / clusterWidth, vpHeight / clusterHeight)));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  view.scale = Number(targetScale.toFixed(2));
  view.x = Math.round(vpWidth / 2 - centerX * view.scale);
  view.y = Math.round(vpHeight / 2 - centerY * view.scale);
  updateTransform();
}

function calculateBranchYPositions(parentCard, count, targetX) {
  const step = 380;
  const totalSpan = (count - 1) * step;
  const idealStartY = Math.round(parentCard.y - (totalSpan / 2));
  const candidateYs = Array.from({ length: count }, (_, i) => idealStartY + i * step);

  const existingInColumn = cards.filter(c => c.id !== parentCard.id && Math.abs(c.x - targetX) < 120);
  if (existingInColumn.length === 0) {
    return candidateYs;
  }

  // 检测理想排布是否与现有卡片发生重叠（间距小于 320px 视为重叠）
  const hasCollision = candidateYs.some(y => existingInColumn.some(c => Math.abs(c.y - y) < 320));
  if (!hasCollision) {
    return candidateYs;
  }

  // 发生碰撞，向下平移至已有列的最底端之后
  const maxY = Math.max(...existingInColumn.map(c => c.y));
  const safeStartY = maxY + step;
  return Array.from({ length: count }, (_, i) => safeStartY + i * step);
}

async function runBattleBranches(parentCard, prompt, selectedAgents) {
  if (!parentCard || !cards.includes(parentCard) || chainIsBusy(parentCard)) return;
  const existingChildren = cards.filter(c => c.parentId === parentCard.id);
  const startBranchIndex = existingChildren.length + 1;
  const total = selectedAgents.length;
  const targetX = parentCard.x + (parentCard.width || 340) + 120;
  const yPositions = calculateBranchYPositions(parentCard, total, targetX);

  const newCards = [];
  selectedAgents.forEach((agent, i) => {
    const branchIndex = startBranchIndex + i;
    const newId = uniqueId('battle_branch');
    const effort = getAgentReasoningEffort(agent.id);
    const effortLabel = effort && effort !== 'default' ? ` · 思考 ${effort}` : '';

    const childCard = {
      id: newId,
      parentId: parentCard.id,
      isBattle: true,
      title: `对比 #${branchIndex} (${agent.name || agent.id}${effortLabel})`,
      x: targetX,
      y: yPositions[i],
      width: 340,
      messages: [],
    };
    newCards.push(childCard);
    cards.push(childCard);
  });

  renderCards();
  sessionController.scheduleSave();

  if (newCards.length > 0) {
    fitViewportToCluster([parentCard, ...newCards]);
  }

  const sendPromises = newCards.map((childCard, i) => {
    const agent = selectedAgents[i];
    const effort = getAgentReasoningEffort(agent.id);
    return sendCardPrompt(childCard, prompt, { agent, reasoningEffort: effort });
  });

  await Promise.allSettled(sendPromises);
}

function toggleMultiSelectCard(cardId) {
  if (multiSelectedCardIds.has(cardId)) {
    multiSelectedCardIds.delete(cardId);
  } else {
    if (multiSelectedCardIds.size === 0 && selectedCardId && selectedCardId !== cardId) {
      multiSelectedCardIds.add(selectedCardId);
    }
    multiSelectedCardIds.add(cardId);
  }
  updateMultiSelectionUI();
}

function clearMultiSelect() {
  if (multiSelectedCardIds.size === 0) return;
  multiSelectedCardIds.clear();
  updateMultiSelectionUI();
}

function updateMultiSelectionUI() {
  cards.forEach(c => {
    const el = document.getElementById(`dom-${c.id}`);
    if (el) {
      if (multiSelectedCardIds.has(c.id)) {
        el.classList.add('is-multi-selected');
      } else {
        el.classList.remove('is-multi-selected');
      }
    }
  });

  if (multiSelectedCardIds.size >= 2) {
    if (mergeToolbar) mergeToolbar.hidden = false;
    if (mergeCountText) mergeCountText.textContent = `已选 ${multiSelectedCardIds.size} 个分支`;
  } else {
    if (mergeToolbar) mergeToolbar.hidden = true;
  }
}

function synthesizeMergePrompt(selectedCards) {
  const branchSummaries = selectedCards.map((card, idx) => {
    const userMsg = card.messages.filter(m => m.role === 'user' && !m.failed).at(-1);
    const asstMsg = card.messages.filter(m => m.role === 'assistant' && !m.localOnly && !m.failed && (!m.status || m.status === 'completed')).at(-1);

    const questionText = userMsg?.content || userMsg?.text || '（沿用前置主题）';
    const answerText = asstMsg ? (outputFor(asstMsg).body.trim() || asstMsg.text) : '（尚无推导结论）';
    const truncatedAnswer = answerText.length > 600 ? answerText.slice(0, 600) + '… [已截断核心]' : answerText;

    return `### 分支 #${idx + 1}：${card.title}\n- **探讨问题**：${questionText}\n- **推导结论要点**：\n${truncatedAnswer}`;
  }).join('\n\n');

  return `你现在作为首席架构裁判与决策顾问，请对以下 ${selectedCards.length} 个独立探索分支的推导结论进行深度交叉对比与合流收敛：\n\n${branchSummaries}\n\n---\n【合流裁决任务】：\n1. **核心共识与关键分歧**：提炼各个分支方案的交集共识与核心分歧点；\n2. **适用边界与权衡代价 (Trade-offs)**：客观剖析各方案在性能、复杂度、可靠性及维护成本上的利弊得失；\n3. **终局综合决策方案**：给出最终的落地裁决意见与明确的执行路线。`;
}

async function createMergeCardFromSelected() {
  const selectedCards = cards.filter(c => multiSelectedCardIds.has(c.id));
  if (selectedCards.length < 2) return null;

  const maxX = Math.max(...selectedCards.map(c => c.x + (c.width || 340)));
  const targetX = maxX + 140;
  const avgY = Math.round(selectedCards.reduce((acc, c) => acc + c.y, 0) / selectedCards.length);
  const targetY = calculateBranchYPositions({ x: maxX, y: avgY, width: 0 }, 1, targetX)[0];

  const newId = uniqueId('merge_node');
  const sourceTitles = selectedCards.map(c => c.title.split(' ')[0]).join(' + ');

  const mergeCard = {
    id: newId,
    parentId: selectedCards[0].id,
    parentIds: selectedCards.map(c => c.id),
    isMerge: true,
    title: `合并总结 (${sourceTitles})`,
    x: targetX,
    y: targetY,
    width: 360,
    messages: [],
  };

  cards.push(mergeCard);
  clearMultiSelect();
  renderCards();
  sessionController?.scheduleSave();

  fitViewportToCluster([...selectedCards, mergeCard]);

  const prompt = synthesizeMergePrompt(selectedCards);
  void sendCardPrompt(mergeCard, prompt);
  return mergeCard;
}

let selectedCardId = null;
let isSpacePressed = false;

function selectCard(cardId, focusInput = false) {
  selectedCardId = cardId;
  cards.forEach(c => {
    const el = document.getElementById(`dom-${c.id}`);
    if (el) {
      if (c.id === cardId) el.classList.add('is-selected-card');
      else el.classList.remove('is-selected-card');
    }
  });
  if (cardId && focusInput) {
    const inputEl = document.getElementById(`input-${cardId}`);
    inputEl?.focus?.({ preventScroll: true });
  }
}

function ensureCardInView(card) {
  const vpRect = viewport?.getBoundingClientRect?.() || { width: 1000, height: 700 };
  const vpWidth = vpRect.width || 1000;
  const vpHeight = vpRect.height || 700;

  const screenX = card.x * view.scale + view.x;
  const screenY = card.y * view.scale + view.y;
  const cardScreenWidth = (card.width || 340) * view.scale;
  const cardScreenHeight = 360 * view.scale;

  const margin = 60;
  let adjust = false;
  if (screenX < margin) {
    view.x += (margin - screenX);
    adjust = true;
  } else if (screenX + cardScreenWidth > vpWidth - margin) {
    view.x -= (screenX + cardScreenWidth - (vpWidth - margin));
    adjust = true;
  }
  if (screenY < margin) {
    view.y += (margin - screenY);
    adjust = true;
  } else if (screenY + cardScreenHeight > vpHeight - margin) {
    view.y -= (screenY + cardScreenHeight - (vpHeight - margin));
    adjust = true;
  }
  if (adjust) updateTransform();
}

function focusCardInViewport(card) {
  if (!card) return;
  const vpRect = viewport?.getBoundingClientRect?.() || { width: 1000, height: 700 };
  const vpWidth = vpRect.width || 1000;
  const vpHeight = vpRect.height || 700;
  const cardW = card.width || 360;
  const cardH = 340;

  view.x = Math.round(vpWidth / 2 - (card.x + cardW / 2) * view.scale);
  view.y = Math.round(vpHeight / 2 - (card.y + cardH / 2) * view.scale);
  updateTransform();

  const el = document.getElementById(`dom-${card.id}`);
  if (el) {
    el.classList.add('is-imported-pulse');
    setTimeout(() => {
      el.classList.remove('is-imported-pulse');
    }, 2000);
  }
}

function navigateCardFocus(direction) {
  const current = cards.find(c => c.id === selectedCardId) || cards[0];
  if (!current) return;

  let target = null;
  if (direction === 'ArrowRight') {
    const children = cards.filter(c => c.parentId === current.id);
    if (children.length > 0) target = children[0];
  } else if (direction === 'ArrowLeft') {
    if (current.parentId) {
      target = cards.find(c => c.id === current.parentId);
    }
  } else if (direction === 'ArrowDown') {
    if (current.parentId) {
      const siblings = cards.filter(c => c.parentId === current.parentId);
      const idx = siblings.findIndex(c => c.id === current.id);
      if (idx !== -1 && idx < siblings.length - 1) target = siblings[idx + 1];
    } else {
      const roots = cards.filter(c => !c.parentId);
      const idx = roots.findIndex(c => c.id === current.id);
      if (idx !== -1 && idx < roots.length - 1) target = roots[idx + 1];
    }
  } else if (direction === 'ArrowUp') {
    if (current.parentId) {
      const siblings = cards.filter(c => c.parentId === current.parentId);
      const idx = siblings.findIndex(c => c.id === current.id);
      if (idx > 0) target = siblings[idx - 1];
    } else {
      const roots = cards.filter(c => !c.parentId);
      const idx = roots.findIndex(c => c.id === current.id);
      if (idx > 0) target = roots[idx - 1];
    }
  }

  if (target) {
    selectCard(target.id, false);
    ensureCardInView(target);
  }
}

function createBranchCard(card, { autoFocus = true } = {}) {
  if (chainIsBusy(card) || !cards.includes(card)) return null;
  const existingChildren = cards.filter(c => c.parentId === card.id);
  const branchIndex = existingChildren.length + 1;
  const newId = uniqueId('branch');

  const lastMessage = card.messages.filter(message => !message.failed && !message.localOnly && (!message.status || message.status === 'completed')).at(-1);
  const lastMsg = lastMessage ? outputFor(lastMessage).body.trim() || '父级卡片' : '父级卡片';
  const snippet = lastMsg.length > 20 ? lastMsg.slice(0, 20) + '...' : lastMsg;

  const targetX = card.x + (card.width || 340) + 120;
  const yPositions = calculateBranchYPositions(card, 1, targetX);

  const isDocParent = Boolean(card.isDoc);
  const branchTitle = isDocParent
    ? `分析 #${branchIndex} (${card.title.slice(0, 10)})`
    : `追问 #${branchIndex} (${card.title.split(' ')[0]})`;

  const initText = isDocParent
    ? `【承袭前置资料】\n已承袭《${card.title}》（${formatFileSize(card.docMeta?.size || 0)}）作为推导背景。\n你可以在此提出专项分析问题，绝不污染源文档。`
    : `【承袭前置上下文】\n已从「${card.title}」成功拉出新分支。\n前置结论锚点：“${snippet}”\n你可以在此提出分支问题，绝不污染父卡片。`;

  const newCard = {
    id: newId,
    parentId: card.id,
    title: branchTitle,
    x: targetX,
    y: yPositions[0],
    width: 340,
    messages: [
      {
        role: 'assistant',
        localOnly: true,
        text: initText,
      }
    ]
  };

  cards.push(newCard);
  renderCards();
  sessionController.scheduleSave();

  selectCard(newCard.id, autoFocus);
  view.x = -newCard.x + 300;
  view.y = -newCard.y + 140;
  updateTransform();

  return newCard;
}

function closeCardHierarchy(card) {
  if (!sessionController?.state.ready || sessionController.state.busy) return;
  const idsToDelete = new Set([card.id]);
  let changed = true;
  while (changed) {
    changed = false;
    cards.forEach(c => {
      if (c.parentId && idsToDelete.has(c.parentId) && !idsToDelete.has(c.id)) {
        idsToDelete.add(c.id);
        changed = true;
      }
    });
  }
  for (const id of idsToDelete) activeRequests.get(id)?.controller.abort(new ChatError('REQUEST_CANCELLED', '卡片已关闭。'));
  cards = cards.filter(c => !idsToDelete.has(c.id));
  if (selectedCardId && idsToDelete.has(selectedCardId)) {
    selectedCardId = null;
  }
  renderCards();
  sessionController.scheduleSave();
}

// 渲染所有卡片
function renderCards(preserve = true) {
  // Never copy the previous session's DOM state into a newly loaded canvas.
  if (preserve) {
  for (const input of cardsLayer.querySelectorAll?.('.card-input') || []) {
    const card = cards.find(item => `input-${item.id}` === input.id);
    if (card) card.draft = input.value;
  }
  for (const card of cards) {
    const body = document.getElementById(`body-${card.id}`);
    if (typeof body?.scrollTop === 'number') card.savedScrollTop = body.scrollTop;
    for (const message of card.messages) {
      if (!message.requestId) continue;
      const asides = document.getElementById(`asides-${message.requestId}`);
      if (typeof asides?.open === 'boolean') message.asidesOpen = asides.open;
    }
  }
  }
  const focused = preserve ? document.activeElement : null;
  const focusId = /^(input-|asides-toggle-)/.test(focused?.id || '') ? focused.id : null;
  const selection = focusId?.startsWith('input-') ? [focused.selectionStart, focused.selectionEnd] : null;
  cardsLayer.innerHTML = '';

  cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'chat-card';
    cardEl.id = `dom-${card.id}`;
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
    cardEl.style.width = `${card.width}px`;
    if (typeof card.height === 'number') {
      cardEl.style.height = `${card.height}px`;
      cardEl.classList.add('has-custom-height');
    }

    const isBranch = Boolean(card.parentId || (Array.isArray(card.parentIds) && card.parentIds.length > 0));
    const isBattle = Boolean(card.isBattle || card.title?.startsWith('对比 #'));
    const isMerge = Boolean(card.isMerge || card.title?.startsWith('合并总结'));
    const isDoc = Boolean(card.isDoc);
    const busy = activeRequests.has(card.id);
    const chainBusy = chainIsBusy(card);
    if (multiSelectedCardIds.has(card.id)) {
      cardEl.classList.add('is-multi-selected');
    } else if (card.id === selectedCardId) {
      cardEl.classList.add('is-selected-card');
    }
    cardEl.innerHTML = `
      <div class="card-header" data-drag-handle="true">
        <div class="card-title-box">
          <div class="card-dot" style="${isDoc ? 'background-color: #18181b; border-radius: 1px;' : (isMerge ? 'background-color: #18181b; border-radius: 2px;' : (isBattle ? 'background-color: #18181b;' : (isBranch ? 'background-color: #71717a;' : '')))}"></div>
          <span class="card-title">${escapeHtml(card.title)}</span>
          ${isDoc ? '<span class="card-origin-tag tag-doc">[资料源]</span>' : (isMerge ? '<span class="card-origin-tag tag-merge">[合并总结]</span>' : (isBattle ? '<span class="card-origin-tag tag-battle">[对比推导]</span>' : (isBranch ? '<span class="card-origin-tag">[追问分支]</span>' : '')))}
        </div>
        <button class="card-close-btn" title="关闭卡片" data-action="close">×</button>
      </div>
      ${card.sourceRef ? `
        <div class="source-ref-badge" title="导入时的会话标题快照：${escapeHtml(card.sourceRef.titleAtImport || '')}">
          本体导入快照 · ${escapeHtml(card.sourceRef.titleAtImport || card.sourceRef.sessionId)}
          <button type="button" data-action="jump-source">跳回本体</button>
        </div>
      ` : ''}

      <div class="card-body" id="body-${card.id}">
        ${card.messages.map(m => `
          <div class="msg-row ${m.role === 'user' ? 'msg-user' : 'msg-asst'}">
            <span class="msg-role">${m.role === 'user' ? 'User' : escapeHtml(m.agentName || currentAgent.name || 'Assistant')}</span>
            ${messageMarkup(m)}
            ${m.requestId ? `<div class="request-status" id="status-${m.requestId}" role="status">${escapeHtml(statusText(m))}</div>` : ''}
          </div>
        `).join('')}
      </div>

      <div class="card-footer">
        ${Array.isArray(card.stagedAttachments) && card.stagedAttachments.length > 0 ? `
          <div class="staged-attachments-bar">
            ${card.stagedAttachments.map((att, idx) => `
              <div class="staged-att-chip" title="${escapeHtml(att.name)} (${formatFileSize(att.size)})">
                <span class="staged-att-name">${escapeHtml(att.name)}</span>
                <span class="staged-att-size">${formatFileSize(att.size)}</span>
                <button class="staged-att-remove" data-action="remove-attachment" data-index="${idx}" title="移除附件">×</button>
              </div>
            `).join('')}
          </div>
        ` : ''}
        <div class="card-input-row">
          <button class="btn-card-attach" data-action="attach" title="添加文档资料附件" ${chainBusy ? 'disabled' : ''}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <input type="text" class="card-input" placeholder="${isDoc ? '输入关于此文档的问题...' : '输入对话或追问...'}" id="input-${card.id}" ${!sessionController?.state.ready || sessionController.state.busy ? 'disabled' : ''}>
          <button class="card-send-btn" data-action="send" ${chainBusy ? 'disabled' : ''}>发送</button>
          <button class="card-send-btn btn-card-battle" data-action="battle" ${chainBusy ? 'disabled' : ''} title="多模型横向推导 / 对抗">对比 ▾</button>
          <button class="card-send-btn" data-action="cancel" ${busy ? '' : 'hidden'}>取消</button>
        </div>
        <input type="file" id="file-${card.id}" class="card-file-input" style="display: none;" accept=".md,.markdown,.txt,.docx,.pdf,.json,.csv,.py,.js,.ts,.html,.css,.yml,.yaml,.xml,.sh,.sql" multiple>
      </div>

      <!-- 右侧连线追问与对比锚点组 -->
      <div class="branch-anchors-group">
        <div class="branch-anchor-btn" data-action="branch" role="button" aria-disabled="${chainBusy}" title="${chainBusy ? '请等待当前路径请求结束后再分叉' : (isDoc ? '从此资料开辟分析' : '从这里开辟追问分支')}">
          +
          <div class="branch-tooltip">${isDoc ? '从此资料开辟分析' : '从此拉出追问'}</div>
        </div>
        <div class="branch-anchor-btn btn-anchor-battle" data-action="branch-battle" role="button" aria-disabled="${chainBusy}" title="${chainBusy ? '请等待当前路径请求结束后再分叉' : '多模型横向对比分支'}">
          ⑂
          <div class="branch-tooltip">对比分支</div>
        </div>
      </div>

      <!-- 2D 自由拉伸手柄组：右边缘(宽)、底边缘(高)、右下角(宽高对角) -->
      <div class="card-resize-handle handle-right" data-action="resize-card" data-direction="right" title="按住拖拽调整卡片宽度"></div>
      <div class="card-resize-handle handle-bottom" data-action="resize-card" data-direction="bottom" title="按住拖拽调整卡片高度"></div>
      <div class="card-resize-handle handle-corner" data-action="resize-card" data-direction="corner" title="按住拖拽同时调整宽高"></div>
    `;

    bindCardEvents(cardEl, card);
    cardsLayer.appendChild(cardEl);

    const bodyEl = cardEl.querySelector(`#body-${card.id}`);
    if (bodyEl) {
      if (typeof card.height === 'number') {
        bodyEl.style.maxHeight = 'none';
        bodyEl.style.flex = '1 1 0';
      }
      bodyEl.scrollTop = card.scrollToEnd || card.savedScrollTop === undefined ? bodyEl.scrollHeight : card.savedScrollTop;
    }
    card.scrollToEnd = false;
  });

  if (focusId) {
    const restored = document.getElementById(focusId);
    restored?.focus?.({ preventScroll: true });
    if (selection?.every(Number.isInteger)) restored?.setSelectionRange?.(...selection);
  }
  const branchCount = cards.filter(c => c.parentId).length;
  badgeStats.textContent = `${cards.length} 卡片 · ${branchCount} 追问分支`;
  renderConnectors();
}

function bindCardEvents(cardEl, card) {
  const header = cardEl.querySelector('[data-drag-handle="true"]');
  const inputEl = cardEl.querySelector(`#input-${card.id}`);
  const btnSend = cardEl.querySelector('[data-action="send"]');
  const btnBattle = cardEl.querySelector('[data-action="battle"]');
  const btnClose = cardEl.querySelector('[data-action="close"]');
  // 跳回本体：只定位会话，不声称定位到具体某条消息
  cardEl.querySelector('[data-action="jump-source"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!card.sourceRef?.sessionId) return;
    try {
      await hana.sessions.focus({ sessionId: card.sourceRef.sessionId });
    } catch (err) {
      flashMessage(`跳回失败：${safeDetail(err?.message || String(err))}`);
    }
  });
  const btnBranch = cardEl.querySelector('[data-action="branch"]');
  const btnBranchBattle = cardEl.querySelector('[data-action="branch-battle"]');
  const btnCancel = cardEl.querySelector('[data-action="cancel"]');
  for (const message of card.messages) {
    if (!message.requestId) continue;
    const asides = cardEl.querySelector(`#asides-${message.requestId}`);
    if (!asides) continue;
    asides.open = Boolean(message.asidesOpen);
    asides.addEventListener('toggle', () => {
      if (message.asidesOpen !== asides.open) { message.asidesOpen = asides.open; sessionController?.scheduleSave(); }
    });
  }
  cardEl.addEventListener('mousedown', (e) => {
    if (isSpacePressed) return;
    if (e.shiftKey) {
      e.stopPropagation();
      toggleMultiSelectCard(card.id);
      return;
    }
    clearMultiSelect();
    selectCard(card.id, false);
  });
  inputEl.addEventListener('focus', () => {
    selectCard(card.id, true);
  });

  inputEl.value = card.draft || '';
  inputEl.addEventListener('input', () => { card.draft = inputEl.value; sessionController?.scheduleSave(); });
  btnCancel.addEventListener('click', () => {
    const active = activeRequests.get(card.id);
    if (!active || active.terminalSeen) return;
    if (document.activeElement === btnCancel) inputEl.focus({ preventScroll: true });
    active.controller.abort(new ChatError('REQUEST_CANCELLED', '用户取消了本次等待。'));
    active.message.status = 'cancelled';
    active.message.failed = true;
    paintMessage(active.message);
  });

  btnBattle?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (chainIsBusy(card) || !cards.includes(card)) return;
    void openBattleDialog(card, inputEl.value.trim());
  });
  btnBranchBattle?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (chainIsBusy(card) || !cards.includes(card)) return;
    void openBattleDialog(card, inputEl.value.trim());
  });

  const btnAttach = cardEl.querySelector('[data-action="attach"]');
  const fileInput = cardEl.querySelector(`#file-${card.id}`);
  const stagedBar = cardEl.querySelector('.staged-attachments-bar');

  btnAttach?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (chainIsBusy(card) || !cards.includes(card)) return;
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const parsed = await extractDocumentFile(file);
      if (!parsed.ok) {
        flashMessage(`《${parsed.filename}》没读出来（${parsed.stage || '未知'}阶段）：${parsed.error}`);
        continue;
      }
      card.stagedAttachments = (card.stagedAttachments || []).concat({
        name: parsed.filename,
        size: parsed.size,
        extension: parsed.extension,
        charCount: parsed.charCount,
        lineCount: parsed.lineCount,
        content: parsed.text,
        preview: parsed.preview,
      });
    }
    fileInput.value = '';
    renderCards();
    sessionController?.scheduleSave();
  });

  stagedBar?.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-action="remove-attachment"]');
    if (!removeBtn) return;
    e.stopPropagation();
    const index = parseInt(removeBtn.getAttribute('data-index'), 10);
    if (!isNaN(index) && Array.isArray(card.stagedAttachments)) {
      card.stagedAttachments.splice(index, 1);
      renderCards();
      sessionController?.scheduleSave();
    }
  });

  // 卡片级文件拖拽支持
  cardEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      cardEl.classList.add('card-drop-active');
    }
  });

  cardEl.addEventListener('dragleave', (e) => {
    if (e.target === cardEl || !cardEl.contains(e.relatedTarget)) {
      cardEl.classList.remove('card-drop-active');
    }
  });

  cardEl.addEventListener('drop', async (e) => {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      e.stopPropagation();
      cardEl.classList.remove('card-drop-active');
      if (canvasDropIndicator) canvasDropIndicator.hidden = true;
      clearTimeout(dragOverTimer);

      for (const file of Array.from(e.dataTransfer.files)) {
        const parsed = await extractDocumentFile(file);
        if (!parsed.ok) {
          flashMessage(`《${parsed.filename}》没读出来（${parsed.stage || '未知'}阶段）：${parsed.error}`);
          continue;
        }
        card.stagedAttachments = (card.stagedAttachments || []).concat({
          name: parsed.filename,
          size: parsed.size,
          extension: parsed.extension,
          charCount: parsed.charCount,
          lineCount: parsed.lineCount,
          content: parsed.text,
          preview: parsed.preview,
        });
      }
      renderCards();
      sessionController?.scheduleSave();
    }
  });

  // 1. 卡片拖拽移动
  header.addEventListener('mousedown', (e) => {
    if (isSpacePressed) return;
    e.stopPropagation();
    if (!sessionController?.state.ready || sessionController.state.busy) return;
    const dragGeneration = sessionController.generation;
    let startMouseX = e.clientX;
    let startMouseY = e.clientY;
    let startCardX = card.x;
    let startCardY = card.y;

    const onMouseMove = (moveEvent) => {
      if (sessionController.generation !== dragGeneration || !cards.includes(card)) return;
      const dx = (moveEvent.clientX - startMouseX) / view.scale;
      const dy = (moveEvent.clientY - startMouseY) / view.scale;
      card.x = Math.round(startCardX + dx);
      card.y = Math.round(startCardY + dy);
      cardEl.style.left = `${card.x}px`;
      cardEl.style.top = `${card.y}px`;
      renderConnectors();
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (sessionController.generation === dragGeneration) sessionController.scheduleSave();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });

  // 1.1 卡片 2D 自由拖拽缩放（右侧宽、底部高、右下角宽高对角）
  const setupResize = (selector, direction) => {
    const handle = cardEl.querySelector(selector);
    if (!handle || handle.__resizeBound) return;
    handle.__resizeBound = true;

    handle.addEventListener('mousedown', (e) => {
      if (isSpacePressed) return;
      e.stopPropagation();
      e.preventDefault();
      if (!sessionController?.state.ready || sessionController.state.busy) return;
      const resizeGeneration = sessionController.generation;
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;
      const startWidth = card.width || 340;
      const startHeight = card.height || cardEl.offsetHeight || 360;

      cardEl.classList.add('is-resizing');
      document.body?.classList.add('is-card-resizing');
      if (direction === 'bottom') document.body?.classList.add('resizing-s');
      else if (direction === 'corner') document.body?.classList.add('resizing-se');
      else document.body?.classList.add('resizing-ew');

      const onMouseMove = (moveEvent) => {
        if (sessionController.generation !== resizeGeneration || !cards.includes(card)) return;
        const dx = (moveEvent.clientX - startMouseX) / view.scale;
        const dy = (moveEvent.clientY - startMouseY) / view.scale;

        if (direction === 'right' || direction === 'corner') {
          const newWidth = Math.min(Math.max(Math.round(startWidth + dx), 260), 1200);
          card.width = newWidth;
          cardEl.style.width = `${newWidth}px`;
        }
        if (direction === 'bottom' || direction === 'corner') {
          const newHeight = Math.min(Math.max(Math.round(startHeight + dy), 200), 1600);
          card.height = newHeight;
          cardEl.style.height = `${newHeight}px`;
          cardEl.classList.add('has-custom-height');
          const bodyEl = cardEl.querySelector(`#body-${card.id}`);
          if (bodyEl) {
            bodyEl.style.maxHeight = 'none';
            bodyEl.style.flex = '1 1 0';
          }
        }
        renderConnectors();
      };

      const onMouseUp = () => {
        cardEl.classList.remove('is-resizing');
        document.body?.classList.remove('is-card-resizing', 'resizing-s', 'resizing-se', 'resizing-ew');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        if (sessionController.generation === resizeGeneration) {
          sessionController.scheduleSave();
        }
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  };

  setupResize('[data-direction="right"]', 'right');
  setupResize('[data-direction="bottom"]', 'bottom');
  setupResize('[data-direction="corner"]', 'corner');
  setupResize('[data-action="resize-card"]', 'right');

  // 2. 发送消息并执行打字机流式推理
  const doSend = async () => {
    if (chainIsBusy(card) || !cards.includes(card)) return;
    const text = inputEl.value.trim();
    const hasStaged = Array.isArray(card.stagedAttachments) && card.stagedAttachments.length > 0;
    if (!text && !hasStaged) return;
    const staged = hasStaged ? [...card.stagedAttachments] : [];
    card.stagedAttachments = [];
    if (document.activeElement === btnSend) inputEl.focus({ preventScroll: true });
    inputEl.value = '';
    card.draft = '';
    await sendCardPrompt(card, text, { attachments: staged });
  };

  btnSend.addEventListener('click', doSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      createBranchCard(card, { autoFocus: true });
      return;
    }
    if (e.key === 'Escape') {
      inputEl.blur();
      return;
    }
  });

  // 3. 点击从右侧开辟追问分支卡片
  btnBranch.addEventListener('click', (e) => {
    e.stopPropagation();
    createBranchCard(card, { autoFocus: true });
  });

  // 4. 关闭卡片
  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardHierarchy(card);
  });
}

// 画布视口拖拽平移 (Pan)
viewport.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (isSpacePressed) {
    view.isDragging = true;
    view.dragStartX = e.clientX - view.x;
    view.dragStartY = e.clientY - view.y;
    viewport.classList.add('is-dragging-canvas');
    e.preventDefault();
    return;
  }
  if (e.target.closest('.chat-card') || e.target.closest('.floating-zoom-bar') || e.target.closest('.canvas-header') || e.target.closest('.floating-merge-toolbar')) {
    return;
  }
  clearMultiSelect();
  selectCard(null);
  view.isDragging = true;
  view.dragStartX = e.clientX - view.x;
  view.dragStartY = e.clientY - view.y;
  viewport.classList.add('is-dragging-canvas');
});

window.addEventListener('mousemove', (e) => {
  if (!view.isDragging) return;
  view.x = e.clientX - view.dragStartX;
  view.y = e.clientY - view.dragStartY;
  updateTransform();
});

window.addEventListener('mouseup', () => {
  if (view.isDragging) {
    view.isDragging = false;
    viewport.classList.remove('is-dragging-canvas');
  }
});

// 全局键盘快捷键
window.addEventListener('keydown', (e) => {
  const isEditing = document.activeElement && (
    document.activeElement.tagName === 'INPUT' ||
    document.activeElement.tagName === 'TEXTAREA' ||
    document.activeElement.isContentEditable
  );

  // 1. Space 抓手漫游模式
  if (e.code === 'Space' && !isEditing) {
    e.preventDefault();
    if (!isSpacePressed) {
      isSpacePressed = true;
      viewport.classList.add('is-hand-tool');
    }
    return;
  }

  // 2. Tab 键快速开辟追问分支（非编辑状态下，对当前选中的卡片有效）
  if (e.key === 'Tab' && !isEditing) {
    const currentCard = cards.find(c => c.id === selectedCardId);
    if (currentCard && !chainIsBusy(currentCard)) {
      e.preventDefault();
      createBranchCard(currentCard, { autoFocus: true });
      return;
    }
  }

  // 3. 方向键导航（非编辑状态）
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isEditing) {
    e.preventDefault();
    navigateCardFocus(e.key);
    return;
  }

  // 4. Escape 取消选中或关闭弹窗
  if (e.key === 'Escape') {
    if (battleDialog?.open) {
      closeBattleDialog();
      return;
    }
    if (multiSelectedCardIds.size > 0) {
      clearMultiSelect();
      return;
    }
    if (isEditing) {
      document.activeElement.blur();
      return;
    }
    if (selectedCardId) {
      selectCard(null);
      return;
    }
  }

  // 5. Delete / Backspace 关闭卡片（非编辑状态）
  if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditing && selectedCardId) {
    const currentCard = cards.find(c => c.id === selectedCardId);
    if (currentCard) {
      e.preventDefault();
      closeCardHierarchy(currentCard);
      return;
    }
  }

  // 6. Shift + A 树状一键自动整理 (Auto-Tidy)
  if ((e.key === 'a' || e.key === 'A') && e.shiftKey && !isEditing) {
    e.preventDefault();
    autoTidyLayout();
    return;
  }

  // 7. Shift + M 多分支合并总结 (Merge)
  if ((e.key === 'm' || e.key === 'M') && e.shiftKey && !isEditing) {
    if (multiSelectedCardIds.size >= 2) {
      e.preventDefault();
      void createMergeCardFromSelected();
      return;
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    isSpacePressed = false;
    viewport.classList.remove('is-hand-tool');
  }
});

// 滚轮缩放 (Zoom)
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
  const newScale = Math.min(Math.max(view.scale * zoomFactor, 0.4), 2.2);

  const rect = viewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  view.x = mouseX - (mouseX - view.x) * (newScale / view.scale);
  view.y = mouseY - (mouseY - view.y) * (newScale / view.scale);
  view.scale = newScale;

  updateTransform();
}, { passive: false });

btnZoomIn.addEventListener('click', () => {
  view.scale = Math.min(view.scale * 1.15, 2.2);
  updateTransform();
});

btnZoomOut.addEventListener('click', () => {
  view.scale = Math.max(view.scale * 0.85, 0.4);
  updateTransform();
});

// 树状一键自动整理排版算法 (Auto-Tidy Engine)
function autoTidyLayout() {
  if (!cards || cards.length === 0) return;

  const cardMap = new Map(cards.map(c => [c.id, c]));
  const childrenMap = new Map();
  const roots = [];

  cards.forEach(c => {
    childrenMap.set(c.id, []);
  });

  cards.forEach(c => {
    if (c.parentId && cardMap.has(c.parentId)) {
      childrenMap.get(c.parentId).push(c);
    } else {
      roots.push(c);
    }
  });

  childrenMap.forEach(list => {
    list.sort((a, b) => a.y - b.y);
  });
  roots.sort((a, b) => a.y - b.y);

  let currentY = 80;
  const startX = 80;
  const cardH = 360;
  const gapY = 32;
  const gapRoot = 60;

  // 计算每层的最大卡片宽度，确保拉伸后的宽卡片在排版时列间距自适应且不重叠
  const depthMap = new Map();
  function assignDepth(node, depth) {
    depthMap.set(node.id, depth);
    const children = childrenMap.get(node.id) || [];
    children.forEach(child => assignDepth(child, depth + 1));
  }
  roots.forEach(root => assignDepth(root, 0));

  const maxColWidth = new Map();
  cards.forEach(c => {
    const d = depthMap.get(c.id) || 0;
    const w = c.width || 340;
    maxColWidth.set(d, Math.max(maxColWidth.get(d) || 340, w));
  });

  const colStartX = new Map();
  let accumulatedX = startX;
  const maxDepth = Math.max(0, ...Array.from(depthMap.values()));
  for (let d = 0; d <= maxDepth; d++) {
    colStartX.set(d, accumulatedX);
    const colW = maxColWidth.get(d) || 340;
    accumulatedX += colW + 120;
  }

  function layoutSubtree(node, depth) {
    const children = childrenMap.get(node.id) || [];
    node.targetX = colStartX.get(depth) ?? (startX + depth * 460);
    const nodeH = typeof node.height === 'number' ? node.height : cardH;

    if (children.length === 0) {
      node.targetY = currentY;
      currentY += nodeH + gapY;
      return;
    }

    children.forEach(child => {
      layoutSubtree(child, depth + 1);
    });

    const firstChild = children[0];
    const lastChild = children[children.length - 1];
    node.targetY = Math.round((firstChild.targetY + lastChild.targetY) / 2);
    currentY = Math.max(currentY, node.targetY + nodeH + gapY);
  }

  roots.forEach(root => {
    layoutSubtree(root, 0);
    currentY += gapRoot;
  });

  cards.forEach(c => {
    if (typeof c.targetX === 'number' && typeof c.targetY === 'number') {
      c.x = c.targetX;
      c.y = c.targetY;
      delete c.targetX;
      delete c.targetY;
    }
  });

  renderCards();
  sessionController?.scheduleSave();
  fitViewportToCluster(cards);
}

btnAutoTidy?.addEventListener('click', () => {
  autoTidyLayout();
});

btnResetView.addEventListener('click', () => {
  view.x = 60;
  view.y = 40;
  view.scale = 1;
  updateTransform();
});

// 新建主线根卡片
btnNewRoot.addEventListener('click', () => {
  if (!sessionController?.state.ready || sessionController.state.busy) return;
  const rootCount = cards.filter(c => !c.parentId).length + 1;
  const newRoot = {
    id: uniqueId('card'),
    parentId: null,
    title: `主线对话 #${rootCount.toString().padStart(2, '0')}`,
    x: 80 + (rootCount - 1) * 40,
    y: 100 + (rootCount - 1) * 60,
    width: 340,
    messages: [
      { role: 'assistant', localOnly: true, text: '全新主线节点已创建。在下方输入问题开启推导。' }
    ]
  };
  cards.push(newRoot);
  renderCards();
  sessionController.scheduleSave();
});

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
  }
  return btoa(binary);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function extractDocumentFile(file) {
  const name = file.name || '未知文件';
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');
  const textExtensions = new Set([
    '.md', '.markdown', '.txt', '.json', '.csv', '.tsv',
    '.js', '.ts', '.jsx', '.tsx', '.py', '.c', '.cpp',
    '.h', '.hpp', '.java', '.go', '.rs', '.html', '.css',
    '.sh', '.bash', '.sql', '.yaml', '.yml', '.xml', '.ini',
  ]);

  // 1. 文本类文件：浏览器原生秒级读取，零网络开销
  if (textExtensions.has(ext)) {
    const text = typeof file.text === 'function' ? await file.text() : '';
    const charCount = text.length;
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const lineCount = lines.length;
    const preview = text.slice(0, 1500) + (charCount > 1500 ? '\n\n... (文档较长，完整内容已完全载入上下文)' : '');
    return {
      ok: true,
      filename: name,
      extension: ext,
      size: file.size || text.length,
      charCount,
      lineCount,
      text,
      preview,
    };
  }

  // 2. Word (.docx) 与 PDF 等复杂格式：调用后端解析服务
  // 扫描件可能被升级到云端，等十几二十秒是正常的，先把话说在前面，别让人以为卡死了
  const idleBadge = badgeStats ? badgeStats.textContent : '';
  if (badgeStats) {
    badgeStats.textContent = ext === '.pdf'
      ? `正在解析 ${name}…（扫描件会走云端，可能要十几秒）`
      : `正在解析 ${name}…`;
  }
  let parseJobId = null, parseCompleted = false;
  const cancelParser = () => {
    if (parseJobId && !parseCompleted) void requestHost(hana, `/api/document/parse/${encodeURIComponent(parseJobId)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  window.addEventListener?.('pagehide', cancelParser, { once: true });
  try {
    // UI uploads are bounded chunks; outbound cloud transfers use the authorised runtime.
    const CHUNK_RAW_BYTES = 6 * 1024 * 1024;
    const CHUNK_THRESHOLD = 16 * 1024 * 1024;
    let requestBody = { filename: name };
    window.__forkChatLastStage = '开始';

    if (!Number.isFinite(file.size) || file.size > CHUNK_THRESHOLD) {
      const total = Math.ceil(file.size / CHUNK_RAW_BYTES);
      let uploadId = null;
      let uploaded = null;
      for (let i = 0; i < total; i += 1) {
        const slice = file.slice(i * CHUNK_RAW_BYTES, (i + 1) * CHUNK_RAW_BYTES);
        const chunkBase64 = bufferToBase64(await slice.arrayBuffer());
        if (badgeStats) {
          badgeStats.textContent = `正在上传 ${name}… ${i + 1}/${total}`;
        }
        const chunkRes = await requestHost(hana, '/api/document/upload', {
          method: 'POST',
          body: JSON.stringify({ uploadId, filename: name, index: i, total, size: file.size, chunk: chunkBase64 }),
        });
        const chunkData = await chunkRes.json();
        if (!chunkData.ok) throw new Error(chunkData.error || '分块上传失败');
        uploadId = chunkData.uploadId;
        if (chunkData.done) uploaded = chunkData;
      }
      if (!uploaded?.uploadId) throw new Error('分块上传未完成');
      requestBody = { filename: name, uploadId: uploaded.uploadId };
      if (badgeStats) badgeStats.textContent = `正在解析 ${name}…`;
    } else {
      let contentBase64 = '';
      if (typeof file.arrayBuffer === 'function') {
        contentBase64 = bufferToBase64(await file.arrayBuffer());
      }
      requestBody = { filename: name, contentBase64 };
    }

    // 长解析拆成「发起 + 轮询」：单次请求都在秒级完成，不再赌链路耐心
    window.__forkChatLastStage = '发起解析';
    const startRes = await requestHost(hana, '/api/document/parse', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    const startData = await startRes.json();
    if (!startData.ok || !startData.jobId) throw new Error(startData.error || '无法启动解析任务');
    parseJobId = startData.jobId;

    let data = null;
    const deadline = Date.now() + Math.min(20 * 60 * 1000, Math.max(30000, Number(startData.timeoutMs) || 5 * 60 * 1000));
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      window.__forkChatLastStage = '轮询解析进度';
      const statusRes = await requestHost(hana, `/api/document/parse/${encodeURIComponent(startData.jobId)}`);
      const status = await statusRes.json();
      if (!status.ok) throw new Error(status.error || '解析状态查询失败');
      if (status.status === 'done') {
        data = status.result;
        break;
      }
      if (['error', 'cancelled'].includes(status.status)) throw new Error(status.error || '解析失败或已取消');
      if (badgeStats && status.stage) {
        badgeStats.textContent = `正在解析 ${name}…（${status.stage} · ${Math.round((status.elapsedMs || 0) / 1000)}s）`;
      }
    }
    if (!data) throw new Error('解析超过等待时限，已请求取消');

    if (data && data.ok) {
      parseCompleted = true;
      return {
        ...data,
        size: file.size || data.charCount,
      };
    }
    // 解析失败时把原因说清楚（扫描件、字体映射、文件损坏各有各的说法）
    throw new Error(data?.error || '文档解析服务返回异常');
  } catch (err) {
    const stage = window.__forkChatLastStage || '未知';
    // 界面里的报错在宿主日志里看不到，先上报一份，排查时才有凭据
    try {
      void requestHost(hana, '/api/document/client-error', {
        method: 'POST',
        body: JSON.stringify({ stage, message: `${err.message || String(err)} | size=${file.size}` }),
      }).catch(() => {});
    } catch {}
    // 解析失败就是失败：不再伪装成一份空资料存进会话。
    // ok:false 让调用方原地报错，而不是把失败持久化成看似可用的卡片。
    return {
      ok: false,
      filename: name,
      extension: ext,
      size: file.size || 0,
      charCount: 0,
      lineCount: 0,
      stage,
      error: err.message || String(err),
    };
  } finally {
    window.removeEventListener?.('pagehide', cancelParser);
    cancelParser();
    if (badgeStats && idleBadge) badgeStats.textContent = idleBadge;
  }
}

// 解析失败时原地报一声，比默默生成一张空白的资料卡诚实
function flashMessage(text) {
  let el = document.getElementById('fork-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fork-flash';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:60px', 'transform:translateX(-50%)',
      'max-width:min(560px, 78vw)', 'padding:11px 17px', 'border-radius:6px',
      'font-size:12.5px', 'line-height:1.75', 'z-index:9999', 'pointer-events:none',
      'transition:opacity .35s', 'background:#40221f', 'color:#f6ece9',
      'border:1px solid #6b3a34', 'font-family:inherit', 'box-shadow:0 6px 20px rgba(0,0,0,.22)',
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(flashMessage._timer);
  flashMessage._timer = setTimeout(() => { el.style.opacity = '0'; }, 4600);
}

// ===== 本体会话桥接：导入、来源、回传 =====

const bridgeDialogEl = document.getElementById('bridge-dialog');
const bridgeSendDialogEl = document.getElementById('bridge-send-dialog');
const bridgeSessionSelect = document.getElementById('bridge-session-select');
const bridgeLeafSelect = document.getElementById('bridge-leaf-select');
const bridgeLeafField = document.getElementById('bridge-leaf-field');
const bridgePreviewEl = document.getElementById('bridge-preview');
const bridgeErrorEl = document.getElementById('bridge-dialog-error');
const bridgeImportBtn = document.getElementById('btn-bridge-import');
const bridgeActiveHint = document.getElementById('bridge-active-hint');

let bridgePreviewCache = null;
let bridgeTargetSessionId = null;
let bridgeSendBusy = false;
let bridgeSendOpening = false;
// 一次弹窗确认流程只准备一个动作。回执丢失也保留原 actionId 与冻结正文。
let bridgeSendAttempt = null;

function updateBridgeSendControls() {
  const locked = Boolean(bridgeSendBusy || bridgeSendAttempt?.actionId);
  const confirm = document.getElementById('btn-bridge-send-confirm');
  if (confirm) {
    confirm.disabled = bridgeSendBusy || Boolean(bridgeSendAttempt?.completed);
    confirm.textContent = bridgeSendBusy ? '正在处理…'
      : bridgeSendAttempt?.confirmStarted ? '核对/继续原动作' : '确认投递';
  }
  const target = document.getElementById('bridge-send-target');
  const text = document.getElementById('bridge-send-text');
  if (target) target.disabled = locked;
  if (text) text.readOnly = locked;
  for (const id of ['btn-bridge-send-close', 'btn-bridge-send-cancel']) {
    const button = document.getElementById(id);
    if (button) button.disabled = bridgeSendBusy;
  }
  const open = document.getElementById('btn-bridge-send');
  if (open) open.disabled = bridgeSendBusy || bridgeSendOpening;
}

function closeBridgeSendDialog() {
  if (!bridgeSendBusy) bridgeSendDialogEl?.close();
}

async function bridgeRequest(path, init) {
  const res = await requestHost(hana, path, init);
  return res.json();
}

function bridgeFail(el, err) {
  if (el) el.textContent = safeDetail(err?.message || String(err));
}

function bridgeClearError() {
  if (bridgeErrorEl) bridgeErrorEl.textContent = '';
}

/** 会话尾号：同名会话靠这个区分 */
function shortId(id) {
  const text = String(id || '');
  return text.length > 8 ? text.slice(-6) : text;
}

async function loadBridgeSessions(preferSessionId = null) {
  bridgeClearError();
  if (bridgeSessionSelect) bridgeSessionSelect.innerHTML = '<option value="">正在读取…</option>';
  try {
    const [data, active] = await Promise.all([
      bridgeRequest('/api/bridge/sessions'),
      (typeof hana !== 'undefined' && hana?.sessions?.getActive)
        ? hana.sessions.getActive().catch(() => null)
        : null,
    ]);
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    if (!bridgeSessionSelect) return;
    if (!sessions.length) {
      bridgeSessionSelect.innerHTML = '<option value="">没有可读的本体会话</option>';
      if (bridgeImportBtn) bridgeImportBtn.disabled = true;
      return;
    }
    const activeSessionId = active?.sessionId || null;
    const targetId = preferSessionId || activeSessionId || sessions[0]?.sessionId || '';

    bridgeSessionSelect.innerHTML = sessions.map((s) => {
      const count = s.messageCount == null ? '' : `（${s.messageCount} 条）`;
      const isTarget = s.sessionId === targetId;
      const isCur = s.sessionId === activeSessionId ? ' [当前活跃]' : '';
      return `<option value="${escapeHtml(s.sessionId)}"${isTarget ? ' selected' : ''}>${escapeHtml(s.title || s.sessionId)}${isCur}${count} · ${escapeHtml(shortId(s.sessionId))}</option>`;
    }).join('');

    if (targetId) {
      bridgeSessionSelect.value = targetId;
      bridgeTargetSessionId = targetId;
      if (bridgeActiveHint) {
        bridgeActiveHint.textContent = `已自动绑定：${active?.title || targetId}`;
      }
      if (bridgeImportBtn) bridgeImportBtn.disabled = false;
      void runBridgePreview();
    }
  } catch (err) {
    if (bridgeSessionSelect) bridgeSessionSelect.innerHTML = '<option value="">读取失败</option>';
    bridgeFail(bridgeErrorEl, err);
  }
}

async function bindActiveSession() {
  bridgeClearError();
  try {
    const active = await hana.sessions.getActive();
    if (!active?.sessionId) {
      if (bridgeActiveHint) bridgeActiveHint.textContent = '当前窗口没有选中会话';
      return;
    }
    bridgeTargetSessionId = active.sessionId;
    if (bridgeActiveHint) bridgeActiveHint.textContent = `已绑定：${active.title || active.sessionId}`;
    if (bridgeSessionSelect) {
      bridgeSessionSelect.value = active.sessionId;
      if (bridgeImportBtn) bridgeImportBtn.disabled = false;
      void runBridgePreview();
    }
  } catch {
    if (bridgeActiveHint) bridgeActiveHint.textContent = '当前窗口不支持读取本体会话';
  }
}

async function runBridgePreview() {
  bridgeClearError();
  bridgePreviewCache = null;
  const sessionId = bridgeSessionSelect?.value;
  if (!sessionId) {
    if (bridgeImportBtn) bridgeImportBtn.disabled = true;
    return;
  }
  if (bridgeImportBtn) bridgeImportBtn.disabled = false;
  const kind = 'history';
  if (bridgePreviewEl) bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">正在读取最新对话快照…</p>';
  try {
    const payload = { sessionId, kind };
    const data = await bridgeRequest('/api/bridge/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const preview = data.preview;
    bridgePreviewCache = preview;

    const messages = Array.isArray(preview.messages) ? preview.messages : [];
    if (!messages.length) {
      bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">该会话暂无可见消息。</p>';
      return;
    }
    const rows = messages.map((m) => `
      <div class="bridge-msg">
        <span class="bridge-msg-role ${m.role === 'user' ? 'is-user' : ''}">${m.role === 'user' ? '用户' : '助手'}</span>
        ${escapeHtml(m.text.slice(0, 600))}${m.text.length > 600 ? '…' : ''}
      </div>
    `).join('');
    const warn = [];
    if (preview.truncated) warn.push(`已截取最近 ${messages.length} 条记录`);
    if (preview.droppedCount) warn.push(`${preview.droppedCount} 条不可见条目已过滤`);
    if (preview.status?.isStreaming) warn.push('该会话正在生成中');
    bridgePreviewEl.innerHTML = rows + (warn.length ? `<div class="bridge-warn">${escapeHtml(warn.join('；'))}</div>` : '');
    if (bridgeImportBtn) bridgeImportBtn.disabled = false;
  } catch (err) {
    bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">读取快照失败。</p>';
    bridgeFail(bridgeErrorEl, err);
  }
}

/** 导入成一张只读来源资料卡，并写下来源引用便于跳回与去重 */
function createBridgeDocCard({ title, text, sourceRef, messageCount }) {
  // 去重只看内容与导入类型：同内容的快照生成两张一模一样的卡没有意义，
  // 即使两个来源会话标题相同也定位回已有卡片。
  const existing = cards.find((c) => c.sourceRef
    && c.sourceRef.contentHash
    && c.sourceRef.contentHash === sourceRef.contentHash
    && c.sourceRef.importKind === sourceRef.importKind);
  if (existing) {
    selectCard(existing.id, false);
    focusCardInViewport(existing);
    const sameSession = existing.sourceRef.sessionId === sourceRef.sessionId;
    flashMessage(sameSession
      ? '这段内容已经导入过了，已定位到原卡片。'
      : `这段内容已作为《${existing.title}》导入过（来源是另一个会话 ${shortId(existing.sourceRef.sessionId)}），没重复建卡。`);
    return existing;
  }

  let posX = 80;
  let posY = 100;
  if (cards.length > 0) {
    const maxY = Math.max(...cards.map((c) => c.y));
    posY = maxY + 420;
  }

  const newCard = {
    id: uniqueId('doc'),
    parentId: null,
    title,
    isDoc: true,
    docContent: text,
    sourceRef,
    docMeta: { name: title, size: text.length, extension: '.md', charCount: text.length, lineCount: text.split('\n').length },
    x: posX,
    y: posY,
    width: 360,
    messages: [{
      role: 'assistant',
      localOnly: true,
      text: `【本体导入快照】已从本体会话《${title}》导入 ${messageCount} 条正文（${text.length} 字）。\n\n这是只读摘录，不会随原会话变化。点上方徽标可跳回原会话。`,
      docPreview: text.slice(0, 1500),
      docMeta: { name: title, size: text.length, lineCount: text.split('\n').length, charCount: text.length },
    }],
  };
  cards.push(newCard);
  renderCards();
  sessionController?.scheduleSave();
  selectCard(newCard.id, false);
  focusCardInViewport(newCard);
  return newCard;
}

async function importBridgePreview() {
  const sessionId = bridgeSessionSelect?.value;
  if (!sessionId) {
    bridgeFail(bridgeErrorEl, new Error('请先选择一个会话'));
    return;
  }
  bridgeClearError();
  if (bridgeImportBtn) {
    bridgeImportBtn.disabled = true;
    bridgeImportBtn.textContent = '正在导入…';
  }
  try {
    let preview = bridgePreviewCache;
    // 如果还没拉取完成，或者切换了会话，立即按需拉取
    if (!preview || preview.session?.sessionId !== sessionId) {
      const data = await bridgeRequest('/api/bridge/preview', {
        method: 'POST',
        body: JSON.stringify({ sessionId, kind: 'history' }),
      });
      preview = data?.preview;
      bridgePreviewCache = preview;
    }
    const messages = Array.isArray(preview?.messages) ? preview.messages : [];
    if (!messages.length) {
      flashMessage('该会话没有可导入的对话记录。');
      return;
    }
    const body = messages.map((m) => `【${m.role === 'user' ? '用户' : '助手'}】${m.text}`).join('\n\n');
    const text = `# ${preview.session.title || '本体会话'}\n\n> 本体导入快照。只读摘录，不代表原会话仍在同步。\n\n${body}`;
    const sourceRef = {
      version: 1,
      kind: 'hana-session',
      sessionId: preview.session.sessionId,
      entryIds: messages.map((m) => m.entryId).filter(Boolean),
      leafId: preview.leafId || null,
      titleAtImport: preview.session.title || '',
      importedAt: new Date().toISOString(),
      contentHash: '',
      importKind: 'history',
    };
    // 内容哈希用与服务端同一套规则，保证去重键一致
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const payload = messages.map((m) => `${m.role}:${m.text}`).join('\u0000');
    for (let i = 0; i < payload.length; i += 1) {
      const code = payload.charCodeAt(i);
      h1 = (h1 ^ code) >>> 0;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + code * (i + 1)) >>> 0;
    }
    sourceRef.contentHash = `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;

    createBridgeDocCard({
      title: preview.session.title || '本体会话',
      text,
      sourceRef,
      messageCount: messages.length,
    });
    bridgeDialogEl?.close();
  } catch (err) {
    bridgeFail(bridgeErrorEl, err);
  } finally {
    if (bridgeImportBtn) {
      bridgeImportBtn.disabled = false;
      bridgeImportBtn.textContent = '导入到画布';
    }
  }
}

async function loadOutboxList() {
  const box = document.getElementById('bridge-outbox-list');
  if (!box) return;
  try {
    const data = await bridgeRequest('/api/bridge/actions');
    const actions = Array.isArray(data.actions) ? data.actions : [];
    if (!actions.length) {
      box.innerHTML = '<p class="bridge-placeholder">还没有回传记录。</p>';
      return;
    }
    box.innerHTML = actions.map((a) => {
      const tone = a.state === 'failed' ? 'is-bad' : (a.state === 'unknown' ? 'is-unknown' : 'is-ok');
      return `<div class="bridge-outbox-item">
        <span class="bridge-state ${tone}">${escapeHtml(a.state)}</span>
        ${escapeHtml(a.kind === 'send-text' ? '文本' : 'Markdown 文件')}
        · ${escapeHtml(a.targetSessionId)}
        ${a.errorCode ? ` · ${escapeHtml(a.errorCode)}` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<p class="bridge-placeholder">${escapeHtml(safeDetail(err?.message || String(err)))}</p>`;
  }
}

async function openBridgeSendDialog() {
  if (!bridgeSendDialogEl || bridgeSendDialogEl.open || bridgeSendBusy || bridgeSendOpening) return;
  bridgeSendOpening = true;
  // 已知完成/明确失败后的主动打开才是新流程；未知回执仍是旧流程。
  if (!bridgeSendAttempt?.confirmStarted || bridgeSendAttempt.completed) bridgeSendAttempt = null;
  updateBridgeSendControls();
  try {
    const sel = document.getElementById('bridge-send-target');
    const meta = document.getElementById('bridge-send-meta');
    const errEl = document.getElementById('bridge-send-error');
    if (errEl) errEl.textContent = '';
    try {
      const data = await bridgeRequest('/api/bridge/sessions');
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (sel) {
        sel.innerHTML = sessions
          .map((s) => `<option value="${escapeHtml(s.sessionId)}">${escapeHtml(s.title || s.sessionId)} · ${escapeHtml(shortId(s.sessionId))}</option>`)
          .join('');
        if (bridgeTargetSessionId && sessions.some((s) => s.sessionId === bridgeTargetSessionId)) {
          sel.value = bridgeTargetSessionId;
        }
      }
    } catch (err) {
      if (errEl) errEl.textContent = safeDetail(err?.message || String(err));
    }
    const updateMeta = () => {
      const box = document.getElementById('bridge-send-text');
      if (meta) meta.textContent = `${new Blob([box?.value || '']).size} 字节 / 上限 65536`;
    };
    const box = document.getElementById('bridge-send-text');
    if (box) box.oninput = updateMeta;
    // 从当前选中卡片带一段确定性模板，不调模型生成摘要
    const selected = cards.find((c) => c.id === selectedCardId);
    if (box && selected && !box.value.trim()) {
      const lastAssistant = [...(selected.messages || [])].reverse().find((m) => m.role === 'assistant' && m.text);
      const excerpt = lastAssistant?.text ? lastAssistant.text.slice(0, 4000) : (selected.docContent || '').slice(0, 4000);
      box.value = `> 来自「分叉对话」的梅理，原卡片：${selected.title || '未命名'}\n\n${excerpt}`;
    }
    if (bridgeSendAttempt) {
      // 关闭后重开不能把不确定的上次投递偷偷变成一个新的动作。
      if (sel) sel.value = bridgeSendAttempt.sessionId;
      if (box) box.value = bridgeSendAttempt.text;
      if (errEl && !errEl.textContent) errEl.textContent = '上次投递回执未确认；目标与正文已冻结，只能核对/继续原动作，不会重新准备。';
    }
    updateMeta();
    bridgeSendDialogEl.showModal();
  } finally {
    bridgeSendOpening = false;
    updateBridgeSendControls();
  }
}

async function confirmBridgeSend() {
  // disabled 不是互斥锁；程序触发、排队的第二次点击也必须被这道同步闸门挡住。
  if (!bridgeSendDialogEl?.open || bridgeSendBusy || bridgeSendAttempt?.completed) return;
  bridgeSendBusy = true;
  const sel = document.getElementById('bridge-send-target');
  const text = document.getElementById('bridge-send-text');
  const errEl = document.getElementById('bridge-send-error');
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
    bridgeSendDialogEl.close();
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

let pollBridgeIntentsBusy = false;

/** 本体那边点的导入请求（右键 / 消息图标）：自动认领并直接铸造成卡片置入画布 */
async function pollBridgeIntents() {
  if (pollBridgeIntentsBusy) return;
  pollBridgeIntentsBusy = true;
  try {
    const data = await bridgeRequest('/api/bridge/intents');
    const list = Array.isArray(data?.intents) ? data.intents : [];
    if (!list.length) return;

    for (const intent of list) {
      if (!intent?.intentId || intent.consumed) continue;
      // 抢占凭条，防多窗口竞争
      try {
        await bridgeRequest(`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/claim`, {
          method: 'POST',
          body: JSON.stringify({ claimer: 'primary' }),
        });
      } catch {
        continue;
      }

      try {
        const previewData = await bridgeRequest('/api/bridge/preview', {
          method: 'POST',
          body: JSON.stringify({ sessionId: intent.sessionId, kind: 'history' }),
        });
        const preview = previewData?.preview;
        const messages = Array.isArray(preview?.messages) ? preview.messages : [];
        if (!messages.length) {
          await bridgeRequest(`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/release`, {
            method: 'POST',
            body: JSON.stringify({ claimer: 'primary' }),
          }).catch(() => {});
          continue;
        }

        const body = messages.map((m) => `【${m.role === 'user' ? '用户' : '助手'}】${m.text}`).join('\n\n');
        const text = `# ${intent.title || preview.session?.title || '本体会话'}\n\n> 本体导入快照。只读摘录，不代表原会话仍在同步。\n\n${body}`;
        const sourceRef = {
          version: 1,
          kind: 'hana-session',
          sessionId: intent.sessionId,
          entryIds: messages.map((m) => m.entryId).filter(Boolean),
          leafId: preview.leafId || null,
          titleAtImport: intent.title || preview.session?.title || '',
          importedAt: new Date().toISOString(),
          contentHash: '',
          importKind: 'history',
        };

        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        const payloadStr = messages.map((m) => `${m.role}:${m.text}`).join('\u0000');
        for (let i = 0; i < payloadStr.length; i += 1) {
          const code = payloadStr.charCodeAt(i);
          h1 = (h1 ^ code) >>> 0;
          h1 = Math.imul(h1, 0x01000193) >>> 0;
          h2 = (h2 + code * (i + 1)) >>> 0;
        }
        sourceRef.contentHash = `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;

        createBridgeDocCard({
          title: intent.title || preview.session?.title || '本体会话',
          text,
          sourceRef,
          messageCount: messages.length,
        });

        await bridgeRequest(`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/ack`, {
          method: 'POST',
          body: JSON.stringify({ claimer: 'primary' }),
        });

        flashMessage(`已自动从本体导入《${intent.title || preview.session?.title || '会话'}》（${messages.length} 条记录）到画布。`);
      } catch (err) {
        await bridgeRequest(`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/release`, {
          method: 'POST',
          body: JSON.stringify({ claimer: 'primary' }),
        }).catch(() => {});
      }
    }
  } catch {
    // 没权限或宿主不支持都不影响画布
  } finally {
    pollBridgeIntentsBusy = false;
  }
}

function initSessionBridge() {
  if (!bridgeDialogEl) return;
  // 裁剪过的宿主（或测试里的假 document）没有这些方法，就让桥接安静退场
  if (typeof document.querySelectorAll !== 'function') return;
  document.getElementById('btn-bridge-open')?.addEventListener('click', async () => {
    bridgeDialogEl.showModal();
    await loadBridgeSessions();
    await loadOutboxList();
  });
  document.getElementById('btn-bridge-close')?.addEventListener('click', () => bridgeDialogEl.close());
  document.getElementById('btn-bridge-cancel')?.addEventListener('click', () => bridgeDialogEl.close());
  document.getElementById('btn-bridge-bind-active')?.addEventListener('click', bindActiveSession);
  document.getElementById('btn-bridge-preview')?.addEventListener('click', runBridgePreview);
  bridgeImportBtn?.addEventListener('click', importBridgePreview);
  document.getElementById('btn-bridge-refresh-outbox')?.addEventListener('click', loadOutboxList);

  bridgeSessionSelect?.addEventListener('change', () => {
    const val = bridgeSessionSelect.value;
    if (val) {
      if (bridgeImportBtn) bridgeImportBtn.disabled = false;
      void runBridgePreview();
    } else {
      if (bridgeImportBtn) bridgeImportBtn.disabled = true;
      if (bridgePreviewEl) bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">请选择要导入的会话。</p>';
    }
  });

  document.getElementById('bridge-tab-import')?.addEventListener('click', () => {
    document.getElementById('bridge-pane-import').hidden = false;
    document.getElementById('bridge-pane-outbox').hidden = true;
    document.getElementById('bridge-tab-import').classList.add('is-active');
    document.getElementById('bridge-tab-outbox').classList.remove('is-active');
  });
  document.getElementById('bridge-tab-outbox')?.addEventListener('click', () => {
    document.getElementById('bridge-pane-import').hidden = true;
    document.getElementById('bridge-pane-outbox').hidden = false;
    document.getElementById('bridge-tab-outbox').classList.add('is-active');
    document.getElementById('bridge-tab-import').classList.remove('is-active');
    void loadOutboxList();
  });

  document.getElementById('btn-bridge-send')?.addEventListener('click', openBridgeSendDialog);
  document.getElementById('btn-bridge-send-close')?.addEventListener('click', closeBridgeSendDialog);
  document.getElementById('btn-bridge-send-cancel')?.addEventListener('click', closeBridgeSendDialog);
  bridgeSendDialogEl?.addEventListener('cancel', (event) => {
    if (bridgeSendBusy) event.preventDefault();
  });
  document.getElementById('btn-bridge-send-confirm')?.addEventListener('click', confirmBridgeSend);
  updateBridgeSendControls();

  void pollBridgeIntents();
  if (typeof setInterval === 'function') {
    setInterval(() => { void pollBridgeIntents(); }, 5000);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => void pollBridgeIntents());
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void pollBridgeIntents();
    });
  }
  // 前台会话切换只更新提示，不改已绑定目标
  try {
    hana.sessions.onActiveChanged?.((change) => {
      if (!bridgeActiveHint) return;
      bridgeActiveHint.textContent = change?.sessionId
        ? `当前会话：${change.title || change.sessionId}`
        : '当前窗口没有选中会话';
    });
  } catch {
    // 窗口不支持就静默
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSessionBridge, { once: true });
} else {
  initSessionBridge();
}

async function createDocumentCard(file, targetCoord = null) {
  if (!sessionController?.state.ready || sessionController.state.busy || !file) return null;
  const result = await extractDocumentFile(file);
  if (!result.ok) {
    flashMessage(`《${result.filename}》没读出来（${result.stage || '未知'}阶段）：${result.error}`);
    return null;
  }
  const rootCount = cards.filter(c => !c.parentId).length + 1;
  const x = targetCoord ? targetCoord.x : (80 + (rootCount - 1) * 40);
  const y = targetCoord ? targetCoord.y : (100 + (rootCount - 1) * 60);

  const newCard = {
    id: uniqueId('doc'),
    parentId: null,
    title: result.filename,
    isDoc: true,
    docContent: result.text,
    docMeta: {
      name: result.filename,
      size: result.size,
      extension: result.extension,
      charCount: result.charCount,
      lineCount: result.lineCount,
    },
    x,
    y,
    width: 360,
    messages: [
      {
        role: 'assistant',
        localOnly: true,
        text: `【资料源就绪】已成功解析《${result.filename}》（${formatFileSize(result.size)} · ${result.charCount} 字）· 引擎：${result.engineLabel || '本地'}。\n\n点击卡片右侧 [+] 追问 或 [⑂ 对比]，即可以此文档为基座开辟分析分支。`,
        docPreview: result.preview,
        docMeta: {
          name: result.filename,
          size: result.size,
          lineCount: result.lineCount,
          charCount: result.charCount,
        },
      }
    ],
  };

  cards.push(newCard);
  renderCards();
  sessionController?.scheduleSave();
  selectCard(newCard.id, false);
  return newCard;
}

btnImportDoc?.addEventListener('click', () => {
  globalDocInput?.click();
});

globalDocInput?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  for (const file of files) {
    await createDocumentCard(file);
  }
  globalDocInput.value = '';
});

// 画布全局拖拽释放文档
let dragOverTimer = null;
viewport?.addEventListener('dragenter', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    if (canvasDropIndicator) canvasDropIndicator.hidden = false;
  }
});

viewport?.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (canvasDropIndicator) canvasDropIndicator.hidden = false;
    clearTimeout(dragOverTimer);
    dragOverTimer = setTimeout(() => {
      if (canvasDropIndicator) canvasDropIndicator.hidden = true;
    }, 400);
  }
});

viewport?.addEventListener('dragleave', (e) => {
  if (e.target === viewport || e.target === canvasDropIndicator) {
    if (canvasDropIndicator) canvasDropIndicator.hidden = true;
  }
});

viewport?.addEventListener('drop', async (e) => {
  if (e.dataTransfer?.files?.length) {
    e.preventDefault();
    if (canvasDropIndicator) canvasDropIndicator.hidden = true;
    clearTimeout(dragOverTimer);
    const files = Array.from(e.dataTransfer.files);
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const canvasX = Math.round((mouseX - view.x) / view.scale);
    const canvasY = Math.round((mouseY - view.y) / view.scale);

    for (let i = 0; i < files.length; i++) {
      const coord = {
        x: canvasX + i * 40,
        y: canvasY + i * 60,
      };
      await createDocumentCard(files[i], coord);
    }
  }
});

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function initialSnapshot() {
  return {
    cards: initialCards(),
    view: { x: 60, y: 40, scale: 1 },
    agent: {
      ...currentAgent,
      ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
    },
  };
}
function captureSnapshot() {
  for (const card of cards) {
    const input = document.getElementById(`input-${card.id}`);
    if (input && typeof input.value === 'string') card.draft = input.value;
    const body = document.getElementById(`body-${card.id}`);
    if (typeof body?.scrollTop === 'number') card.savedScrollTop = body.scrollTop;
    for (const message of card.messages) {
      if (!message.requestId) continue;
      const details = document.getElementById(`asides-${message.requestId}`);
      if (typeof details?.open === 'boolean') message.asidesOpen = details.open;
    }
  }
  const { id, name, model, provider } = currentAgent;
  return JSON.parse(JSON.stringify({
    cards,
    view: { x: view.x, y: view.y, scale: view.scale },
    agent: {
      id, name, model, provider,
      ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
    },
  }));
}
function applySnapshot(snapshot) {
  cards = snapshot.cards;
  Object.assign(view, snapshot.view, { isDragging: false });
  currentAgent = { ...currentAgent, ...snapshot.agent };
  currentReasoningEffort = snapshot.agent?.reasoningEffort || null;
  try {
    localStorage.setItem('fork_chat_reasoning_effort', currentReasoningEffort || 'default');
  } catch {}
  for (const [key, value] of Object.entries({ id: currentAgent.id, name: currentAgent.name, model: currentAgent.model, provider: currentAgent.provider })) {
    try { localStorage.setItem(`fork_chat_active_agent_${key}`, value || ''); } catch { /* Host storage is authoritative; this is only a legacy UI hint. */ }
  }
  updateHeaderStatus(); updateTransform(); renderCards(false);
}
function cancelSessionRequests(reason) {
  for (const active of activeRequests.values()) {
    active.message.status = 'cancelled'; active.message.failed = true; active.message.streaming = false;
    active.message.error = `REQUEST_INTERRUPTED: ${reason}，回复未完成。`;
    paintMessage(active.message);
    active.controller.abort(new ChatError('REQUEST_CANCELLED', reason));
  }
  activeRequests.clear();
}
function publishSessionState(targetPanelId) {
  if (!sessionController) return;
  const state = sessionController.state;
  bus.postMessage({
    type: 'FORK_SESSION_STATE',
    canvasId,
    targetPanelId,
    activeId: state.activeId,
    ready: state.ready,
    busy: state.busy || Boolean(deleteIntent),
    saving: state.saving,
    dirty: state.dirty,
    error: state.error,
    agent: {
      ...currentAgent,
      ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
    },
  });
}
function replySessionCommand(message, result) {
  if (!message?.requestId || !message?.panelId) return;
  bus.postMessage({ type: 'FORK_SESSION_RESULT', canvasId, targetPanelId: message.panelId,
    requestId: message.requestId, command: message.command, ...result });
}
async function renameSessionFromIntent(message) {
  if (activeRenameCommands.has(message.requestId)) return;
  activeRenameCommands.add(message.requestId);
  try {
    const intent = await readRenameIntent(hana, message.requestId, message.sessionId);
    const result = await sessionController.rename(message.sessionId, intent.title, intent.expectedTitle);
    replySessionCommand(message, result);
  } catch (err) { replySessionCommand(message, { ok: false, error: safeDetail(err.message) }); }
  finally { activeRenameCommands.delete(message.requestId); await clearRenameIntent(hana, message.requestId); }
}
function dismissDeleteConfirmation(cancelled = true) {
  if (!deleteIntent || deleteInProgress) return;
  const message = deleteIntent.message;
  deleteIntent = null;
  deleteDialog.close();
  publishSessionState();
  if (cancelled) replySessionCommand(message, { ok: false, cancelled: true });
}
async function openDeleteConfirmation(message) {
  if (!sessionController.state.ready || sessionController.state.busy) {
    replySessionCommand(message, { ok: false, error: '会话正忙，请稍后重试。' }); return;
  }
  const intent = { message, record: null };
  deleteIntent = intent;
  deleteTargetTitle.textContent = '正在读取会话…';
  deleteDialogError.textContent = '';
  deleteDialogProgress.textContent = '确认前不会删除或取消任何请求。';
  btnDeleteConfirm.disabled = true; btnDeleteCancel.disabled = false;
  deleteDialog.showModal(); btnDeleteCancel.focus(); publishSessionState();
  try {
    const record = await sessionStore.get(message.sessionId);
    if (deleteIntent !== intent) return;
    intent.record = record;
    deleteTargetTitle.textContent = record.title;
    const isCurrent = record.id === sessionController.state.activeId;
    const changedElsewhere = isCurrent && record.revision > sessionController.state.activeRevision;
    deleteDialogProgress.textContent = changedElsewhere
      ? '已保存版本较本窗口记录更新（可能来自其他窗口）。确认后会删除最新已保存版本，以及本窗口未保存的内容。'
      : isCurrent && activeRequests.size ? '当前仍在生成，确认删除后会先停止请求。'
      : '删除后将切换到其他会话；最后一个会话删除后会新建空白会话。';
    btnDeleteConfirm.disabled = false;
  } catch (err) {
    if (deleteIntent === intent) deleteDialogError.textContent = safeDetail(err.message);
  }
}
btnDeleteCancel.addEventListener('click', () => dismissDeleteConfirmation());
deleteDialog.addEventListener('cancel', event => { event.preventDefault(); dismissDeleteConfirmation(); });
btnDeleteConfirm.addEventListener('click', async event => {
  // A forged channel message or scripted .click() is not deletion consent.
  if (!event?.isTrusted) return;
  const intent = deleteIntent;
  if (!intent?.record || deleteInProgress) return;
  deleteInProgress = true; btnDeleteConfirm.disabled = btnDeleteCancel.disabled = true;
  deleteDialogError.textContent = ''; deleteDialogProgress.textContent = '正在删除…';
  const result = await sessionController.remove(intent.record.id, intent.record.revision, initialSnapshot());
  deleteInProgress = false;
  if (result.ok) {
    dismissDeleteConfirmation(false);
    replySessionCommand(intent.message, result);
  } else {
    deleteDialogError.textContent = result.error || '删除失败，原会话尚未移除。';
    deleteDialogProgress.textContent = '可以取消，或检查存储状态后重试。';
    btnDeleteConfirm.disabled = btnDeleteCancel.disabled = false;
  }
});
let lastPhase = '';
const sessionStore = createForkSessionStore(hana);
sessionController = createForkSessionController({
  store: sessionStore, capture: captureSnapshot, apply: applySnapshot, cancelPending: cancelSessionRequests,
  onChange(state) {
    sessionStatusEl.textContent = state.error ? `${state.dirty ? '未保存' : '会话操作失败'} · ${safeDetail(state.error)}`
      : !state.ready ? '正在恢复会话…' : `${state.title} · ${state.busy ? '正在切换…' : state.saving ? '保存中…' : state.dirty ? '待保存' : '已保存'}`;
    sessionStatusEl.title = sessionStatusEl.textContent;
    btnRetrySave.hidden = !state.error;
    btnSaveCopy.hidden = !state.error || !state.ready;
    btnRetrySave.disabled = btnSaveCopy.disabled = state.busy;
    btnNewRoot.disabled = !state.ready || state.busy;
    const phase = `${state.ready}:${state.busy}`;
    if (lastPhase !== phase) { lastPhase = phase; renderCards(); }
    publishSessionState();
  },
});
btnRetrySave.addEventListener('click', () => { void (sessionController.state.ready ? sessionController.flush() : sessionController.init()).catch(() => {}); });
btnSaveCopy.addEventListener('click', () => { void sessionController.saveCopy().catch(() => {}); });
const stopWatchingSessions = sessionStore.watch(() => { void sessionController.refresh().catch(() => {}); });
window.addEventListener('pagehide', () => {
  stopWatchingSessions?.();
  void sessionController.close().catch(() => {});
});

btnBattleClose?.addEventListener('click', closeBattleDialog);
btnBattleCancel?.addEventListener('click', closeBattleDialog);
battleDialog?.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeBattleDialog();
});

btnBattleSubmit?.addEventListener('click', async () => {
  const prompt = battlePromptInput?.value?.trim() || '';
  if (!prompt) {
    if (battleDialogError) battleDialogError.textContent = '请输入推导问题。';
    return;
  }
  if (battleSelectedAgentIds.size === 0) {
    if (battleDialogError) battleDialogError.textContent = '请至少选择一个对比助手。';
    return;
  }
  if (battleDialogError) battleDialogError.textContent = '';

  const targetCard = battleTargetCard;
  const agents = cachedAgents.filter(a => battleSelectedAgentIds.has(a.id));
  closeBattleDialog();

  if (targetCard && cards.includes(targetCard)) {
    void runBattleBranches(targetCard, prompt, agents);
  }
});

btnMergeCancel?.addEventListener('click', () => {
  clearMultiSelect();
});

btnMergeSubmit?.addEventListener('click', () => {
  void createMergeCardFromSelected();
});

// Ready precedes host storage requests; initialization failures remain visible.
updateTransform(); renderCards(); hana.ready();
await sessionController.init();

if (typeof window !== 'undefined') {
  window.__forkChat = {
    sendCardPrompt,
    buildChainContext,
    loadAvailableAgents,
    getAvailableAgents: () => cachedAgents,
    getCards: () => cards,
    getView: () => view,
    openBattleDialog,
    closeBattleDialog,
    runBattleBranches,
    calculateBranchYPositions,
    fitViewportToCluster,
    selectCard,
    createBranchCard,
    closeCardHierarchy,
    navigateCardFocus,
    getSelectedCardId: () => selectedCardId,
    getIsSpacePressed: () => isSpacePressed,
    autoTidyLayout,
    renderCards,
    renderConnectors,
    toggleMultiSelectCard,
    clearMultiSelect,
    getMultiSelectedCardIds: () => multiSelectedCardIds,
    synthesizeMergePrompt,
    createMergeCardFromSelected,
    formatFileSize,
    extractDocumentFile,
    createDocumentCard,
  };
}

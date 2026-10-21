import { hana } from './sdk.js';
import { safeDetail } from './host-api.js';
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
  if (!message.requestId || message.role !== 'assistant') return bubble;
  return `${bubble}
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
const btnNewRoot = document.getElementById('btn-new-root');
const sessionStatusEl = document.getElementById('session-status');
const btnRetrySave = document.getElementById('btn-retry-save');
const btnSaveCopy = document.getElementById('btn-save-copy');
const deleteDialog = document.getElementById('delete-session-dialog');
const deleteTargetTitle = document.getElementById('delete-target-title');
const deleteDialogError = document.getElementById('delete-dialog-error');
const deleteDialogProgress = document.getElementById('delete-dialog-progress');
const btnDeleteConfirm = document.getElementById('btn-delete-confirm');
const btnDeleteCancel = document.getElementById('btn-delete-cancel');

// 跨窗口同步助手与模型状态
const bus = new BroadcastChannel('fork-chat-bus');
let currentAgent = {
  id: localStorage.getItem('fork_chat_active_agent_id') || 'hakimi',
  name: localStorage.getItem('fork_chat_active_agent_name') || 'Hakimi',
  model: localStorage.getItem('fork_chat_active_agent_model') || 'gemini-3.8-flash-high',
  provider: localStorage.getItem('fork_chat_active_agent_provider') || 'gemini'
};

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

// 绘制所有卡片之间的贝塞尔曲线
function renderConnectors() {
  connectorsSvg.innerHTML = '';

  cards.forEach(child => {
    if (!child.parentId) return;
    const parent = cards.find(c => c.id === child.parentId);
    if (!parent) return;

    // 起点：父卡片右侧边缘锚点
    const startX = parent.x + parent.width;
    const startY = parent.y + 110;

    // 终点：子卡片左侧中点
    const endX = child.x;
    const endY = child.y + 110;

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

    const isBranch = !!card.parentId;
    const busy = activeRequests.has(card.id);
    const chainBusy = chainIsBusy(card);
    cardEl.innerHTML = `
      <div class="card-header" data-drag-handle="true">
        <div class="card-title-box">
          <div class="card-dot" style="${isBranch ? 'background-color: #71717a;' : ''}"></div>
          <span class="card-title">${escapeHtml(card.title)}</span>
          ${isBranch ? '<span class="card-origin-tag">[追问分支]</span>' : ''}
        </div>
        <button class="card-close-btn" title="关闭卡片" data-action="close">×</button>
      </div>

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
        <input type="text" class="card-input" placeholder="输入对话或追问..." id="input-${card.id}" ${!sessionController?.state.ready || sessionController.state.busy ? 'disabled' : ''}>
        <button class="card-send-btn" data-action="send" ${chainBusy ? 'disabled' : ''}>发送</button>
        <button class="card-send-btn" data-action="cancel" ${busy ? '' : 'hidden'}>取消</button>
      </div>

      <!-- 右侧连线追问锚点 -->
      <div class="branch-anchor-btn" data-action="branch" role="button" aria-disabled="${chainBusy}" title="${chainBusy ? '请等待当前路径请求结束后再分叉' : '从这里开辟追问分支'}">
        +
        <div class="branch-tooltip">从此拉出追问</div>
      </div>
    `;

    bindCardEvents(cardEl, card);
    cardsLayer.appendChild(cardEl);

    const bodyEl = cardEl.querySelector(`#body-${card.id}`);
    if (bodyEl) bodyEl.scrollTop = card.scrollToEnd || card.savedScrollTop === undefined ? bodyEl.scrollHeight : card.savedScrollTop;
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
  const btnClose = cardEl.querySelector('[data-action="close"]');
  const btnBranch = cardEl.querySelector('[data-action="branch"]');
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

  // 1. 卡片拖拽移动
  header.addEventListener('mousedown', (e) => {
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

  // 向上递归回溯祖先节点，拼装从根节点到当前节点的完整上下文链路
  function buildChainContext(targetCard) {
    const chain = [];
    let curr = targetCard;
    while (curr) {
      chain.unshift(curr);
      curr = cards.find(c => c.id === curr.parentId);
    }
    const msgs = [];
    chain.forEach(c => {
      c.messages.forEach(m => {
        if (!m.text || m.localOnly || m.streaming || m.failed || (m.status && m.status !== 'completed')) return;
        msgs.push({
          role: m.role,
          content: outputFor(m).body
        });
      });
    });
    return msgs;
  }

  // 2. 发送消息并执行打字机流式推理
  const doSend = async () => {
    if (chainIsBusy(card) || !cards.includes(card)) return;
    const text = inputEl.value.trim();
    if (!text) return;
    if (document.activeElement === btnSend) inputEl.focus({ preventScroll: true });
    inputEl.value = '';
    card.draft = '';

    card.messages.push({ role: 'user', text });
    
    // 祖先链路完整上下文
    const contextMessages = buildChainContext(card);

    // 新增 assistant 占位消息并进入流式态
    const requestId = uniqueId('req');
    const requestGeneration = sessionController.generation;
    const agent = { ...currentAgent };
    const asstMsg = {
      role: 'assistant', agentId: agent.id, agentName: agent.name || 'Assistant',
      requestId, text: '', status: 'waiting', streaming: true,
    };
    const active = { requestId, controller: new AbortController(), message: asstMsg, terminalSeen: false };
    activeRequests.set(card.id, active);
    card.messages.push(asstMsg);
    card.scrollToEnd = true;
    renderCards();
    sessionController.scheduleSave();

    try {
      const result = await runChat(hana, {
        requestId, cardId: card.id, agentId: agent.id,
        modelRef: agent.provider && agent.model ? `${agent.provider}/${agent.model}` : agent.model,
        messages: contextMessages,
      }, {
        signal: active.controller.signal,
        onWaiting() { if (sessionController.generation === requestGeneration) { asstMsg.waitingLong = true; paintMessage(asstMsg); } },
        onCancelResult(confirmed, detail) {
          if (sessionController.generation !== requestGeneration) return;
          asstMsg.cancelConfirmed = confirmed; asstMsg.cancelError = detail; paintMessage(asstMsg);
        },
        onEvent(event) {
          if (sessionController.generation !== requestGeneration || activeRequests.get(card.id) !== active || !cards.includes(card)) return;
          if (event.type === 'start') {
            asstMsg.modelRef = `${event.provider}/${event.model}${event.reasoningEffort === 'medium' ? ' · 推理 medium' : ''}`;
          }
          if (event.type === 'text-delta') { asstMsg.text += event.delta; if (event.delta) asstMsg.status = 'generating'; }
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
        card.scrollToEnd = true; renderCards(); sessionController.scheduleSave();
      }
    }
  };

  btnSend.addEventListener('click', doSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSend();
  });

  // 3. 点击从右侧开辟追问分支卡片
  btnBranch.addEventListener('click', (e) => {
    e.stopPropagation();
    if (chainIsBusy(card) || !cards.includes(card)) return;
    const existingChildren = cards.filter(c => c.parentId === card.id);
    const branchIndex = existingChildren.length + 1;
    const newId = uniqueId('branch');

    const lastMessage = card.messages.filter(message => !message.failed && !message.localOnly && (!message.status || message.status === 'completed')).at(-1);
    const lastMsg = lastMessage ? outputFor(lastMessage).body.trim() || '父级卡片' : '父级卡片';
    const snippet = lastMsg.length > 20 ? lastMsg.slice(0, 20) + '...' : lastMsg;

    const newCard = {
      id: newId,
      parentId: card.id,
      title: `追问 #${branchIndex} (${card.title.split(' ')[0]})`,
      x: card.x + card.width + 120,
      y: card.y + (existingChildren.length * 200),
      width: 340,
      messages: [
        {
          role: 'assistant',
          localOnly: true,
          text: `【承袭前置上下文】\n已从「${card.title}」成功拉出新分支。\n前置结论锚点：“${snippet}”\n你可以在此提出分支问题，绝不污染父卡片。`
        }
      ]
    };

    cards.push(newCard);
    renderCards();
    sessionController.scheduleSave();

    // 平滑聚焦新卡片
    view.x = -newCard.x + 300;
    view.y = -newCard.y + 140;
    updateTransform();
  });

  // 4. 关闭卡片
  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
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
    renderCards();
    sessionController.scheduleSave();
  });
}

// 画布视口拖拽平移 (Pan)
viewport.addEventListener('mousedown', (e) => {
  if (e.target.closest('.chat-card') || e.target.closest('.floating-zoom-bar') || e.target.closest('.canvas-header')) {
    return;
  }
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function initialSnapshot() {
  return { cards: initialCards(), view: { x: 60, y: 40, scale: 1 }, agent: { ...currentAgent } };
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
  return JSON.parse(JSON.stringify({ cards, view: { x: view.x, y: view.y, scale: view.scale }, agent: { id, name, model, provider } }));
}
function applySnapshot(snapshot) {
  cards = snapshot.cards;
  Object.assign(view, snapshot.view, { isDragging: false });
  currentAgent = { ...currentAgent, ...snapshot.agent };
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
  bus.postMessage({ type: 'FORK_SESSION_STATE', canvasId, targetPanelId, activeId: state.activeId,
    ready: state.ready, busy: state.busy || Boolean(deleteIntent), saving: state.saving, dirty: state.dirty, error: state.error, agent: currentAgent });
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

// Ready precedes host storage requests; initialization failures remain visible.
updateTransform(); renderCards(); hana.ready();
await sessionController.init();

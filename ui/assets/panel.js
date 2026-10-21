import { hana } from './sdk.js';

// 画布视图状态
const view = {
  x: 60,
  y: 40,
  scale: 1,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
};

// 纯新手开箱状态：只有一张干净的初始对话卡片，无任何历史残留
let cards = [
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
        text: '你好！这里是你的第一张对话卡片。\n\n在下方输入框打入你想聊的内容开启主线；随时点击卡片右侧的 [+] 按钮，即可开辟一条独立的追问分支。'
      }
    ]
  }
];

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
  if (e.data?.type === 'AGENT_CHANGED' && e.data.agent) {
    currentAgent = { ...currentAgent, ...e.data.agent };
    updateHeaderStatus();
  } else if (e.data?.type === 'MODEL_CHANGED' && e.data.model) {
    updateHeaderStatus();
  }
};

// 更新画布平移与缩放矩阵
function updateTransform() {
  surface.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomText.textContent = `${Math.round(view.scale * 100)}%`;
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
function renderCards() {
  cardsLayer.innerHTML = '';

  cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'chat-card';
    cardEl.id = `dom-${card.id}`;
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
    cardEl.style.width = `${card.width}px`;

    const isBranch = !!card.parentId;
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
            <div class="msg-bubble">${escapeHtml(m.text)}</div>
          </div>
        `).join('')}
      </div>

      <div class="card-footer">
        <input type="text" class="card-input" placeholder="输入对话或追问..." id="input-${card.id}">
        <button class="card-send-btn" data-action="send">发送</button>
      </div>

      <!-- 右侧连线追问锚点 -->
      <div class="branch-anchor-btn" data-action="branch" title="从这里开辟追问分支">
        +
        <div class="branch-tooltip">从此拉出追问</div>
      </div>
    `;

    bindCardEvents(cardEl, card);
    cardsLayer.appendChild(cardEl);

    const bodyEl = cardEl.querySelector(`#body-${card.id}`);
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  });

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

  // 1. 卡片拖拽移动
  header.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    let startMouseX = e.clientX;
    let startMouseY = e.clientY;
    let startCardX = card.x;
    let startCardY = card.y;

    const onMouseMove = (moveEvent) => {
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
        if (!m.text || m.streaming) return;
        msgs.push({
          role: m.role,
          content: m.text
        });
      });
    });
    return msgs;
  }

  // 2. 发送消息并执行打字机流式推理
  const doSend = async () => {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';

    card.messages.push({ role: 'user', text });
    
    // 祖先链路完整上下文
    const contextMessages = buildChainContext(card);

    // 新增 assistant 占位消息并进入流式态
    const asstMsg = {
      role: 'assistant',
      agentId: currentAgent.id,
      agentName: currentAgent.name,
      text: '...',
      streaming: true
    };
    card.messages.push(asstMsg);
    renderCards();

    try {
      const apiUrl = hana.api.url('/api/chat/stream');
      
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: currentAgent.id,
          modelRef: currentAgent.provider && currentAgent.model ? `${currentAgent.provider}/${currentAgent.model}` : currentAgent.model,
          messages: contextMessages
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let isFirstChunk = true;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (isFirstChunk) {
          accumulated = chunk;
          isFirstChunk = false;
        } else {
          accumulated += chunk;
        }
        asstMsg.text = accumulated;
        
        // 实时平滑刷新卡片文字
        const bubbleEl = cardEl.querySelector(`#body-${card.id} .msg-row:last-child .msg-bubble`);
        if (bubbleEl) {
          bubbleEl.textContent = accumulated;
          const bodyEl = cardEl.querySelector(`#body-${card.id}`);
          if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
        }
      }
    } catch (err) {
      asstMsg.text = `[流式连接提示: ${err.message}]`;
    } finally {
      asstMsg.streaming = false;
      renderCards();
    }
  };

  btnSend.addEventListener('click', doSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSend();
  });

  // 3. 点击从右侧开辟追问分支卡片
  btnBranch.addEventListener('click', (e) => {
    e.stopPropagation();
    const existingChildren = cards.filter(c => c.parentId === card.id);
    const branchIndex = existingChildren.length + 1;
    const newId = `branch-${Date.now().toString(36)}`;

    const lastMsg = card.messages[card.messages.length - 1]?.text || '父级卡片';
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
          text: `【承袭前置上下文】\n已从「${card.title}」成功拉出新分支。\n前置结论锚点：“${snippet}”\n你可以在此提出分支问题，绝不污染父卡片。`
        }
      ]
    };

    cards.push(newCard);
    renderCards();

    // 平滑聚焦新卡片
    view.x = -newCard.x + 300;
    view.y = -newCard.y + 140;
    updateTransform();
  });

  // 4. 关闭卡片
  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
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
    cards = cards.filter(c => !idsToDelete.has(c.id));
    renderCards();
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
  const rootCount = cards.filter(c => !c.parentId).length + 1;
  const newRoot = {
    id: `card-${Date.now().toString(36)}`,
    parentId: null,
    title: `主线对话 #${rootCount.toString().padStart(2, '0')}`,
    x: 80 + (rootCount - 1) * 40,
    y: 100 + (rootCount - 1) * 60,
    width: 340,
    messages: [
      { role: 'assistant', text: '全新主线节点已创建。在下方输入问题开启推导。' }
    ]
  };
  cards.push(newRoot);
  renderCards();
});

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 初始化
updateTransform();
renderCards();

// 通知宿主就绪
hana.ready();

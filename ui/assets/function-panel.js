import { hana } from './sdk.js';
import { requestHost } from './host-api.js';
import { createForkSessionStore } from './fork-session-store.js';
import { writeRenameIntent } from './fork-session-commands.js';

const channel = new BroadcastChannel('fork-chat-bus');
const panelId = 'panel_' + Math.random().toString(36).slice(2, 10);
const sessionStore = createForkSessionStore(hana);

// DOM 元素引用
const agentListEl = document.getElementById('agent-list');
const agentCountEl = document.getElementById('agent-count');
const searchInput = document.getElementById('search-input');
const btnRefresh = document.getElementById('btn-refresh');

const sessionListEl = document.getElementById('session-list');
const sessionCountEl = document.getElementById('session-count');
const btnNewSession = document.getElementById('btn-new-session');
const btnRefreshSessions = document.getElementById('btn-refresh-sessions');
const sessionStatusEl = document.getElementById('session-status');

// 右键/更多浮层菜单元素
const sessionContextMenu = document.getElementById('session-context-menu');
const btnMenuRename = document.getElementById('session-menu-rename');
const btnMenuDelete = document.getElementById('session-menu-delete');

// 思考强度字典与助手独立配置
const THINKING_LEVEL_LABELS = {
  default: '默认',
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极限',
};

let models = [];

function getAgentReasoningEffort(agentId) {
  if (!agentId) return 'default';
  try {
    return localStorage.getItem(`fork_chat_agent_effort_${agentId}`) || 'default';
  } catch {
    return 'default';
  }
}

function setAgentReasoningEffort(agentId, effort) {
  if (!agentId) return;
  try {
    if (!effort || effort === 'default') {
      localStorage.removeItem(`fork_chat_agent_effort_${agentId}`);
    } else {
      localStorage.setItem(`fork_chat_agent_effort_${agentId}`, effort);
    }
  } catch {}
}

// 助手状态
let agents = [];
let loadError = '';
let activeAgentId = localStorage.getItem('fork_chat_active_agent_id') || 'hakimi';

// 画布跨面板通信与会话状态
let boundCanvasId = null;
let canvasState = {
  ready: false,
  busy: false,
  error: null,
  activeId: null,
};

let sessions = [];
let sessionListLoading = false;
let sessionListError = null;
let lastRenderKey = '';

// 右键菜单与重命名行内编辑状态
let menuState = {
  open: false,
  sessionId: null,
  triggerEl: null,
};

let renameState = {
  sessionId: null,
  inputValue: '',
  expectedTitle: '',
  requestId: null,
  submitting: false,
  isComposing: false,
};

let pendingRenderAfterComposition = false;
let pendingDeleteRequestId = null;

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -------------------------------------------------------------
// 1. 助手列表管理
// -------------------------------------------------------------

function renderAgentList() {
  if (loadError) {
    agentCountEl.textContent = '0';
    agentListEl.innerHTML = `<div class="empty-state" role="alert">${escapeHtml(loadError)}</div>`;
    return;
  }
  const query = searchInput.value.trim().toLowerCase();
  const filtered = agents.filter(a => {
    if (!query) return true;
    return (a.name || '').toLowerCase().includes(query) ||
           (a.id || '').toLowerCase().includes(query) ||
           (a.yuan || '').toLowerCase().includes(query) ||
           (a.model || '').toLowerCase().includes(query) ||
           (a.description || '').toLowerCase().includes(query);
  });

  agentCountEl.textContent = String(agents.length);

  if (filtered.length === 0) {
    agentListEl.innerHTML = `<div class="empty-state">${query ? '未找到匹配的助手' : '暂无可用助手'}</div>`;
    return;
  }

  agentListEl.innerHTML = '';
  filtered.forEach(a => {
    const card = document.createElement('div');
    const isActive = a.id === activeAgentId;
    card.className = `agent-card ${isActive ? 'active' : ''}`;
    card.id = `agent-${a.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    // 匹配该助手绑定模型的思考能力
    const matchedModel = models.find(m => m.id === a.model || m.ref === `${a.provider}/${a.model}` || m.ref === a.model);
    const supportsReasoning = Boolean(a.reasoning || matchedModel?.reasoning);
    const rawLevels = (Array.isArray(a.thinkingLevels) && a.thinkingLevels.length > 0)
      ? a.thinkingLevels
      : (Array.isArray(matchedModel?.thinkingLevels) ? matchedModel.thinkingLevels : []);
    const availableLevels = rawLevels.filter(lvl => typeof lvl === 'string' && lvl.trim());

    // 读取该助手独立保存的思考强度
    let currentEffort = getAgentReasoningEffort(a.id);
    const options = ['default', ...availableLevels];
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

    // 若该助手支持思考深度，内嵌独立的一级下拉选择菜单（纯白极简规范）
    if (supportsReasoning && availableLevels.length > 0) {
      const thinkingRow = document.createElement('div');
      thinkingRow.className = 'agent-thinking-row';
      thinkingRow.setAttribute('data-agent-id', a.id);

      const label = document.createElement('span');
      label.className = 'agent-thinking-label mono';
      label.textContent = '思考深度:';
      thinkingRow.appendChild(label);

      const select = document.createElement('select');
      select.className = 'thinking-select mono';
      select.id = `select-${a.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      select.setAttribute('aria-label', `${a.name || a.id}思考强度`);

      options.forEach(opt => {
        const option = document.createElement('option');
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

        // 若修改的是当前活跃的助手，即时同步并广播给画布
        if (a.id === activeAgentId) {
          localStorage.setItem('fork_chat_reasoning_effort', newEffort);
          channel.postMessage({
            type: 'REASONING_EFFORT_CHANGED',
            reasoningEffort: newEffort === 'default' ? null : newEffort,
            targetCanvasId: boundCanvasId || undefined,
          });
        }
      });

      thinkingRow.appendChild(select);
      card.appendChild(thinkingRow);
    }

    card.addEventListener('click', () => {
      activeAgentId = a.id;
      localStorage.setItem('fork_chat_active_agent_id', a.id);
      localStorage.setItem('fork_chat_active_agent_name', a.name || a.id);
      localStorage.setItem('fork_chat_active_agent_model', a.model || '');
      localStorage.setItem('fork_chat_active_agent_provider', a.provider || '');
      
      const agentEffort = getAgentReasoningEffort(a.id);
      localStorage.setItem('fork_chat_reasoning_effort', agentEffort);

      // 广播助手变更事件给主画布，附带该助手专属的思考强度
      channel.postMessage({
        type: 'AGENT_CHANGED',
        agent: a,
        reasoningEffort: agentEffort === 'default' ? null : agentEffort,
        targetCanvasId: boundCanvasId || undefined,
      });

      // 广播当前思考强度变更给主画布
      channel.postMessage({
        type: 'REASONING_EFFORT_CHANGED',
        reasoningEffort: agentEffort === 'default' ? null : agentEffort,
        targetCanvasId: boundCanvasId || undefined,
      });

      // 兼容广播模型变更，附带 targetCanvasId
      channel.postMessage({
        type: 'MODEL_CHANGED',
        model: {
          ref: a.provider && a.model ? `${a.provider}/${a.model}` : a.model,
          name: `${a.name} [${a.model}]`,
          id: a.model,
          provider: a.provider
        },
        targetCanvasId: boundCanvasId || undefined,
      });

      renderAgentList();
    });

    agentListEl.appendChild(card);
  });
}

async function loadAgents() {
  loadError = '';
  agentListEl.innerHTML = '<div class="empty-state">正在检索系统助手清单...</div>';
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

  // 最终选择优先最新 localStorage，避免初始化广播覆盖已恢复 session 的 agent
  const storedAgentId = localStorage.getItem('fork_chat_active_agent_id');
  const targetId = storedAgentId || activeAgentId;
  const current = agents.find(a => a.id === targetId) || agents[0];

  if (current) {
    activeAgentId = current.id;
    localStorage.setItem('fork_chat_active_agent_id', current.id);
    localStorage.setItem('fork_chat_active_agent_name', current.name || current.id);
    localStorage.setItem('fork_chat_active_agent_model', current.model || '');
    localStorage.setItem('fork_chat_active_agent_provider', current.provider || '');
    
    const agentEffort = getAgentReasoningEffort(current.id);
    localStorage.setItem('fork_chat_reasoning_effort', agentEffort);

    // 仅在尚未收到 canvas 状态时广播初始值；已绑定且有 canvasState 时不强行广播覆盖
    if (!boundCanvasId) {
      channel.postMessage({
        type: 'AGENT_CHANGED',
        agent: current,
        reasoningEffort: agentEffort === 'default' ? null : agentEffort,
        targetCanvasId: boundCanvasId || undefined,
      });
      channel.postMessage({
        type: 'REASONING_EFFORT_CHANGED',
        reasoningEffort: agentEffort === 'default' ? null : agentEffort,
        targetCanvasId: boundCanvasId || undefined,
      });
    }
  }

  renderAgentList();
}

searchInput.addEventListener('input', renderAgentList);
btnRefresh.addEventListener('click', loadAgents);

// -------------------------------------------------------------
// 2. 会话列表管理、右键菜单与跨面板通信
// -------------------------------------------------------------

function sendHello() {
  channel.postMessage({
    type: 'FORK_SESSION_HELLO',
    panelId,
  });
}

function updateStatusAndControls() {
  const isBound = Boolean(boundCanvasId);
  const isReady = Boolean(canvasState.ready);
  const isBusy = Boolean(canvasState.busy);
  const isSubmittingRename = Boolean(renameState.submitting);
  const canOperate = isBound && isReady && !isBusy && !isSubmittingRename;

  btnNewSession.disabled = !canOperate;
  btnRefreshSessions.disabled = isSubmittingRename;

  if (sessionListError) {
    sessionStatusEl.textContent = sessionListError;
    sessionStatusEl.className = 'session-status error';
  } else if (canvasState.error) {
    sessionStatusEl.textContent = `画布错误：${canvasState.error}`;
    sessionStatusEl.className = 'session-status error';
  } else if (!isBound || !isReady) {
    sessionStatusEl.textContent = '等待画布就绪...';
    sessionStatusEl.className = 'session-status warn';
  } else if (isBusy) {
    sessionStatusEl.textContent = '画布处理中...';
    sessionStatusEl.className = 'session-status warn';
  } else {
    const cur = sessionStatusEl.textContent;
    if (
      !cur.startsWith('重命名失败') &&
      !cur.startsWith('删除失败') &&
      !cur.startsWith('写入重命名意图失败') &&
      cur !== '等待主画布确认删除...'
    ) {
      sessionStatusEl.textContent = '';
      sessionStatusEl.className = 'session-status';
    }
  }

  if (!canOperate && menuState.open) {
    closeSessionMenu(false);
  }

  btnMenuRename.disabled = !canOperate;
  btnMenuDelete.disabled = !canOperate;

  const buttons = sessionListEl.querySelectorAll('button.session-item, button.session-more');
  buttons.forEach((btn) => {
    btn.disabled = !canOperate;
  });
}

// -------------------------------------------------------------
// 右键 / 更多定位菜单逻辑
// -------------------------------------------------------------

function openSessionMenu(sessionId, x, y, triggerEl) {
  if (renameState.submitting) return;
  const isBound = Boolean(boundCanvasId);
  const isReady = Boolean(canvasState.ready);
  const isBusy = Boolean(canvasState.busy);
  const canOperate = isBound && isReady && !isBusy;
  if (!canOperate || !sessionId) return;

  if (menuState.triggerEl && menuState.triggerEl !== triggerEl) {
    menuState.triggerEl.setAttribute('aria-expanded', 'false');
  }

  menuState.open = true;
  menuState.sessionId = sessionId;
  menuState.triggerEl = triggerEl || null;

  if (triggerEl) {
    triggerEl.setAttribute('aria-expanded', 'true');
  }

  sessionContextMenu.removeAttribute('hidden');

  // 限制在视口边界内，防溢出
  const rect = sessionContextMenu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const posX = Math.max(4, Math.min(x, vw - rect.width - 4));
  const posY = Math.max(4, Math.min(y, vh - rect.height - 4));

  sessionContextMenu.style.left = `${posX}px`;
  sessionContextMenu.style.top = `${posY}px`;

  // 默认焦点置于首项
  btnMenuRename.focus();
}

function closeSessionMenu(restoreFocus = true) {
  if (!menuState.open) return;
  sessionContextMenu.setAttribute('hidden', '');
  if (menuState.triggerEl) {
    menuState.triggerEl.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      try {
        menuState.triggerEl.focus();
      } catch {}
    }
  }
  menuState.open = false;
  menuState.sessionId = null;
  menuState.triggerEl = null;
}

// 外部点击与全局按键监听
window.addEventListener('resize', () => closeSessionMenu(false));
document.addEventListener('scroll', () => closeSessionMenu(false), true);
document.addEventListener('pointerdown', (e) => {
  if (
    menuState.open &&
    !sessionContextMenu.contains(e.target) &&
    (!menuState.triggerEl || !menuState.triggerEl.contains(e.target))
  ) {
    closeSessionMenu(false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (renameState.submitting) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (menuState.open) {
      e.preventDefault();
      e.stopPropagation();
      closeSessionMenu(true);
      return;
    }
  }
  if (menuState.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement === btnMenuRename) {
        btnMenuDelete.focus();
      } else {
        btnMenuRename.focus();
      }
    } else if (e.key === 'Tab') {
      closeSessionMenu(false);
    }
  }
});

// -------------------------------------------------------------
// 行内重命名编辑逻辑
// -------------------------------------------------------------

function startRename(sessionId) {
  if (renameState.submitting) return;
  const s = sessions.find((item) => item.id === sessionId);
  if (!s) return;
  closeSessionMenu(false);

  renameState.sessionId = sessionId;
  renameState.inputValue = s.title || '';
  renameState.expectedTitle = s.title || '';
  renameState.requestId = null;
  renameState.submitting = false;
  renameState.isComposing = false;

  lastRenderKey = '';
  renderSessionList();

  const input = document.getElementById('session-rename-input');
  if (input) {
    input.focus();
    input.select();
  }
}

function cancelRename() {
  if (renameState.submitting) return;
  const prevId = renameState.sessionId;
  renameState.sessionId = null;
  renameState.inputValue = '';
  renameState.expectedTitle = '';
  renameState.requestId = null;
  renameState.submitting = false;
  renameState.isComposing = false;

  sessionStatusEl.textContent = '';
  sessionStatusEl.className = 'session-status';

  lastRenderKey = '';
  renderSessionList();

  if (prevId) {
    const toFocus =
      document.getElementById(`session-more-${prevId}`) ||
      document.getElementById(`session-select-${prevId}`);
    if (toFocus) toFocus.focus();
  }
}

async function handleRenameSubmit() {
  if (renameState.submitting || !renameState.sessionId) return;
  const isBound = Boolean(boundCanvasId);
  const isReady = Boolean(canvasState.ready);
  const isBusy = Boolean(canvasState.busy);
  const canOperate = isBound && isReady && !isBusy;

  if (!canOperate) {
    sessionStatusEl.textContent = '当前画布忙或未就绪，无法保存重命名';
    sessionStatusEl.className = 'session-status warn';
    return;
  }

  const raw = renameState.inputValue;
  if (typeof raw !== 'string') {
    sessionStatusEl.textContent = '标题格式非法';
    sessionStatusEl.className = 'session-status error';
    return;
  }

  const compressed = raw.trim().replace(/\s+/g, ' ');
  if (compressed.length === 0) {
    sessionStatusEl.textContent = '标题不能为空';
    sessionStatusEl.className = 'session-status error';
    return;
  }
  if (compressed.length > 80) {
    sessionStatusEl.textContent = '标题长度不能超过80个字符';
    sessionStatusEl.className = 'session-status error';
    return;
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(compressed)) {
    sessionStatusEl.textContent = '标题不能包含控制字符';
    sessionStatusEl.className = 'session-status error';
    return;
  }

  const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const submission = {
    requestId,
    sessionId: renameState.sessionId,
    expectedTitle: renameState.expectedTitle,
    canvasId: boundCanvasId,
    title: compressed,
  };

  renameState.requestId = requestId;
  renameState.submitting = true;

  lastRenderKey = '';
  renderSessionList();

  // 1. 先通过 native owner-only SDK storage 写不可变 intent
  try {
    await writeRenameIntent(hana, {
      requestId: submission.requestId,
      sessionId: submission.sessionId,
      title: submission.title,
      expectedTitle: submission.expectedTitle,
    });
  } catch (err) {
    if (renameState.requestId === submission.requestId) {
      renameState.submitting = false;
      renameState.requestId = null;
    }
    sessionStatusEl.textContent = `写入重命名意图失败：${err.message || '未知错误'}`;
    sessionStatusEl.className = 'session-status error';
    lastRenderKey = '';
    renderSessionList();
    return;
  }

  // 2. 写 intent 成功后再通过 channel 发送命令（使用不可变快照，不读 mutable renameState）
  channel.postMessage({
    type: 'FORK_SESSION_COMMAND',
    command: 'rename',
    targetCanvasId: submission.canvasId,
    panelId,
    requestId: submission.requestId,
    sessionId: submission.sessionId,
  });
}

// -------------------------------------------------------------
// 会话删除命令触发
// -------------------------------------------------------------

function handleDeleteFromMenu(sessionId) {
  if (pendingDeleteRequestId) return;
  closeSessionMenu(false);
  if (renameState.submitting) return;
  const isBound = Boolean(boundCanvasId);
  const isReady = Boolean(canvasState.ready);
  const isBusy = Boolean(canvasState.busy);
  const canOperate = isBound && isReady && !isBusy;

  if (!canOperate || !sessionId) return;

  const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  pendingDeleteRequestId = requestId;
  sessionStatusEl.textContent = '等待主画布确认删除...';
  sessionStatusEl.className = 'session-status warn';

  // 仅发送命令，主画布打开原生 HTML dialog 二次确认，确认后 controller.remove
  channel.postMessage({
    type: 'FORK_SESSION_COMMAND',
    command: 'delete',
    requestId,
    panelId,
    sessionId,
    targetCanvasId: boundCanvasId,
  });
}

btnMenuRename.addEventListener('click', () => {
  if (menuState.sessionId) {
    startRename(menuState.sessionId);
  }
});

btnMenuDelete.addEventListener('click', () => {
  if (menuState.sessionId) {
    handleDeleteFromMenu(menuState.sessionId);
  }
});

// -------------------------------------------------------------
// 会话列表渲染
// -------------------------------------------------------------

function renderSessionList() {
  updateStatusAndControls();

  if (sessionListLoading && sessions.length === 0) {
    sessionListEl.innerHTML = '<div class="empty-state">正在读取会话...</div>';
    lastRenderKey = '';
    return;
  }

  if (sessionListError && sessions.length === 0) {
    sessionListEl.innerHTML = `<div class="empty-state" role="alert">${escapeHtml(sessionListError)}</div>`;
    lastRenderKey = '';
    return;
  }

  if (sessions.length === 0) {
    sessionListEl.innerHTML = '<div class="empty-state">暂无会话记录</div>';
    lastRenderKey = '';
    return;
  }

  const isBound = Boolean(boundCanvasId);
  const isReady = Boolean(canvasState.ready);
  const isBusy = Boolean(canvasState.busy);
  const canOperate = isBound && isReady && !isBusy;
  const currentActiveId = canvasState.activeId;

  // 缓存 renderKey；当处于编辑状态时由 renameState 驱动更新
  const renderKey = [
    sessions.map((s) => `${s.id}:${s.title}:${s.cardCount}:${s.id === currentActiveId}`).join('|'),
    canOperate,
    renameState.sessionId,
    renameState.submitting,
  ].join('##');

  if (renderKey === lastRenderKey) {
    return;
  }

  const existingInput = document.getElementById('session-rename-input');
  let hadEditorFocus = false;
  let caretStart = null;
  let caretEnd = null;

  if (existingInput && existingInput.getAttribute('data-session-id') === renameState.sessionId) {
    hadEditorFocus = document.activeElement === existingInput;
    if (renameState.isComposing) {
      pendingRenderAfterComposition = true;
      return;
    }
    caretStart = existingInput.selectionStart;
    caretEnd = existingInput.selectionEnd;
    renameState.inputValue = existingInput.value;
  }

  const focusedEl = document.activeElement;
  const focusedControlId = menuState.open ? menuState.triggerEl?.id
    : focusedEl && sessionListEl.contains(focusedEl) ? focusedEl.id : null;
  closeSessionMenu(false);

  lastRenderKey = renderKey;

  sessionListEl.innerHTML = '';
  sessions.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-session-id', s.id);

    if (renameState.sessionId === s.id) {
      // 行内编辑表单
      const form = document.createElement('form');
      form.className = 'session-rename-form';
      form.onsubmit = (e) => e.preventDefault();

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'session-rename-input';
      input.className = 'session-rename-input';
      input.maxLength = 80;
      input.value = renameState.inputValue;
      input.disabled = renameState.submitting;
      input.setAttribute('aria-label', '修改会话标题');
      input.setAttribute('data-session-id', s.id);

      input.addEventListener('compositionstart', () => {
        if (renameState.sessionId !== s.id) return;
        renameState.isComposing = true;
      });
      input.addEventListener('compositionend', (e) => {
        if (renameState.sessionId !== s.id) return;
        renameState.isComposing = false;
        renameState.inputValue = e.target.value;
        if (pendingRenderAfterComposition) {
          pendingRenderAfterComposition = false;
          renderSessionList();
        }
      });
      input.addEventListener('input', (e) => {
        if (renameState.sessionId !== s.id) return;
        renameState.inputValue = e.target.value;
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (e.isComposing || renameState.submitting) return; // 忽略输入法 composing 或 submitting
          e.preventDefault();
          handleRenameSubmit();
        } else if (e.key === 'Escape') {
          if (renameState.submitting) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          cancelRename();
        }
      });

      const btnSave = document.createElement('button');
      btnSave.type = 'button';
      btnSave.id = 'session-rename-save';
      btnSave.className = 'session-rename-btn session-rename-btn-save';
      btnSave.textContent = renameState.submitting ? '保存中' : '保存';
      btnSave.disabled = renameState.submitting;
      btnSave.addEventListener('click', () => {
        if (renameState.submitting) return;
        handleRenameSubmit();
      });

      const btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.id = 'session-rename-cancel';
      btnCancel.className = 'session-rename-btn';
      btnCancel.textContent = '取消';
      btnCancel.disabled = renameState.submitting;
      btnCancel.addEventListener('click', () => {
        if (renameState.submitting) return;
        cancelRename();
      });

      form.appendChild(input);
      form.appendChild(btnSave);
      form.appendChild(btnCancel);
      row.appendChild(form);
    } else {
      // 常规行：原选择按钮 + 独立更多按钮（同级）
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = `session-select-${s.id}`;
      const isActive = s.id === currentActiveId;
      btn.className = `session-item ${isActive ? 'active' : ''}`;
      btn.setAttribute('data-session-id', s.id);
      btn.disabled = !canOperate;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-item-title';
      titleSpan.textContent = s.title || '新会话';

      const badgeSpan = document.createElement('span');
      badgeSpan.className = 'session-item-badge mono';
      badgeSpan.textContent = `${s.cardCount ?? 0} 卡`;

      btn.appendChild(titleSpan);
      btn.appendChild(badgeSpan);

      btn.addEventListener('click', () => {
        if (renameState.submitting) return;
        if (!canOperate || s.id === canvasState.activeId) return;
        channel.postMessage({
          type: 'FORK_SESSION_COMMAND',
          targetCanvasId: boundCanvasId,
          command: 'switch',
          sessionId: s.id,
        });
      });

      const btnMore = document.createElement('button');
      btnMore.type = 'button';
      btnMore.id = `session-more-${s.id}`;
      btnMore.className = 'session-more';
      btnMore.textContent = '⋯';
      btnMore.disabled = !canOperate;
      btnMore.setAttribute('aria-label', `会话操作：${s.title || '新会话'}`);
      btnMore.setAttribute('aria-haspopup', 'menu');
      btnMore.setAttribute('aria-controls', 'session-context-menu');
      btnMore.setAttribute('aria-expanded', 'false');

      // 点击更多打开菜单，阻止冒泡，禁止触发会话切换
      btnMore.addEventListener('click', (e) => {
        e.stopPropagation();
        if (renameState.submitting || !canOperate) return;
        const rect = btnMore.getBoundingClientRect();
        openSessionMenu(s.id, rect.right, rect.bottom + 2, btnMore);
      });

      // 右键 contextmenu 打开同一定位菜单
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (renameState.submitting || !canOperate) return;
        openSessionMenu(s.id, e.clientX, e.clientY, btnMore);
      });

      row.appendChild(btn);
      row.appendChild(btnMore);
    }

    sessionListEl.appendChild(row);
  });

  // 末尾恢复焦点：不要抢用户正在搜索框等其他控件的焦点，只当原 editor 聚焦且非 disabled 时恢复
  if (renameState.sessionId) {
    const input = document.getElementById('session-rename-input');
    if (input && !input.disabled && hadEditorFocus) {
      input.focus();
      if (caretStart !== null && caretEnd !== null) {
        try {
          input.setSelectionRange(caretStart, caretEnd);
        } catch {}
      }
    }
  } else if (focusedControlId) {
    const toFocus = document.getElementById(focusedControlId);
    if (toFocus) toFocus.focus();
  }
}

let sessionLoadSequence = 0;
async function loadSessions() {
  const sequence = ++sessionLoadSequence;
  sessionListLoading = true;
  sessionListError = null;
  renderSessionList();

  try {
    const res = await sessionStore.list();
    if (sequence !== sessionLoadSequence) return;
    sessions = res.sessions || [];
    if (res.activeId && !canvasState.activeId) {
      canvasState.activeId = res.activeId;
    }
    sessionCountEl.textContent = String(sessions.length);
  } catch (err) {
    if (sequence !== sessionLoadSequence) return;
    sessions = [];
    sessionListError = `会话读取失败：${err.message || '未知错误'}`;
    sessionCountEl.textContent = '0';
  } finally {
    if (sequence === sessionLoadSequence) {
      sessionListLoading = false;
      renderSessionList();
    }
  }
}

// 按钮交互
btnNewSession.addEventListener('click', () => {
  if (renameState.submitting) return;
  if (!boundCanvasId || !canvasState.ready || canvasState.busy) return;
  channel.postMessage({
    type: 'FORK_SESSION_COMMAND',
    targetCanvasId: boundCanvasId,
    command: 'new',
  });
});

btnRefreshSessions.addEventListener('click', () => {
  if (renameState.submitting) return;
  closeSessionMenu(false);
  cancelRename();
  if (boundCanvasId) {
    channel.postMessage({
      type: 'FORK_SESSION_COMMAND',
      targetCanvasId: boundCanvasId,
      command: 'refresh',
    });
  }
  boundCanvasId = null;
  sendHello();
  loadSessions();
});

// 监听画布广播
channel.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'FORK_SESSION_STATE') {
    // 过滤目标 panel
    if (data.targetPanelId && data.targetPanelId !== panelId) {
      return;
    }

    // 绑定首个响应的 canvasId，之后只接同 canvas
    if (!boundCanvasId) {
      boundCanvasId = data.canvasId;
    } else if (boundCanvasId !== data.canvasId) {
      return;
    }

    canvasState.ready = Boolean(data.ready);
    canvasState.busy = Boolean(data.busy);
    canvasState.error = data.error || null;
    if (data.activeId !== undefined) {
      canvasState.activeId = data.activeId;
    }

    // 恢复 session 中绑定的 agent：更新 activeAgentId / localStorage / 高亮，不反向发 AGENT_CHANGED 避免循环
    if (data.agent && data.agent.id) {
      const restoredId = data.agent.id;
      if (data.agent.reasoningEffort !== undefined) {
        setAgentReasoningEffort(restoredId, data.agent.reasoningEffort || 'default');
      }
      if (restoredId !== activeAgentId) {
        activeAgentId = restoredId;
        localStorage.setItem('fork_chat_active_agent_id', restoredId);
        if (data.agent.name) localStorage.setItem('fork_chat_active_agent_name', data.agent.name);
        if (data.agent.model) localStorage.setItem('fork_chat_active_agent_model', data.agent.model);
        if (data.agent.provider) localStorage.setItem('fork_chat_active_agent_provider', data.agent.provider);
      }
      renderAgentList();
    }

    renderSessionList();
  } else if (data.type === 'FORK_SESSION_RESULT') {
    // 严格限制仅响应本 panel 与绑定 canvas 的结果
    if (data.targetPanelId !== panelId || data.canvasId !== boundCanvasId) return;

    if (data.command === 'rename') {
      // 匹配 editor requestId
      if (renameState.requestId && data.requestId === renameState.requestId) {
        renameState.submitting = false;
        if (data.ok) {
          // 成功关闭编辑重读 list
          renameState.sessionId = null;
          renameState.inputValue = '';
          renameState.expectedTitle = '';
          renameState.requestId = null;
          sessionStatusEl.textContent = '';
          sessionStatusEl.className = 'session-status';
          loadSessions();
        } else {
          // 失败保留文字允许取消后重试，说明错误
          const errorMsg = data.error || '重命名失败';
          sessionStatusEl.textContent = `重命名失败：${errorMsg}`;
          sessionStatusEl.className = 'session-status error';
          lastRenderKey = '';
          renderSessionList();
        }
      }
    } else if (data.command === 'delete') {
      // delete 严格匹配 pendingDeleteRequestId，避免其他面板/未知 requestId 结果改自己状态
      if (!pendingDeleteRequestId || data.requestId !== pendingDeleteRequestId) {
        return;
      }
      pendingDeleteRequestId = null;

      if (data.cancelled) {
        // cancel 正常无错误
        sessionStatusEl.textContent = '';
        sessionStatusEl.className = 'session-status';
      } else if (data.ok) {
        sessionStatusEl.textContent = '';
        sessionStatusEl.className = 'session-status';
        loadSessions();
      } else {
        const errorMsg = data.error || '删除失败';
        sessionStatusEl.textContent = `删除失败：${errorMsg}`;
        sessionStatusEl.className = 'session-status error';
      }
    }
  }
});

// 监听宿主存储变更
sessionStore.watch(() => {
  loadSessions();
});

// 初始化
hana.ready();
loadAgents();
sendHello();
loadSessions();

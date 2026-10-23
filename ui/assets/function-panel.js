import { hana } from './sdk.js';
import { requestHost } from './host-api.js';
import { createForkSessionStore } from './fork-session-store.js';
import { writeRenameIntent } from './fork-session-commands.js';
import { createAgentListController } from './function-agents.js';
import { createSessionListController } from './function-sessions.js';

const channel = new BroadcastChannel('fork-chat-bus');
const panelId = 'panel_' + Math.random().toString(36).slice(2, 10);

// 面板被关掉或换页时把通道解绑。侧边栏虽然多半随页面一起销毁，
// 但在后台标签页里它可能比主画布活得更久，留着就是一份白占的监听。
let functionPanelReleased = false;
let sessionStoreUnsubscribe = null;

function invokeUnsubscribe(unsub) {
  if (typeof unsub !== 'function') return;
  try {
    const res = unsub();
    if (res && typeof res.then === 'function') {
      res.catch(() => {});
    }
  } catch {}
}

function releaseFunctionPanel() {
  if (functionPanelReleased) return;
  functionPanelReleased = true;
  const unsub = sessionStoreUnsubscribe;
  sessionStoreUnsubscribe = null;
  try {
    if (unsub) {
      invokeUnsubscribe(unsub);
    }
  } finally {
    try { channel.close(); } catch {}
  }
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', releaseFunctionPanel);
  window.addEventListener('beforeunload', releaseFunctionPanel);
}
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

// 画布跨面板通信与状态
let boundCanvasId = null;
const canvasState = {
  ready: false,
  busy: false,
  error: null,
  activeId: null,
};

function sendHello() {
  channel.postMessage({
    type: 'FORK_SESSION_HELLO',
    panelId,
  });
}

// 实例化助手管理控制器
const agentController = createAgentListController({
  hana,
  requestHost,
  channel,
  getBoundCanvasId: () => boundCanvasId,
  agentListEl,
  agentCountEl,
  searchInput,
  btnRefresh,
  document,
  storage: typeof localStorage !== 'undefined' ? localStorage : null,
});

// 实例化会话管理控制器
const sessionController = createSessionListController({
  hana,
  sessionStore,
  writeRenameIntent,
  panelId,
  channel,
  getBoundCanvasId: () => boundCanvasId,
  setBoundCanvasId: (id) => { boundCanvasId = id; },
  getCanvasState: () => canvasState,
  sendHello,
  onAgentRestored: (agent) => {
    agentController.restoreAgent(agent);
  },
  sessionListEl,
  sessionCountEl,
  sessionStatusEl,
  btnNewSession,
  btnRefreshSessions,
  sessionContextMenu,
  btnMenuRename,
  btnMenuDelete,
  document,
  window: typeof window !== 'undefined' ? window : null,
});

// 监听画布广播
channel.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'FORK_SESSION_STATE') {
    sessionController.handleSessionState(data);
  } else if (data.type === 'FORK_SESSION_RESULT') {
    sessionController.handleSessionResult(data);
  }
});

// 监听宿主存储变更
const watchResult = sessionStore.watch(() => {
  if (functionPanelReleased) return;
  sessionController.loadSessions();
});

if (typeof watchResult === 'function') {
  if (functionPanelReleased) {
    invokeUnsubscribe(watchResult);
  } else {
    sessionStoreUnsubscribe = watchResult;
  }
} else if (watchResult && typeof watchResult.then === 'function') {
  watchResult
    .then(unsub => {
      if (typeof unsub !== 'function') return;
      if (functionPanelReleased) {
        invokeUnsubscribe(unsub);
      } else {
        sessionStoreUnsubscribe = unsub;
      }
    })
    .catch(() => {});
}

// ---- 云端解析设置（App 自管） ----
const parserEls = {
  state: document.getElementById('parser-state'),
  enabled: document.getElementById('parser-enabled'),
  token: document.getElementById('parser-token'),
  tokenNote: document.getElementById('parser-token-note'),
  model: document.getElementById('parser-model'),
  language: document.getElementById('parser-language'),
  formula: document.getElementById('parser-formula'),
  table: document.getElementById('parser-table'),
  ocr: document.getElementById('parser-ocr'),
  timeout: document.getElementById('parser-timeout'),
  save: document.getElementById('btn-parser-save'),
  status: document.getElementById('parser-status'),
};

function setParserStatus(text, tone = '') {
  if (!parserEls.status) return;
  parserEls.status.textContent = text;
  parserEls.status.className = `parser-status${tone ? ` is-${tone}` : ''}`;
}

function setParserBadge(enabled, ready) {
  if (!parserEls.state) return;
  const text = !enabled ? '关' : ready ? '就绪' : '缺 Token';
  parserEls.state.textContent = text;
  try {
    localStorage.setItem('fork_chat_parser_badge', text);
  } catch {}
}

async function loadParserSettings() {
  if (!parserEls.enabled) return;
  try {
    const res = await requestHost(hana, '/api/mineru/settings');
    const data = await res.json();
    parserEls.enabled.checked = Boolean(data.enabled);
    parserEls.model.value = data.modelVersion || 'vlm';
    parserEls.language.value = data.language || 'ch';
    parserEls.formula.checked = data.enableFormula !== false;
    parserEls.table.checked = data.enableTable !== false;
    parserEls.ocr.checked = Boolean(data.isOcr);
    parserEls.timeout.value = data.timeoutSeconds || 600;
    parserEls.token.value = '';
    parserEls.token.placeholder = data.hasToken ? '留空则不修改' : '在 mineru.net 个人中心申请';
    parserEls.tokenNote.textContent = data.hasToken ? `已配置 ${data.tokenHint || ''}`.trim() : '未配置';
    setParserBadge(data.enabled, data.ready);

    if (!data.networkAvailable) {
      setParserStatus('宿主网络出口不可用', 'error');
    } else if (data.ready) {
      setParserStatus('本地读不出时会自动升级到云端');
    } else if (data.enabled) {
      setParserStatus('已启用，还缺 API Token', 'error');
    } else {
      setParserStatus('未启用，所有解析都在本机完成');
    }
  } catch (err) {
    setParserStatus(`读取失败：${err.message || String(err)}`, 'error');
  }
}

async function saveParserSettings() {
  if (!parserEls.enabled) return;
  const token = parserEls.token.value.trim();
  const payload = {
    enabled: parserEls.enabled.checked,
    modelVersion: parserEls.model.value,
    language: parserEls.language.value,
    enableFormula: parserEls.formula.checked,
    enableTable: parserEls.table.checked,
    isOcr: parserEls.ocr.checked,
    timeoutSeconds: Number(parserEls.timeout.value) || 600,
  };
  if (token) payload.token = token;
  setParserStatus('正在保存…');
  try {
    const res = await requestHost(hana, '/api/mineru/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '保存失败');
    parserEls.token.value = '';
    parserEls.token.placeholder = data.hasToken ? '留空则不修改' : '在 mineru.net 个人中心申请';
    parserEls.tokenNote.textContent = data.hasToken ? `已配置 ${data.tokenHint || ''}`.trim() : '未配置';
    setParserBadge(data.enabled, data.ready);
    setParserStatus(data.ready ? '已保存 · 云端解析就绪' : data.enabled ? '已保存 · 还缺 Token' : '已保存 · 已关闭', 'ok');
  } catch (err) {
    setParserStatus(`保存失败：${err.message || String(err)}`, 'error');
  }
}

parserEls.save?.addEventListener('click', saveParserSettings);

// 分组折叠偏好记忆（localStorage）
const agentGroupEl = document.getElementById('agent-group');
const sessionGroupEl = document.getElementById('session-group');
const parserGroupEl = document.getElementById('parser-group');

function initGroupAccordionState() {
  if (agentGroupEl) {
    const saved = localStorage.getItem('fork_chat_agent_group_open');
    // 默认收起（false），除非用户主动展开过
    agentGroupEl.open = saved !== null ? saved === 'true' : false;
    agentGroupEl.addEventListener('toggle', () => {
      try {
        localStorage.setItem('fork_chat_agent_group_open', String(agentGroupEl.open));
      } catch {}
    });
  }

  if (sessionGroupEl) {
    const saved = localStorage.getItem('fork_chat_session_group_open');
    // 会话列表默认展开（true）
    sessionGroupEl.open = saved !== null ? saved === 'true' : true;
    sessionGroupEl.addEventListener('toggle', () => {
      try {
        localStorage.setItem('fork_chat_session_group_open', String(sessionGroupEl.open));
      } catch {}
    });
  }

  if (parserGroupEl) {
    const saved = localStorage.getItem('fork_chat_parser_group_open');
    parserGroupEl.open = saved !== null ? saved === 'true' : false;
    parserGroupEl.addEventListener('toggle', () => {
      try {
        localStorage.setItem('fork_chat_parser_group_open', String(parserGroupEl.open));
      } catch {}
    });
  }

  try {
    const savedBadge = localStorage.getItem('fork_chat_parser_badge');
    if (savedBadge && parserEls.state) {
      parserEls.state.textContent = savedBadge;
    }
  } catch {}
}

// 展开时刷新设置
document.getElementById('parser-group')?.addEventListener('toggle', (event) => {
  if (event.target.open) loadParserSettings();
});

// 初始化
initGroupAccordionState();
hana.ready();
agentController.loadAgents();
sendHello();
sessionController.loadSessions();
loadParserSettings();

import { hana } from './sdk.js';

const channel = new BroadcastChannel('fork-chat-bus');
const modelListEl = document.getElementById('model-list');
const modelCountEl = document.getElementById('model-count');
const searchInput = document.getElementById('search-input');
const btnRefresh = document.getElementById('btn-refresh');

let models = [];
let activeModelRef = localStorage.getItem('fork_chat_active_model_ref') || 'agent-default';

// 渲染模型列表
function renderModelList() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = models.filter(m => {
    if (!query) return true;
    return (m.name || '').toLowerCase().includes(query) ||
           (m.id || '').toLowerCase().includes(query) ||
           (m.provider || '').toLowerCase().includes(query);
  });

  modelCountEl.textContent = String(models.length);

  if (filtered.length === 0) {
    modelListEl.innerHTML = `<div class="empty-state">${query ? '未找到匹配的模型' : '暂无可用模型'}</div>`;
    return;
  }

  modelListEl.innerHTML = '';
  filtered.forEach(m => {
    const card = document.createElement('div');
    const isActive = m.ref === activeModelRef || (activeModelRef === 'agent-default' && m.isDefault);
    card.className = `model-card ${isActive ? 'active' : ''}`;
    card.id = `m-${m.ref.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    card.innerHTML = `
      <div class="model-card-top">
        <span class="model-name">
          <span class="dot-indicator"></span>
          ${escapeHtml(m.name || m.id)}
        </span>
        ${isActive ? '<span class="active-tag">使用中</span>' : ''}
      </div>
      <div class="model-meta">
        <span class="model-provider-badge">${escapeHtml(m.provider || 'HOST')}</span>
        <span class="mono">${escapeHtml(m.id)}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      activeModelRef = m.ref;
      localStorage.setItem('fork_chat_active_model_ref', m.ref);
      localStorage.setItem('fork_chat_active_model_name', m.name || m.id);
      channel.postMessage({ type: 'MODEL_CHANGED', model: m });
      renderModelList();
    });

    modelListEl.appendChild(card);
  });
}

// 从应用后端或宿主加载可用模型
async function loadModels() {
  modelListEl.innerHTML = '<div class="empty-state">正在检索宿主接入的模型清单...</div>';
  try {
    const res = await fetch(hana.api.url('/api/models'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.models)) {
      models = data.models;
    } else {
      throw new Error(data.error || '无法获取模型列表');
    }
  } catch (err) {
    // 回退兜底：如果后端尚未就绪或在离线测试，载入环境已确认的主力模型
    models = [
      {
        ref: 'gemini/gemini-3.8-flash-high',
        provider: 'gemini',
        id: 'gemini-3.8-flash-high',
        name: 'Gemini 3.8 Flash High',
        isDefault: true
      },
      {
        ref: 'deepseek/deepseek-chat',
        provider: 'deepseek',
        id: 'deepseek-chat',
        name: 'DeepSeek V3 / Chat'
      },
      {
        ref: 'deepseek/deepseek-reasoner',
        provider: 'deepseek',
        id: 'deepseek-reasoner',
        name: 'DeepSeek R1 / Reasoner'
      },
      {
        ref: 'openai/gpt-5.6-luna',
        provider: 'openai',
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna'
      }
    ];
  }

  // 默认如果未指定，且存在默认模型，则广播一次
  const current = models.find(m => m.ref === activeModelRef) || models[0];
  if (current) {
    activeModelRef = current.ref;
    localStorage.setItem('fork_chat_active_model_ref', current.ref);
    localStorage.setItem('fork_chat_active_model_name', current.name || current.id);
    channel.postMessage({ type: 'MODEL_CHANGED', model: current });
  }

  renderModelList();
}

searchInput.addEventListener('input', renderModelList);
btnRefresh.addEventListener('click', loadModels);

loadModels();
hana.ready();

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

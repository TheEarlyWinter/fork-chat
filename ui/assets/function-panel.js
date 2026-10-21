import { hana } from './sdk.js';

const channel = new BroadcastChannel('fork-chat-bus');
const agentListEl = document.getElementById('agent-list');
const agentCountEl = document.getElementById('agent-count');
const searchInput = document.getElementById('search-input');
const btnRefresh = document.getElementById('btn-refresh');

let agents = [];
let activeAgentId = localStorage.getItem('fork_chat_active_agent_id') || 'hakimi';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 渲染助手列表
function renderAgentList() {
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

    card.addEventListener('click', () => {
      activeAgentId = a.id;
      localStorage.setItem('fork_chat_active_agent_id', a.id);
      localStorage.setItem('fork_chat_active_agent_name', a.name || a.id);
      localStorage.setItem('fork_chat_active_agent_model', a.model || '');
      localStorage.setItem('fork_chat_active_agent_provider', a.provider || '');
      
      // 广播助手变更事件给主画布
      channel.postMessage({
        type: 'AGENT_CHANGED',
        agent: a
      });

      // 兼容广播模型变更
      channel.postMessage({
        type: 'MODEL_CHANGED',
        model: {
          ref: a.provider && a.model ? `${a.provider}/${a.model}` : a.model,
          name: `${a.name} [${a.model}]`,
          id: a.model,
          provider: a.provider
        }
      });

      renderAgentList();
    });

    agentListEl.appendChild(card);
  });
}

// 加载系统助手清单
async function loadAgents() {
  agentListEl.innerHTML = '<div class="empty-state">正在检索系统助手清单...</div>';
  try {
    const res = hana.api?.fetch
      ? await hana.api.fetch('api/agents')
      : await fetch(hana.api.url('api/agents'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.agents) && data.agents.length > 0) {
      agents = data.agents;
    } else {
      throw new Error(data.error || '未返回有效助手列表');
    }
  } catch (err) {
    // 离线/回退兜底：完整加载当前系统确认的 7 位助手全息数据
    agents = [
      {
        id: "hakimi",
        name: "Hakimi",
        yuan: "butter",
        model: "gemini-3.8-flash-high",
        provider: "gemini",
        description: "哈基米是催花清雨的可靠个人助手，专注能干、直截了当，外冷内热而富有共情。擅长知识讲解、复杂问题拆解与代码工程。"
      },
      {
        id: "cixiaogui",
        name: "星见凛",
        yuan: "kong",
        model: "gpt-5.6-luna",
        provider: "openai-codex",
        description: "星见凛是催花清雨的专属AI助手，私立天穹学园特优生兼科学部副部长。表面毒舌小恶魔，实则温柔傲娇，擅长哲学逻辑与深度学术剖析。"
      },
      {
        id: "hanako",
        name: "小鲸鱼",
        yuan: "hanako",
        model: "deepseek-flash",
        provider: "deepseek",
        description: "小鲸鱼是催花清雨的温柔大姐姐型助手。说话温和治愈，能从底层原理把复杂的东西讲清楚，懂得在疲惫时放慢节奏倾听。"
      },
      {
        id: "agent-mqb7zal0",
        name: "客服小祥",
        yuan: "ming",
        model: "gemini-3.8-flash-high",
        provider: "gemini",
        description: "理性优先的分析型助手，专长于知识库管理、信息检索验证与交叉引用，风格冷静克制，逻辑极其严密。"
      },
      {
        id: "sol-architect",
        name: "Sol 架构师",
        yuan: "ming",
        model: "gpt-6.1-sol",
        provider: "openai-codex",
        description: "架构与系统设计专员。专注于需求深度分析、系统拓扑架构设计与接口规范拆解，具有高度确定性。"
      },
      {
        id: "luna-tester",
        name: "Luna 质检测试",
        yuan: "ming",
        model: "gpt-5.6-luna",
        provider: "openai-codex",
        description: "代码测试与质量检验专员。专注于测试驱动开发（TDD）、边界异常挖掘与代码缺陷排查。"
      },
      {
        id: "gemini-coder",
        name: "Gemini 编码工程",
        yuan: "ming",
        model: "gemini-3.8-flash-high",
        provider: "gemini",
        description: "核心代码落地与工程实现专员。按方案快速实现高质量源代码、构建工程环境及重构复杂逻辑。"
      }
    ];
  }

  // 校验当前激活助手
  const current = agents.find(a => a.id === activeAgentId) || agents[0];
  if (current) {
    activeAgentId = current.id;
    localStorage.setItem('fork_chat_active_agent_id', current.id);
    localStorage.setItem('fork_chat_active_agent_name', current.name || current.id);
    localStorage.setItem('fork_chat_active_agent_model', current.model || '');
    localStorage.setItem('fork_chat_active_agent_provider', current.provider || '');
    
    // 初始化广播一次
    channel.postMessage({
      type: 'AGENT_CHANGED',
      agent: current
    });
  }

  renderAgentList();
}

searchInput.addEventListener('input', renderAgentList);
btnRefresh.addEventListener('click', loadAgents);

loadAgents();

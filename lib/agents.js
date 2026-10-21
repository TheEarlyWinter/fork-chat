// Agent metadata is a host-owned resource. AppHost deliberately cannot read
// ~/.hanako/agents; use only the authorized, credential-free public projection.
export function createAgentDirectory(sdk) {
  async function getProfile(agentId) {
    if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('缺少有效助手 ID');
    const { profile } = await sdk.agents.profile({ agentId, scope: 'all' });
    if (!profile || profile.id !== agentId) throw new Error('宿主未返回目标助手资料');
    const chat = profile.models?.chat;
    const name = profile.name || agentId;
    const description = profile.description || '';
    return {
      id: agentId,
      name,
      yuan: profile.yuan || 'unknown',
      model: typeof chat?.id === 'string' ? chat.id.trim() : '',
      provider: typeof chat?.provider === 'string' ? chat.provider.trim() : '',
      description,
      systemPrompt: profile.identity || `你是 ${name}。${description}`,
    };
  }

  async function list() {
    const result = await sdk.agents.list({ scope: 'all', lifecycle: 'active' });
    if (!Array.isArray(result?.agents)) throw new Error('宿主返回的助手列表无效');
    return Promise.all(result.agents.map(async agent => {
      const { systemPrompt, ...profile } = await getProfile(agent.id);
      return { ...profile, isCurrent: Boolean(agent.isCurrent) };
    }));
  }

  return { getProfile, list };
}

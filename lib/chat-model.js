/** The only chat module that adapts the host model SDK. Preserve method receiver identity. */
export function createChatModelPort(modelsOrGetter) {
  const getModels = typeof modelsOrGetter === 'function' ? modelsOrGetter : () => modelsOrGetter;
  return {
    streamEvents(input, options) {
      const models = getModels();
      if (typeof models?.streamEvents !== 'function') throw { code: 'MODELS_NOT_AVAILABLE', message: 'SDK 模型流推理接口不可用' };
      return models.streamEvents(input, options);
    },
    cancel(requestId) {
      const models = getModels();
      return typeof models?.cancel === 'function' ? models.cancel(requestId) : undefined;
    },
  };
}

const DEFAULT_SYSTEM_PROMPT = '你是专业、敏锐、逻辑严密的智能分析助手。回答要条理清晰、直击核心、不讲套话废话。';

function waitForProfile(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

/** Resolves the model binding without HTTP responses or ownership of a live request. */
export async function resolveChatBinding(body, { getAgentFullProfile, signal }) {
  let systemPrompt = body?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (body?.agentId) {
    if (typeof getAgentFullProfile !== 'function') throw { code: 'AGENT_PROFILE_UNAVAILABLE', message: '宿主未提供助手资料查询服务', status: 422 };
    const profile = await waitForProfile(getAgentFullProfile(body.agentId), signal);
    if (!profile) throw { code: 'AGENT_PROFILE_UNAVAILABLE', message: `宿主未返回助手 ${body.agentId} 资料`, status: 422 };
    const provider = typeof profile.provider === 'string' ? profile.provider.trim() : '';
    const model = typeof profile.model === 'string' ? profile.model.trim() : '';
    if (!provider || !model) throw { code: 'AGENT_MODEL_UNCONFIGURED', message: `助手 ${body.agentId} 未配置有效对话模型`, status: 422 };
    if (profile.systemPrompt) systemPrompt = `${profile.systemPrompt}\n\n[回答指引]：请完全沉浸并严格保持你的身份设定、语言习惯、语气和性格特征，针对用户的对话内容给出真实、自然的回应。`;
    return { provider, model, systemPrompt };
  }
  if (typeof body?.modelRef === 'string' && body.modelRef.includes('/')) {
    const slash = body.modelRef.indexOf('/');
    const provider = body.modelRef.slice(0, slash).trim(), model = body.modelRef.slice(slash + 1).trim();
    if (provider && model) return { provider, model, systemPrompt };
    throw { code: 'INVALID_MODEL_REF', message: 'modelRef 格式必须为 provider/model', status: 400, provider, model };
  }
  throw { code: 'INVALID_MODEL_REF', message: '必须指定有效 agentId 或 modelRef (格式 provider/model)', status: 400 };
}

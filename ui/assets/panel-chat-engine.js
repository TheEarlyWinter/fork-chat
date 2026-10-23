import { parseAssistantOutput } from './assistant-output.js';

/**
 * 流式请求引擎。
 *
 * 它只负责「一次问答从发出到落定」这一段：占位消息、上下文取用、
 * 事件回调、终止判定、以及各种迟到回调的丢弃。
 * 画布怎么画、会话怎么存，一律由外面注入。
 *
 * 这里最容易出事的地方不是请求本身，是「回调来晚了」：
 * 用户可能已经切了会话、关了卡片、或者同一张卡重发了一次。
 * 所以三重检查必须同时成立才允许写回，缺一条就会串内容。
 */
export function createChatEngine(deps = {}) {
  for (const key of [
    'runChat', 'ChatError', 'safeDetail', 'getCards', 'getSession', 'getAgent',
    'getReasoningEffort', 'getAgentReasoningEffort', 'buildChainContext', 'getIsDisposed',
    'canMutateCanvas', 'uniqueId', 'paintMessage', 'renderCards', 'scheduleSave', 'cardParentIds',
  ]) {
    if (typeof deps[key] !== 'function') throw new TypeError(`createChatEngine: ${key} must be a function`);
  }
  if (!deps.activeRequests || ['get', 'set', 'has', 'delete', 'values', 'clear'].some(key => typeof deps.activeRequests[key] !== 'function')) {
    throw new TypeError('createChatEngine: activeRequests must be Map-like');
  }
  const {
    hana,
    runChat,
    ChatError,
    safeDetail,
    activeRequests,
    getCards,
    getSession,
    getAgent,
    getReasoningEffort,
    getAgentReasoningEffort,
    buildChainContext,
    getIsDisposed,
    canMutateCanvas,
    uniqueId,
    paintMessage,
    renderCards,
    scheduleSave,
    documentRef,
    cardParentIds,
  } = deps;

  function readCards() {
    const cards = getCards();
    if (!Array.isArray(cards)) throw new TypeError('createChatEngine: getCards must return an array');
    return cards;
  }

  function chainIsBusy(card) {
    if (!canMutateCanvas()) return true;
    const cards = readCards();
    const seen = new Set();
    function visit(current) {
      if (!current || seen.has(current.id)) return false;
      seen.add(current.id);
      if (activeRequests.has(current.id)) return true;
      return cardParentIds(current).some(parentId => visit(cards.find(item => item.id === parentId)));
    }
    return visit(card);
  }

  async function sendCardPrompt(card, text, options = {}) {
    const cards = readCards;
    if (getIsDisposed() || chainIsBusy(card) || !cards().includes(card)) return;
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

    const requestId = uniqueId('req');
    const requestGeneration = getSession().generation;
    const targetAgent = options.agent ? { ...options.agent } : { ...(getAgent() || {}) };
    const targetEffort = options.reasoningEffort !== undefined
      ? options.reasoningEffort
      : (getAgentReasoningEffort(targetAgent.id) || getReasoningEffort() || null);

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
    scheduleSave();

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
          if (getSession().generation === requestGeneration) {
            asstMsg.waitingLong = true;
            paintMessage(asstMsg);
          }
        },
        onCancelResult(confirmed, detail) {
          if (getSession().generation !== requestGeneration) return;
          asstMsg.cancelConfirmed = confirmed;
          asstMsg.cancelError = detail;
          paintMessage(asstMsg);
          // 这个回执也要落盘，否则刷新之后"服务端到底确认没确认取消"就没了
          scheduleSave();
        },
        onEvent(event) {
          // 三重检查，缺一条都会把旧会话的内容写进新画布
          if (getSession().generation !== requestGeneration) return;
          if (activeRequests.get(card.id) !== active) return;
          if (!cards().includes(card)) return;
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
          scheduleSave();
          const body = documentRef?.getElementById?.(`body-${card.id}`);
          if (body) body.scrollTop = body.scrollHeight;
        },
      });
      if (getSession().generation !== requestGeneration) return;
      asstMsg.text = result.text;
      if (!parseAssistantOutput(result.text).body.trim()) {
        throw new ChatError('EMPTY_BODY', '模型仅返回心境或沉思，未返回正文。');
      }
      asstMsg.status = 'completed';
    } catch (error) {
      if (getSession().generation !== requestGeneration) return;
      const parsed = parseAssistantOutput(asstMsg.text || '');
      const isHostConverterError = (error.message && error.message.includes('The model provider could not complete the request'))
        || error.code === 'APP_MODEL_PROVIDER_ERROR';

      // 容错只留给一个已确认的窄场景：宿主校验空思考签名报错。
      // 以前这里把整个 APP_MODEL_PROVIDER_ERROR 类别都判成成功，
      // 于是普通的连接失败只要溢出几个字，也会被当成完整回答，
      // 还会跟着分支一起进下一轮上下文。
      const looksLikeThinkingSignatureIssue = isHostConverterError
        && /signature|thinking|reasoning/i.test(error.message || '');

      if (parsed.body.trim() && looksLikeThinkingSignatureIssue && error.code !== 'REQUEST_CANCELLED') {
        asstMsg.failed = false;
        asstMsg.status = 'completed';
        asstMsg.error = '';
      } else {
        asstMsg.failed = true;
        asstMsg.status = error.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed';
        asstMsg.error = safeDetail(`${error.code || 'REQUEST_FAILED'}: ${error.message}`);
        // 已经吐出来的内容留在卡上供人看，但不能冒充完整回答。
        if (parsed.body.trim()) asstMsg.partial = true;
      }
    } finally {
      if (!getIsDisposed() && getSession().generation === requestGeneration) asstMsg.streaming = false;
      // 只删自己那一条：同 id 的新请求可能已经顶上来
      if (activeRequests.get(card.id) === active) activeRequests.delete(card.id);
      if (canMutateCanvas(requestGeneration) && cards().includes(card)) {
        card.scrollToEnd = true;
        renderCards();
        scheduleSave();
      }
    }
  }

  function cancelCardRequest(cardId, reason = '用户取消了本次等待。') {
    const active = activeRequests.get(cardId);
    if (!active || active.terminalSeen) return false;
    active.controller.abort(new ChatError('REQUEST_CANCELLED', reason));
    return true;
  }

  function cancelAll(reason) {
    for (const active of activeRequests.values()) {
      active.message.status = 'cancelled';
      active.message.failed = true;
      active.message.streaming = false;
      active.message.error = `REQUEST_INTERRUPTED: ${reason}，回复未完成。`;
      paintMessage(active.message);
      active.controller.abort(new ChatError('REQUEST_CANCELLED', reason));
    }
    activeRequests.clear();
  }

  return { chainIsBusy, sendCardPrompt, cancelAll, cancelCardRequest };
}

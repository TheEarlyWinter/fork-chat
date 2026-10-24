import { parseAssistantOutput } from './assistant-output.js';
import { createPendingUserMessage } from './panel-context.js';
import { normalizeArtifactMetadata, normalizeArtifactList } from './artifact-contract.js';
import { planArtifactVersionAttachment } from './artifact-versions.js';

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
    'getReasoningEffort', 'getAgentReasoningEffort', 'buildContextPlan', 'reportContextIssue', 'getIsDisposed',
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
    buildContextPlan,
    reportContextIssue,
    getIsDisposed,
    canMutateCanvas,
    uniqueId,
    paintMessage,
    renderCards,
    scheduleSave,
    documentRef,
    cardParentIds,
  } = deps;

  function safeReportIssue(issue) {
    try {
      reportContextIssue(issue);
    } catch {}
  }

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
    // 回调类型当场校验：写错了不能等到"成功之后什么都不发生"才发现
    if (options.onAccepted !== undefined && typeof options.onAccepted !== 'function') {
      throw new TypeError('sendCardPrompt: options.onAccepted 必须是函数');
    }
    const cards = readCards;
    if (getIsDisposed() || chainIsBusy(card) || !cards().includes(card)) return false;
    const userMsg = createPendingUserMessage(text, options.attachments);
    if (!userMsg) return false;

    // 先编译再落卡片：直接且仅一次 buildContextPlan(card, { pendingUserMessage })
    const plan = buildContextPlan(card, { pendingUserMessage: userMsg });
    if (!plan || !plan.isRequestReady || (Array.isArray(plan.errors) && plan.errors.length > 0)) {
      // 预检失败：卡片和用户输入都不动，调用方的清理逻辑一个都还没跑
      safeReportIssue(plan?.errors?.[0]?.message || '这次请求没有通过上下文检查');
      return false;
    }

    // 独立复制冻结 accepted user DTO 及 attachments 数组/DTO，不冻结 live 输入附件对象
    const acceptedAttachments = Array.isArray(userMsg.attachments)
      ? Object.freeze(userMsg.attachments.map(att => Object.freeze({ ...att })))
      : undefined;

    const acceptedUserMsg = Object.freeze({
      role: 'user',
      text: userMsg.text,
      ...(acceptedAttachments ? { attachments: acceptedAttachments } : {}),
    });

    card.messages.push(acceptedUserMsg);

    // wire 消息同样独立冻结
    const contextMessages = Object.freeze(
      (plan.messages || []).map(m => Object.freeze({
        role: m.role,
        content: m.content,
        ...(m.attachments ? { attachments: Object.freeze(m.attachments.map(a => Object.freeze({ ...a }))) } : {}),
      }))
    );

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

    // 接受边界：建立 request/user/asst 账本后，在首次 render/save 之前调用同步 onAccepted 一次！
    // 清理抛错不回滚请求（账本已建、消息已入卡），由调用方按前镜像恢复输入。
    if (typeof options.onAccepted === 'function') {
      const meta = Object.freeze({
        requestId,
        cardId: card.id,
        generation: requestGeneration,
      });
      try {
        options.onAccepted(meta);
      } catch (err) {
        safeReportIssue(`发送已经开始了，但清理输入时出错：${safeDetail(err?.message || String(err))}`);
      }
    }

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
          if (event.type === 'tool-call') {
            // 交付型工具在跑的时候正文还没有，状态上要看得出来在忙什么
            asstMsg.status = 'delivering';
            asstMsg.delivering = ['create_document', 'deliver_document'].includes(event.name) ? '文档'
              : (event.name === 'revise_document' ? '文档修订版' : event.name);
          }
          if (event.type === 'tool-result') {
            asstMsg.delivering = '';
            if (event.ok === true && ['create_document', 'deliver_document', 'revise_document'].includes(event.name)) {
              const artifact = normalizeArtifactMetadata(event.result);
              if (!artifact) {
                // 缺 artifactId 或字段校验失败（MIME/sha/lineage 无效）一律可见报错，不静默
                asstMsg.deliverError = '生成文件的回执无效';
              } else if (event.name === 'revise_document') {
                // 修订版优先归回原文件卡所在消息（跨节点也归并）；目标满/无目标回退本轮新卡
                const canvasMessages = readCards().flatMap(item => item.messages.map(message => ({ message, card: item })));
                const flat = canvasMessages.map(entry => entry.message);
                const asstIndex = flat.indexOf(asstMsg);
                const plan = planArtifactVersionAttachment(flat, artifact, asstIndex >= 0 ? asstIndex : flat.length - 1);
                if (plan && plan.changed) {
                  const target = flat[plan.messageIndex];
                  target.artifacts = plan.artifacts;
                  if (target !== asstMsg) {
                    // 归入旧消息：本轮消息留 refs 供后续上下文定位，不重复渲染文件卡
                    const refs = normalizeArtifactList([...(Array.isArray(asstMsg.artifactRefs) ? asstMsg.artifactRefs : []), artifact]);
                    if (refs.length) asstMsg.artifactRefs = refs;
                  }
                  if (plan.reason === 'target-full') safeReportIssue('原消息文件数已达上限，修订版已放入本轮回复');
                } else if (plan === null) {
                  safeReportIssue('文件组已达上限，本次修订版未能挂载到消息');
                }
              } else {
                if (!Array.isArray(asstMsg.artifacts)) asstMsg.artifacts = [];
                if (!asstMsg.artifacts.some(item => item.artifactId === artifact.artifactId)) asstMsg.artifacts.push(artifact);
              }
            } else if (event.ok === true) {
              if (!Array.isArray(asstMsg.deliveredFiles)) asstMsg.deliveredFiles = [];
              asstMsg.deliveredFiles.push(event.result);
            } else {
              asstMsg.deliverError = event.result?.message || '交付失败';
            }
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
      if (!Array.isArray(asstMsg.deliveredFiles)) asstMsg.deliveredFiles = [];
      // 只交了文件、没写正文也算成功，不能按「只有心境」判死。
      // 修订归入旧卡时本轮 artifacts 为空，须承认规范 refs 与本轮真实回执。
      const deliveredOnly = asstMsg.deliveredFiles.length > 0
        || (asstMsg.artifacts?.length || 0) > 0
        || (normalizeArtifactList(asstMsg.artifactRefs || []).length > 0);
      if (!parseAssistantOutput(result.text).body.trim() && !deliveredOnly) {
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
    return true;
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

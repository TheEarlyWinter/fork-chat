/**
 * 工具调用循环：让模型能调用 App 自己的工具。
 *
 * 宿主的模型接口支持 `tools` 参数，但契约里写明「Hana never executes these
 * tools」——执行权在 App 这边。所以这个模块做三件事：把工具声明带给模型、
 * 接住模型吐出的 tool-call、把执行结果作为 toolResult 回灌，直到模型不再要求
 * 调用工具为止。
 *
 * 边界：
 * - 最多 maxRounds 轮，超限报 TOOL_LOOP_LIMIT，绝不无限转
 * - signal 中断时立刻停，不再产事件
 * - 工具执行失败也回灌（isError: true），让模型自己决定怎么补救
 * - 每轮迭代器都要 return()，异常路径也不例外
 */

/**
 * @param {object} args
 * @param {{ streamEvents: Function }} args.models 宿主模型端口
 * @param {object} args.input 原始请求（provider/model/messages/systemPrompt 等）
 * @param {Array} args.tools 工具声明数组
 * @param {(call: {id: string, name: string, arguments: object}) => Promise<any>} args.executeTool
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.maxRounds]
 */
export async function* runToolLoop({ models, input, tools, executeTool, signal, maxRounds = 3 }) {
  if (typeof models?.streamEvents !== 'function') throw new TypeError('runToolLoop: models.streamEvents 必须是函数');
  if (typeof executeTool !== 'function') throw new TypeError('runToolLoop: executeTool 必须是函数');
  if (!Array.isArray(tools) || tools.length === 0) throw new TypeError('runToolLoop: tools 必须是非空数组');
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new RangeError('runToolLoop: maxRounds 必须是正整数');

  // 跨轮累积的 assistant / toolResult 消息，下一轮拼回 messages
  const accumulated = [];

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal?.aborted) return;

    const nextInput = { ...input, messages: [...input.messages, ...accumulated], tools };
    const iterable = models.streamEvents(nextInput, { signal });
    const iterator = iterable?.[Symbol.asyncIterator]?.() || null;
    if (!iterator) {
      yield { type: 'error', code: 'MODEL_STREAM_INVALID', message: '模型流未返回有效迭代器' };
      return;
    }

    let doneEvent = null;
    const toolResults = [];

    try {
      while (true) {
        if (signal?.aborted) return;
        const step = await iterator.next();
        if (step.done) break;
        const event = step.value;
        if (!event || typeof event !== 'object') continue;
        // next() 期间可能刚被中断，这一条就别再往外吐了
        if (signal?.aborted) return;

        if (event.type === 'tool-call') {
          yield event;

          let ok = true;
          let result = null;
          const callId = String(event.id || '');
          const callName = String(event.name || '');
          try {
            result = await executeTool({ id: callId, name: callName, arguments: event.arguments || {} });
          } catch (error) {
            // 适配器内部 fatal 标记：不可恢复终态，不发失败 tool-result、不回灌模型、不发 done。
            // 标记只能来自可信适配器代码；不从模型 arguments 或事件字段读取。
            if (error?.abortToolLoop === true) {
              yield { type: 'error', code: error.code || 'TOOL_ABORTED', message: error.message || '工具调用被终止' };
              return;
            }
            // 执行失败不中断循环：把错误当结果交回去，模型还能改参数重试或换说法
            ok = false;
            result = { code: error?.code || 'TOOL_EXECUTION_FAILED', message: error?.message || String(error) };
          }

          yield { type: 'tool-result', id: callId, name: callName, ok, result };
          toolResults.push({
            role: 'toolResult',
            toolCallId: callId,
            toolName: callName,
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: !ok,
            details: result,
          });
          continue;
        }

        if (event.type === 'error') { yield event; return; }
        if (event.type === 'done') { doneEvent = event; break; }

        yield event;
      }
    } finally {
      // 上一轮迭代器必须释放，否则宿主侧连接会一直挂着
      try { await iterator.return?.(); } catch { /* 释放失败不影响已产出的事件 */ }
    }

    if (signal?.aborted) return;

    if (!doneEvent) {
      yield { type: 'error', code: 'STREAM_INCOMPLETE', message: '模型流异常中断（EOF 未完成）' };
      return;
    }

    const wantsMore = doneEvent.stopReason === 'toolUse' && toolResults.length > 0;
    if (!wantsMore) {
      yield doneEvent;
      return;
    }

    // 继续下一轮：先放 assistant 那一轮的内容，再放工具结果
    if (Array.isArray(doneEvent.assistant?.content) && doneEvent.assistant.content.length > 0) {
      accumulated.push({ role: 'assistant', content: doneEvent.assistant.content });
    }
    accumulated.push(...toolResults);
  }

  yield { type: 'error', code: 'TOOL_LOOP_LIMIT', message: '工具调用超过轮次上限' };
}

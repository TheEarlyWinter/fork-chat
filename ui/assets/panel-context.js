/**
 * 卡片父子拓扑与上下文链的公开门面。
 *
 * 拓扑三件事（父边、父子判断、祖先后序遍历）已经搬到 panel-cards.js：
 * 那里本来就在做卡片模型投影，编译器也从那里取，避免
 * panel-context-plan ↔ panel-context 互相 import 成环。
 *
 * 这里只剩两样东西：
 *   - 把拓扑函数与 pending 构造器 re-export 出去，旧调用点一个都不用改；
 *   - buildChainContext 薄壳，内部只委托 buildContextPlan，不再有第二套拼装算法。
 */

import { buildContextPlan } from './panel-context-plan.js';

export { cardParentIds, cardHasParent, collectChainCards } from './panel-cards.js';
export { createPendingUserMessage } from './panel-context-plan.js';

/**
 * 兼容旧调用点的消息投影。
 *
 * 内部只有一次 buildContextPlan：默认（无排除、无引用）输出与旧编译器逐项相等。
 * 编译错误不吞、不改写成空数组——抛一个带 code 的错误，让调用方看见。
 * 没有 pending 时返回的仍是历史投影，它不代表「这次请求可以发」。
 */
export function buildChainContext({
  cards = [],
  targetCard,
  pendingUserMessage,
  pendingMessage,
  maxReferenceBytes,
} = {}) {
  const plan = buildContextPlan({
    cards,
    targetCard,
    ...(pendingUserMessage !== undefined ? { pendingUserMessage } : {}),
    ...(pendingMessage !== undefined ? { pendingMessage } : {}),
    ...(maxReferenceBytes !== undefined ? { maxReferenceBytes } : {}),
  });
  if (plan.errors.length > 0) {
    const first = plan.errors[0];
    const error = new Error(first.message || '上下文编译失败');
    error.code = first.code;
    error.errors = plan.errors;
    throw error;
  }
  return plan.messages;
}

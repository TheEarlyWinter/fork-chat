import { outputFor } from './panel-messages.js';

/**
 * 卡片父子拓扑追溯与上下文链拼装模块。
 *
 * 负责提取父节点 ID 列表、父子关系断言，
 * 以及向上递归回溯祖先节点，拼装从根节点到当前节点的完整上下文链路。
 * 纯函数逻辑，不访问 window 或 document，不反向依赖 panel.js。
 */

export function cardParentIds(card) {
  return Array.from(new Set([
    ...(card?.parentId ? [card.parentId] : []),
    ...(Array.isArray(card?.parentIds) ? card.parentIds : []),
  ]));
}

export function cardHasParent(card, parentId) {
  return cardParentIds(card).includes(parentId);
}

// 向上递归回溯祖先节点，拼装从根节点到当前节点的完整上下文链路
export function buildChainContext({ cards = [], targetCard } = {}) {
  const cardList = Array.isArray(cards) ? cards : [];
  const chain = [];
  const added = new Set();
  const visiting = new Set();
  function visit(card) {
    if (!card || added.has(card.id)) return;
    if (visiting.has(card.id)) return;
    visiting.add(card.id);
    for (const parentId of cardParentIds(card)) {
      visit(cardList.find(item => item.id === parentId));
    }
    visiting.delete(card.id);
    added.add(card.id);
    chain.push(card);
  }
  visit(targetCard);
  const msgs = [];
  chain.forEach(c => {
    if (c.isDoc && c.docContent) {
      msgs.push({
        role: 'user',
        content: `【前置参考资料：《${c.title}》】\n${c.docContent}`,
      });
      msgs.push({
        role: 'assistant',
        content: `已阅读并完全解析前置资料《${c.title}》。将以此文档为事实基座回答后续分析推导。`,
      });
    }
    (c.messages || []).forEach(m => {
      if (!m.text && (!m.attachments || m.attachments.length === 0)) return;
      if (m.localOnly || m.streaming || m.failed || (m.status && m.status !== 'completed')) return;

      let content = outputFor(m).body;
      if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length > 0) {
        const attSections = m.attachments.map(att =>
          `【附件资料：《${att.name}》】\n${att.content || ''}`
        ).join('\n\n');
        content = attSections ? `${attSections}\n\n${content}` : content;
      }

      msgs.push({
        role: m.role,
        content,
      });
    });
  });
  // 收尾：失败的助手回复被剔掉后，它对应的那条提问也不能留着。
  // 否则同一张卡里重试时会拼出两条连续的 user 消息，
  // 严格校验轮次的模型接口会直接 400，这张卡就永远发不出去了。
  const balanced = [];
  for (const m of msgs) {
    const prev = balanced[balanced.length - 1];
    // 两条 user 挨着，说明前一条的回复没留下来（失败或被中断）：把前一条去掉。
    // 只做这一件事，其余结构原样保留。
    if (m.role === 'user' && prev && prev.role === 'user') balanced.pop();
    balanced.push(m);
  }
  return balanced;
}

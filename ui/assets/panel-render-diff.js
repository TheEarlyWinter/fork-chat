/**
 * 卡片级内容签名与 DOM 复用判定（渲染增量化的纯函数层）。
 *
 * 设计约束：
 * - 签名只覆盖影响卡片 DOM 的字段；坐标/滚动恢复字段不进签名（它们走原地挪位）
 * - 流式输出的高频变化（text 追加、状态迁移）必须反映到签名，宁可多建不可漏建
 * - buildCardHtml 的外部输入（当前助手名/模型）同样影响 DOM，由 renderContext 携带进签名
 * - 纯函数、无 DOM 依赖；renderer 在挂载时把签名记到元素上，重绘时比对
 */

const SIGNATURE_FIELDS = ['id', 'statusStamp', 'width', 'height', 'isCollapsed', 'isMultiSelectedHint'];
const CARD_COLLECTION_FIELDS = ['stagedAttachments', 'docContent', 'sourceRef'];

function messageSignature(message) {
  if (!message || typeof message !== 'object') return 'null';
  const parts = [
    message.role || '',
    typeof message.text === 'string' ? message.text.length + ':' + message.text.slice(-64) : '',
    message.status || '',
    message.failed ? 'F' : '',
    message.partial ? 'P' : '',
    message.streaming ? 'S' : '',
    message.cancelConfirmed ? 'C' : '',
    message.delivering || '',
    message.deliverError || '',
    Array.isArray(message.artifacts) ? 'A' + message.artifacts.map(a => a?.artifactId || '').join(',') : '',
    Array.isArray(message.artifactRefs) ? 'R' + message.artifactRefs.map(a => a?.artifactId || '').join(',') : '',
    Array.isArray(message.deliveredFiles) ? 'D' + message.deliveredFiles.length : '',
    Array.isArray(message.attachments) ? 'T' + message.attachments.map(a => a?.name || '').join(',') : '',
    message.requestId || '',
  ];
  return parts.join('|');
}

export function cardContentSignature(card, renderContext = null) {
  if (!card || typeof card !== 'object') return 'null';
  const fields = SIGNATURE_FIELDS.map(field => String(card[field] ?? '')).join('~');
  // 数组/对象型卡片字段（暂存附件、文档内容、来源引用）影响 DOM，序列化进签名
  const collections = CARD_COLLECTION_FIELDS.map(field => {
    const value = card[field];
    if (Array.isArray(value)) return field + ':' + value.map(item => JSON.stringify(item)).slice(0, 10).join(',');
    if (value && typeof value === 'object') return field + ':' + JSON.stringify(value);
    return field + ':-';
  }).join('~');
  // 选中/多选态只影响 class，单独一位表达，避免整卡签名翻掉
  const selection = card.isSelectedHint ? 'sel' : '';
  const messages = Array.isArray(card.messages)
    ? card.messages.map(messageSignature).join('||')
    : 'no-messages';
  // 外部渲染输入：当前助手名/模型影响未发消息卡的回退展示，变化必须 invalidate
  const agent = renderContext?.agent ? `${renderContext.agent.id || ''}:${renderContext.agent.name || ''}:${renderContext.agent.model || ''}` : 'no-agent';
  return `${fields}#${collections}#${selection}#${agent}#${messages.length}:${messages}`;
}

export function canReuseCardElement(card, signature, element) {
  if (!element || typeof element !== 'object') return false;
  if (element.__boundCard !== card) return false;
  return element.__contentSignature === signature;
}

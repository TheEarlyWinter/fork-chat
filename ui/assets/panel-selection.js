/**
 * 正文划词创建分支的控制器。
 *
 * 只做一件事：在一条已完成的助手正文里选中一段文字，就地开一张子卡，
 * 把选中的原文预填进草稿。**不自动发送**，也不改父卡片的任何内容。
 *
 * 纯逻辑（validateSelection / buildBranchDraft）与 DOM 接线分开，
 * 模块顶层不访问 window 或 document，全部通过 deps 注入。
 */

import { outputFor } from './panel-messages.js';
import { MAX_REF_TEXT_BYTES, contextByteLength } from './fork-context-policy.js';

/** 单次可引用的正文上限：直接取引用策略的那一条，别处不许再写一遍数字 */
export const MAX_SELECTION_BYTES = MAX_REF_TEXT_BYTES;


export function selectionByteLength(text) {
  return contextByteLength(text);
}

/** 消息行上的索引属性：只在当前渲染周期有效，不当稳定 ID 存盘 */
export const MESSAGE_INDEX_ATTR = 'data-message-index';

/**
 * 从当前渲染周期的 `.msg-row` 上读消息下标。
 * 读不到就返回 -1，由调用方退回到 requestId 定位。
 */
export function readMessageIndex(row) {
  if (!row) return -1;
  const raw = row.dataset?.messageIndex ?? (typeof row.getAttribute === 'function'
    ? row.getAttribute(MESSAGE_INDEX_ATTR)
    : undefined);
  if (raw === undefined || raw === null || raw === '') return -1;
  const index = Number.parseInt(String(raw), 10);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

/**
 * 把一个气泡对回到活消息对象。
 *
 * 光看 DOM 角色不够：还在生成、失败、本地提示都不是可引用的正文；
 * 只靠 cardId 也不够，消息可能被删掉或正文被改过。
 * messages 为空时直接拒绝——不存在「没有消息也算合法来源」的通道。
 */
export function resolveSourceMessage({ card, messageIndex = -1, requestId = null, quote } = {}) {
  const messages = Array.isArray(card?.messages) ? card.messages : [];
  if (messages.length === 0) return { ok: false, reason: 'NO_MESSAGES' };
  const quoted = String(quote || '');
  if (!quoted) return { ok: false, reason: 'EMPTY' };
  let index = -1;
  if (Number.isInteger(messageIndex) && messageIndex >= 0 && messageIndex < messages.length) {
    index = messageIndex;
  } else if (requestId) {
    index = messages.findIndex(item => item?.requestId === requestId);
  } else {
    // 没有下标也没有 requestId 时，只接受「唯一一条正文包含这段文字」的已完成回答。
    // 多条命中就是歧义，宁可拒绝也不猜一个来源。
    const matches = [];
    messages.forEach((item, itemIndex) => {
      if (isEligibleMessage(item) && outputFor(item).body.includes(quoted)) matches.push(itemIndex);
    });
    if (matches.length > 1) return { ok: false, reason: 'AMBIGUOUS' };
    if (matches.length === 1) index = matches[0];
  }
  if (index < 0) return { ok: false, reason: 'NO_MESSAGE' };
  const message = messages[index];
  if (!message) return { ok: false, reason: 'NO_MESSAGE' };
  if (!isEligibleMessage(message)) return { ok: false, reason: 'INELIGIBLE' };
  const body = outputFor(message).body;
  if (!body.includes(quoted)) return { ok: false, reason: 'BODY_MISMATCH' };
  return { ok: true, message, index, requestId: message.requestId || null, body };
}

/**
 * 候选执行前的重验：消息对象、正文版本、DOM 节点都还得是同一份。
 * 返回 ok=false 时调用方必须整条丢弃候选，不是「修一修再用」。
 */
export function verifyMessageCandidate({ card, candidate } = {}) {
  if (!candidate) return { ok: false, reason: 'STALE' };
  const quoteText = typeof candidate.quoteText === 'string' ? candidate.quoteText : '';
  // 引文必须是显式存下来的非空串：拿空串去 includes 永远为真，等于没验
  if (!quoteText) return { ok: false, reason: 'STALE' };
  const messages = Array.isArray(card?.messages) ? card.messages : [];
  const message = Number.isInteger(candidate.messageIndex) && candidate.messageIndex >= 0
    ? messages[candidate.messageIndex]
    : (candidate.messageRef ? messages.find(item => item === candidate.messageRef) : null);
  if (!message || message !== candidate.messageRef) return { ok: false, reason: 'STALE' };
  if (!isEligibleMessage(message)) return { ok: false, reason: 'STALE' };
  const body = outputFor(message).body;
  if (typeof candidate.bodyVersion !== 'string' || body !== candidate.bodyVersion) {
    return { ok: false, reason: 'STALE' };
  }
  if (!body.includes(quoteText)) return { ok: false, reason: 'STALE' };
  if (!isNodeAlive(candidate.bodyNode)) return { ok: false, reason: 'STALE' };
  return { ok: true, card, message, body, quoteText };
}

/** DOM 节点还挂在当前文档里吗。合成 DOM 没有 isConnected 时按「仍在」处理，不凭空判死。 */
export function isNodeAlive(node, ownerDoc = null) {
  if (!node) return false;
  if (node.isConnected === false) return false;
  if (ownerDoc && node.ownerDocument && node.ownerDocument !== ownerDoc) return false;
  return true;
}

/**
 * 判定一次选区能不能变成分支。
 *
 * 拒绝的理由要能说清楚，不能只是"不出现"：超限不截断、含公式不猜、
 * 纯空白不建卡。
 */
export function validateSelection({
  text,
  insideAssistant = true,
  sameBubble = true,
  hasKatex = false,
  maxBytes = MAX_SELECTION_BYTES,
} = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, reason: 'EMPTY', message: '没有选中可引用的文字' };
  if (!sameBubble) return { ok: false, reason: 'MULTI_BUBBLE', message: '只能引用同一条消息里的文字' };
  if (!insideAssistant) return { ok: false, reason: 'NOT_ASSISTANT', message: '只能引用助手的正文' };
  if (hasKatex) return { ok: false, reason: 'CONTAINS_MATH', message: '选区里有公式，请避开公式单独选取' };
  const bytes = selectionByteLength(trimmed);
  if (bytes > maxBytes) {
    return { ok: false, reason: 'TOO_LONG', message: `选中的文字有 ${bytes} 字节，超过 ${maxBytes} 字节上限` };
  }
  return { ok: true, text: trimmed, bytes };
}

/**
 * 预填进子卡草稿的文本。
 *
 * 引用原文用引用块，问题留空等用户自己写——这里不该替用户猜问题。
 */
export function buildBranchDraft({ cardTitle, text } = {}) {
  const title = String(cardTitle || '卡片').trim() || '卡片';
  const body = String(text || '').trim();
  if (!body) return '';
  const quoted = body.split(/\r?\n/).map(line => `> ${line}`).join('\n');
  return `【引用片段 · 来自「${title}」】\n${quoted}\n\n`;
}

/**
 * 从 DOM 节点往上找它所属的卡片 id（卡片根节点是 `dom-<id>`）。
 * 找不到就返回 null，调用方据此放弃。
 */
export function findCardIdFromNode(node, { maxDepth = 20 } = {}) {
  let current = node;
  let depth = 0;
  while (current && depth < maxDepth) {
    const id = current.id || '';
    if (typeof id === 'string' && id.startsWith('dom-')) return id.slice(4);
    current = current.parentNode;
    depth += 1;
  }
  return null;
}

/**
 * 这条消息能不能作为引用来源。
 *
 * DOM 上看着像正文还不够：正在生成、失败、本地提示都不是可引用的内容，
 * 引用必须是已经落定的一段回答。
 */
export function isEligibleMessage(message) {
  if (!message) return false;
  if (message.role !== 'assistant') return false;
  if (message.localOnly) return false;
  if (message.failed) return false;
  if (message.streaming) return false;
  if (message.status && message.status !== 'completed') return false;
  return true;
}

/**
 * 选区所在的消息气泡：锚点与焦点必须落在同一个气泡里，
 * 跨越两条消息的选区没有唯一的父卡片，直接拒绝。
 */
export function resolveSelectionBubble(range) {
  if (!range) return { bubble: null, sameBubble: false };
  const startEl = range.startContainer?.nodeType === 1
    ? range.startContainer
    : range.startContainer?.parentElement;
  const endEl = range.endContainer?.nodeType === 1
    ? range.endContainer
    : range.endContainer?.parentElement;
  const startBubble = startEl?.closest?.('.msg-bubble') || null;
  const endBubble = endEl?.closest?.('.msg-bubble') || null;
  return { bubble: startBubble, sameBubble: Boolean(startBubble) && startBubble === endBubble };
}

export function isAssistantBubble(bubble) {
  return Boolean(bubble?.closest?.('.msg-row.msg-asst'));
}

/**
 * 选区里是否落了渲染后的公式。KaTeX 的 DOM 文本和源码不是一回事，
 * 从这里摘出来的字会和用户看到的对不上，所以宁可拒绝。
 */
export function selectionContainsMath(range) {
  if (!range) return false;
  const container = range.commonAncestorContainer;
  const element = container?.nodeType === 1 ? container : container?.parentElement;
  if (!element) return false;
  if (element.closest?.('.katex')) return true;
  return Boolean(element.querySelector?.('.katex'));
}

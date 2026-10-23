import { outputFor } from './panel-messages.js';
import { collectChainCards } from './panel-cards.js';
import {
  MAX_REFS_PER_CARD,
  MAX_REF_TEXT_BYTES,
  MAX_REFERENCE_PREFIX_BYTES,
  MAX_REF_SOURCE_TITLE,
  getContextMode,
  contextByteLength,
} from './fork-context-policy.js';

/**
 * 把「卡片拓扑 + 上下文策略」编译成一次请求的 messages。
 *
 * 与旧 buildChainContext 的默认行为逐项等价：没有任何 exclude、没有任何引用时
 * 输出相同。策略只在被显式设置后才改变结果。
 *
 * 四件事必须分清：
 *   - exclude 只跳过该节点的贡献，祖先照常遍历（不剪枝、不删卡）；
 *   - target 自己的消息永远保留，哪怕它自己被标了 exclude；
 *   - 引用只取捕获时的原文，不递归来源的祖先，也不继承来源自己的引用；
 *   - 「消息历史能不能编译」与「这次请求能不能发」是两件事：没有 pending 时
 *     仍然给出历史投影和来源说明，但 isRequestReady 必须是 false。
 *
 * 运行时数据一律 fail closed：非法 policy / ref / pending 直接进 errors，
 * 有 error 就 messages=[]，绝不带着半套消息去调模型。
 */

const ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;
const REF_HEADER = '【引用片段';

/** 固定错误码。旧码只作为 legacyCode 附带，不再作为主键。 */
export const CONTEXT_PLAN_ERRORS = Object.freeze({
  INVALID_CONTEXT_POLICY: 'INVALID_CONTEXT_POLICY',
  INVALID_CONTEXT_REFERENCE: 'INVALID_CONTEXT_REFERENCE',
  CONTEXT_REFERENCE_LIMIT_EXCEEDED: 'CONTEXT_REFERENCE_LIMIT_EXCEEDED',
  CONTEXT_REFERENCE_PREFIX_TOO_LARGE: 'CONTEXT_REFERENCE_PREFIX_TOO_LARGE',
  INVALID_PENDING_MESSAGE: 'INVALID_PENDING_MESSAGE',
  CONFLICTING_PENDING_MESSAGE: 'CONFLICTING_PENDING_MESSAGE',
  INVALID_CONTEXT_TARGET: 'INVALID_CONTEXT_TARGET',
});

export const CONTEXT_PLAN_WARNINGS = Object.freeze({
  REFERENCE_SOURCE_EXCLUDED: 'REFERENCE_SOURCE_EXCLUDED',
  REFERENCE_SOURCE_MISSING: 'REFERENCE_SOURCE_MISSING',
  NO_PENDING_PROMPT: 'NO_PENDING_PROMPT',
});

/**
 * 构造这次请求要带的临时 user 消息。
 *
 * 引擎和预览都调这一个，禁止各自实现一套草稿/附件拼接规则：
 * trim、空输入、附件占位文字只有这里一处定义。附件数组只做浅复制，
 * 正文一个字都不复制。
 *
 * @returns {{role:'user', text:string, attachments?: object[]} | null} 空输入返回 null
 */
export function createPendingUserMessage(text, attachments) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const list = Array.isArray(attachments) ? attachments.slice() : [];
  if (!trimmed && list.length === 0) return null;
  const content = trimmed || `[已附带 ${list.length} 份文档资料]`;
  return list.length > 0
    ? { role: 'user', text: content, attachments: list }
    : { role: 'user', text: content };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cardLabel(card) {
  return String(card?.title || card?.id || '未命名卡片');
}

/**
 * 引用前缀的最终有效上限。
 *
 * 允许调小（测试/紧凑场景），但绝不能因为传了 Infinity / NaN / 大数就把 64KiB 硬上限顶掉：
 * 不可放大，非法值回落共享常量。
 */
export function resolveReferencePrefixLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return MAX_REFERENCE_PREFIX_BYTES;
  return Math.min(Math.floor(value), MAX_REFERENCE_PREFIX_BYTES);
}

function pushPolicyErrors(card, errors) {
  if (!isPlainObject(card)) return;
  if (!Object.prototype.hasOwnProperty.call(card, 'contextMode')) return;
  const mode = card.contextMode;
  if (mode === undefined || mode === 'include' || mode === 'exclude') return;
  errors.push({
    code: CONTEXT_PLAN_ERRORS.INVALID_CONTEXT_POLICY,
    message: `「${cardLabel(card)}」的上下文策略不是 include / exclude，这次请求不能发`,
    cardId: card.id,
  });
}

function pushReferenceErrors(card, errors) {
  if (!isPlainObject(card)) return;
  const refs = card.contextRefs;
  if (refs === undefined || refs === null) return;
  if (!Array.isArray(refs)) {
    errors.push({
      code: CONTEXT_PLAN_ERRORS.INVALID_CONTEXT_REFERENCE,
      message: `「${cardLabel(card)}」的引用不是数组，这次请求不能发`,
      cardId: card.id,
    });
    return;
  }
  if (refs.length > MAX_REFS_PER_CARD) {
    errors.push({
      code: CONTEXT_PLAN_ERRORS.CONTEXT_REFERENCE_LIMIT_EXCEEDED,
      message: `「${cardLabel(card)}」有 ${refs.length} 条引用，超过每卡 ${MAX_REFS_PER_CARD} 条`,
      cardId: card.id,
    });
  }
  const seenIds = new Set();
  refs.forEach((ref, index) => {
    const at = `第 ${index + 1} 条引用`;
    const invalid = message => errors.push({
      code: CONTEXT_PLAN_ERRORS.INVALID_CONTEXT_REFERENCE,
      message: `「${cardLabel(card)}」的${at}不合法：${message}`,
      cardId: card.id,
      refId: typeof ref?.id === 'string' ? ref.id : undefined,
    });
    if (!isPlainObject(ref)) { invalid('不是对象'); return; }
    if (typeof ref.id !== 'string' || !ID_REGEX.test(ref.id)) { invalid('id 缺失或字符不合法'); return; }
    if (typeof ref.sourceCardId !== 'string' || !ID_REGEX.test(ref.sourceCardId)) { invalid('sourceCardId 缺失或字符不合法'); return; }
    if (ref.sourceCardId === card.id) { invalid('指向了持有它的卡片自己'); return; }
    if (ref.sourceTitle !== undefined && typeof ref.sourceTitle !== 'string') { invalid('sourceTitle 不是字符串'); return; }
    if ([...(ref.sourceTitle || '')].length > MAX_REF_SOURCE_TITLE) { invalid(`来源标题超过 ${MAX_REF_SOURCE_TITLE} 字`); return; }
    if (typeof ref.text !== 'string' || ref.text.trim() === '') { invalid('正文为空'); return; }
    if (contextByteLength(ref.text) > MAX_REF_TEXT_BYTES) {
      errors.push({
        code: CONTEXT_PLAN_ERRORS.CONTEXT_REFERENCE_LIMIT_EXCEEDED,
        message: `「${cardLabel(card)}」的${at}正文超过 ${MAX_REF_TEXT_BYTES} 字节`,
        cardId: card.id,
        refId: ref.id,
      });
      return;
    }
    if (seenIds.has(ref.id)) {
      invalid(`id ${ref.id} 在这张卡里重复`);
      return;
    }
    seenIds.add(ref.id);
  });
}

/**
 * 会话级引用身份：ref.id 在整个会话里必须唯一（与 fork-session-store 的快照合同一致）。
 *
 * 单卡内去重不够：跨卡撞 ID 会让「按 ID 去重」的历史预算前提失效。
 * 同一个 owner 卡 id 可能被传两次（目标卡同时出现在 cards 与 targetCard，或 R12 那种副本），
 * 它们的 refs 合并成同一个 owner 看，不重复计数；跨 owner 即使同源同文也拒绝，
 * 会话合同是按 ID 唯一，不是按内容择一。
 */
function pushSessionReferenceIdErrors(cards, errors) {
  // 先把同一个卡 id 的多次出现合并，避免目标卡被当成两个 owner
  const owners = new Map();
  for (const card of cards) {
    if (!isPlainObject(card)) continue;
    if (!owners.has(card.id)) owners.set(card.id, new Map());
    const refsById = owners.get(card.id);
    const refs = Array.isArray(card.contextRefs) ? card.contextRefs : [];
    for (const ref of refs) {
      if (!isPlainObject(ref) || typeof ref.id !== 'string' || !ID_REGEX.test(ref.id)) continue;
      if (!refsById.has(ref.id)) refsById.set(ref.id, ref);
    }
  }

  const seenById = new Map();
  for (const [cardId, refsById] of owners) {
    for (const [refId, ref] of refsById) {
      const previous = seenById.get(refId);
      if (!previous) {
        seenById.set(refId, { cardId, sourceCardId: ref.sourceCardId, text: ref.text });
        continue;
      }
      if (previous.cardId === cardId) continue;
      const sameContent = previous.sourceCardId === ref.sourceCardId && previous.text === ref.text;
      errors.push({
        code: CONTEXT_PLAN_ERRORS.INVALID_CONTEXT_REFERENCE,
        message: sameContent
          ? `引用 id ${refId} 在同一会话里出现了两次（「${previous.cardId}」/「${cardId}」）`
          : `引用 id ${refId} 被两张卡用于不同内容（「${previous.cardId}」/「${cardId}」）`,
        cardId,
        refId,
      });
    }
  }
}

function sameAttachments(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return !left && !right;
  if (left.length !== right.length) return false;
  return left.every((att, index) => att === right[index]
    || (att?.name === right[index]?.name && att?.content === right[index]?.content));
}

function samePending(left, right) {
  if (left === right) return true;
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  return left.role === right.role
    && String(left.text ?? '') === String(right.text ?? '')
    && sameAttachments(left.attachments, right.attachments);
}

/**
 * 解析 pending：canonical 是 pendingUserMessage，pendingMessage 只是旧别名。
 * 两个都传且内容不一致时结构化拒绝——不猜哪个是用户的意思。
 */
function resolvePending({ pendingUserMessage, pendingMessage }, errors) {
  const provided = [];
  if (pendingUserMessage !== undefined && pendingUserMessage !== null) {
    provided.push({ key: 'pendingUserMessage', value: pendingUserMessage });
  }
  if (pendingMessage !== undefined && pendingMessage !== null) {
    provided.push({ key: 'pendingMessage', value: pendingMessage });
  }
  if (provided.length === 0) return null;
  if (provided.length === 2 && !samePending(provided[0].value, provided[1].value)) {
    errors.push({
      code: CONTEXT_PLAN_ERRORS.CONFLICTING_PENDING_MESSAGE,
      message: 'pendingUserMessage 与旧的 pendingMessage 内容不一致，不能猜哪一条是要发的问题',
    });
    return null;
  }
  const dto = provided[0].value;
  if (!isPlainObject(dto)) {
    errors.push({
      code: CONTEXT_PLAN_ERRORS.INVALID_PENDING_MESSAGE,
      message: '待发送的问题不是消息对象',
    });
    return null;
  }
  if (dto.role !== 'user') {
    errors.push({
      code: CONTEXT_PLAN_ERRORS.INVALID_PENDING_MESSAGE,
      message: '待发送的问题 role 必须是 user',
    });
    return null;
  }
  const text = typeof dto.text === 'string' ? dto.text : '';
  const attachments = Array.isArray(dto.attachments) ? dto.attachments : [];
  if (!text.trim() && attachments.length === 0) {
    errors.push({
      code: CONTEXT_PLAN_ERRORS.INVALID_PENDING_MESSAGE,
      message: '待发送的问题是空的',
    });
    return null;
  }
  return attachments.length > 0 ? { role: 'user', text, attachments } : { role: 'user', text };
}

/** 引用前缀里一条引用的格式：JSON 数据块，边界明确，正文无法伪造出第二条 */
function formatReferenceBlock(entry, index) {
  const title = String(entry.sourceTitle || '未知来源').replace(/\s+/g, ' ').trim();
  const payload = JSON.stringify({
    sourceCardId: entry.sourceCardId,
    sourceTitle: entry.sourceTitle || '',
    text: entry.text,
  });
  return `${REF_HEADER} ${index} · 来自「${title}」】\n${payload}`;
}

/**
 * 收集本次请求要带上的引用。
 *
 * 两阶段：owner 只从贡献节点里取（target 自己永远算贡献者），
 * 来源按它自己的 mode 判断是否可入模。不递归来源的父边和 refs。
 */
export function collectPlanReferences({ cards = [], chain = [], warnings = [] } = {}) {
  const cardList = Array.isArray(cards) ? cards : [];
  const byId = new Map(cardList.map(card => [card.id, card]));
  const kept = [];
  const dropped = [];
  const byKey = new Map();

  for (const owner of Array.isArray(chain) ? chain : []) {
    const refs = Array.isArray(owner?.contextRefs) ? owner.contextRefs : [];
    for (const ref of refs) {
      if (!ref || typeof ref.text !== 'string') continue;
      const source = byId.get(ref.sourceCardId);
      // 来源被排除：入模就等于绕过 exclude，只提醒，不自动放行
      if (source && getContextMode(source) === 'exclude') {
        warnings.push({
          code: CONTEXT_PLAN_WARNINGS.REFERENCE_SOURCE_EXCLUDED,
          legacyCode: 'REF_SOURCE_EXCLUDED',
          message: `「${ref.sourceTitle || ref.sourceCardId}」已被设为不向后续分支提供上下文，这条引用这次不会带上`,
          refId: ref.id,
          cardId: ref.sourceCardId,
        });
        continue;
      }
      const key = `${ref.sourceCardId}\u0000${ref.text}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.ownerCardIds.includes(owner.id)) existing.ownerCardIds.push(owner.id);
        if (!existing.refIds.includes(ref.id)) existing.refIds.push(ref.id);
        dropped.push({ refId: ref.id, keptRefId: existing.refIds[0], ownerCardId: owner.id });
        continue;
      }
      const entry = {
        kind: 'reference',
        sourceCardId: ref.sourceCardId,
        sourceTitle: String(ref.sourceTitle || ''),
        text: ref.text,
        sourceState: source ? 'present' : 'missing',
        ownerCardIds: [owner.id],
        refIds: [ref.id],
      };
      byKey.set(key, entry);
      kept.push(entry);
      if (!source) {
        warnings.push({
          code: CONTEXT_PLAN_WARNINGS.REFERENCE_SOURCE_MISSING,
          legacyCode: 'REF_SOURCE_MISSING',
          message: `引用的来源「${ref.sourceTitle || ref.sourceCardId}」已删除，只保留当时捕获的原文`,
          refId: ref.id,
          cardId: ref.sourceCardId,
        });
      }
    }
  }
  return { kept, dropped };
}

function emptyPlan({ errors, warnings }) {
  return {
    messages: [],
    sources: [],
    excludedCardIds: [],
    warnings,
    errors,
    stats: {
      mainlineCardCount: 0,
      effectiveReferenceCount: 0,
      referencePrefixBytes: 0,
      wireBytes: contextByteLength(JSON.stringify([])),
    },
    referencePrefix: '',
    isRequestReady: false,
    // 同一次计算的别名，供旧调用点读取；不另拼一套算法
    contributors: [],
    adoptedRefs: [],
    duplicateRefs: [],
    referenceBytes: 0,
  };
}

function messageContent(message) {
  const text = typeof message.text === 'string' ? message.text : '';
  let content = outputFor(message).body;
  if (message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attSections = message.attachments
      .map(att => `【附件资料：《${att.name}》】\n${att.content || ''}`)
      .join('\n\n');
    if (attSections) content = `${attSections}\n\n${content}`;
  }
  return content;
}

function isProjectable(message) {
  if (!message) return false;
  const hasText = Boolean(message.text);
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  if (!hasText && !hasAttachments) return false;
  if (message.localOnly || message.streaming || message.failed) return false;
  if (message.status && message.status !== 'completed') return false;
  return true;
}

/**
 * 编译一次请求。
 *
 * @returns {{
 *   messages: Array<{role: string, content: string}>,
 *   sources: object[],
 *   excludedCardIds: string[],
 *   warnings: object[],
 *   errors: object[],
 *   stats: {mainlineCardCount: number, effectiveReferenceCount: number, referencePrefixBytes: number, wireBytes: number},
 *   isRequestReady: boolean
 * }}
 */
export function buildContextPlan({
  cards = [],
  targetCard = null,
  pendingUserMessage,
  pendingMessage,
  maxReferenceBytes,
} = {}) {
  const cardList = Array.isArray(cards) ? cards : [];
  const warnings = [];
  const errors = [];

  // 目标卡允许单独传入（不在 cards 里也能编译），但它自己的 policy/refs 必须同样过严格校验。
  // 同一个对象既在 cards 又是 target 时只算一次，不重复计数。
  const validationCards = cardList.slice();
  if (isPlainObject(targetCard) && !validationCards.includes(targetCard)) {
    validationCards.push(targetCard);
  }
  for (const card of validationCards) {
    pushPolicyErrors(card, errors);
    pushReferenceErrors(card, errors);
  }
  pushSessionReferenceIdErrors(validationCards, errors);

  const pending = resolvePending({ pendingUserMessage, pendingMessage }, errors);
  if (!isPlainObject(targetCard)) {
    errors.push({
      code: CONTEXT_PLAN_ERRORS.INVALID_CONTEXT_TARGET,
      message: '没有可编译的目标卡片',
    });
  }
  if (errors.length > 0) return emptyPlan({ errors, warnings });

  const chain = collectChainCards({ cards: cardList, targetCard });
  const includedChain = [];
  const excludedCardIds = [];
  const contributors = [];
  const msgs = [];

  for (const card of chain) {
    const isTarget = card.id === targetCard?.id;
    // 排除只影响「向后代贡献」，不影响遍历：父节点已经在这条链上了
    if (!isTarget && getContextMode(card) === 'exclude') {
      excludedCardIds.push(card.id);
      continue;
    }
    includedChain.push(card);
    contributors.push(card.id);

    if (card.isDoc && card.docContent) {
      msgs.push({
        role: 'user',
        content: `【前置参考资料：《${card.title}》】\n${card.docContent}`,
      });
      msgs.push({
        role: 'assistant',
        content: `已阅读并完全解析前置资料《${card.title}》。将以此文档为事实基座回答后续分析推导。`,
      });
    }

    for (const message of (Array.isArray(card.messages) ? card.messages : [])) {
      if (!isProjectable(message)) continue;
      msgs.push({ role: message.role, content: messageContent(message) });
    }
  }

  // 预检发生在提问写进卡片之前：pending 只参与这一次编译，不先 push 进活卡
  if (pending) {
    msgs.push({ role: 'user', content: messageContent(pending) });
  }

  // 去掉失败的助手回复后，它对应的提问也不能留：两条相邻 user 会让严格校验轮次的接口直接 400
  const balanced = [];
  for (const message of msgs) {
    const prev = balanced[balanced.length - 1];
    if (message.role === 'user' && prev && prev.role === 'user') balanced.pop();
    balanced.push(message);
  }

  const references = collectPlanReferences({ cards: cardList, chain: includedChain, warnings });
  const prefixLimit = resolveReferencePrefixLimit(maxReferenceBytes);
  let referencePrefix = '';
  if (references.kept.length > 0) {
    referencePrefix = references.kept.map((entry, index) => formatReferenceBlock(entry, index + 1)).join('\n\n');
    const bytes = contextByteLength(referencePrefix);
    if (bytes > prefixLimit) {
      errors.push({
        code: CONTEXT_PLAN_ERRORS.CONTEXT_REFERENCE_PREFIX_TOO_LARGE,
        legacyCode: 'REFERENCE_PREFIX_TOO_LARGE',
        message: `引用合计 ${bytes} 字节，超过 ${prefixLimit} 字节上限，请减少或缩短引用`,
        bytes,
        limit: prefixLimit,
      });
    }
    if (!pending) {
      // 引用只能附在这次的新提问上。没有新提问就不发，也绝不改历史问句——
      // 但这不是编译失败，历史投影本身是合法的。
      warnings.push({
        code: CONTEXT_PLAN_WARNINGS.NO_PENDING_PROMPT,
        legacyCode: 'NO_PENDING_PROMPT',
        message: '这些引用只能附在新提问上；输入问题后才会计入请求',
      });
    }
  }

  let messages = balanced;
  if (errors.length === 0 && pending && referencePrefix && messages.length > 0) {
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (last.role === 'user') {
      messages = messages.slice();
      messages[lastIndex] = { ...last, content: `${referencePrefix}\n\n${last.content}` };
    }
  }
  // errors 非空时 messages 必须是空集：不允许「部分发送」
  if (errors.length > 0) messages = [];

  const mainlineSources = includedChain.map(card => ({
    kind: 'mainline',
    cardId: card.id,
    title: String(card.title || ''),
    isTarget: card.id === targetCard?.id,
  }));
  const referencePrefixBytes = contextByteLength(referencePrefix);
  const sources = [...mainlineSources, ...references.kept.map(entry => ({ ...entry }))];

  return {
    messages,
    sources,
    excludedCardIds,
    warnings,
    errors,
    stats: {
      mainlineCardCount: mainlineSources.length,
      effectiveReferenceCount: references.kept.length,
      referencePrefixBytes,
      wireBytes: contextByteLength(JSON.stringify(messages)),
    },
    referencePrefix,
    isRequestReady: errors.length === 0 && Boolean(pending) && messages.length > 0,
    // 同一次计算的别名
    contributors,
    adoptedRefs: references.kept.map(entry => ({
      sourceCardId: entry.sourceCardId,
      sourceTitle: entry.sourceTitle,
      text: entry.text,
      sourceState: entry.sourceState,
      ownerCardId: entry.ownerCardIds[0],
      refId: entry.refIds[0],
    })),
    duplicateRefs: references.dropped,
    referenceBytes: referencePrefixBytes,
  };
}

/**
 * 兼容旧接口：只要 messages。
 * 编译错误抛带 code 的错误，不吞成空数组——吞掉就等于静默发了个空上下文。
 */
export function buildPlannedMessages(input = {}) {
  const plan = buildContextPlan(input);
  if (plan.errors.length > 0) {
    const first = plan.errors[0];
    const error = new Error(first.message || '上下文编译失败');
    error.code = first.code;
    error.errors = plan.errors;
    throw error;
  }
  return plan.messages;
}

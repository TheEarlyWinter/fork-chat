/**
 * 上下文策略：节点排除（contextMode）与原文引用（contextRefs）的共享纯逻辑。
 *
 * 四种概念在这里划清界限：
 *   - statusStamp 是用户的判断，不是上下文开关；
 *   - parentId/parentIds 是主链依赖，不是引用；
 *   - contextMode 决定这张卡向后代贡献什么；
 *   - contextRefs 是显式选择的原文快照，不递归、不继承。
 *
 * 限额只在这里定义一份，别处不许复制数值。模块不碰 DOM、SDK、存储。
 */

/** 卡片 id 的合法形式，与 fork-session-store 的 ID_REGEX 保持一致 */
const ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;

/** 每张卡最多持有多少条引用 */
export const MAX_REFS_PER_CARD = 16;
/** 单条引用正文的字节上限（UTF-8） */
export const MAX_REF_TEXT_BYTES = 8 * 1024;
/** 来源标题的码点上限 */
export const MAX_REF_SOURCE_TITLE = 200;
/** 一次请求最终引用前缀的字节上限（去重与排除之后） */
export const MAX_REFERENCE_PREFIX_BYTES = 64 * 1024;

export const CONTEXT_MODES = Object.freeze(['include', 'exclude']);

export function contextByteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/**
 * 读模式。缺字段视为 include，这是唯一一个"默认值"，
 * 因为绝大多数字段本来就没写过这个键。
 */
export function getContextMode(card) {
  return card?.contextMode === 'exclude' ? 'exclude' : 'include';
}

/**
 * 规范化写入值。null / 未知值一律拒绝，不悄悄当成 include——
 * 那样写错的策略会被静默吞掉，用户以为排除了，其实没有。
 */
export function normalizeContextMode(value) {
  if (value === undefined || value === 'include') return undefined;
  if (value === 'exclude') return 'exclude';
  throw new RangeError(`contextMode 只能是 include 或 exclude，收到 ${JSON.stringify(value)}`);
}

function isPlainRef(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范化引用数组，重建白名单 DTO 并冻结。
 *
 * 违反限额就直接抛错：不截断、不摘要、不丢一条继续发。
 * 返回 undefined 表示"没有引用"，保存时可以省略字段。
 */
export function normalizeContextRefs(value, { ownerCardId = null } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new TypeError('contextRefs 必须是数组');
  if (value.length === 0) return undefined;
  if (value.length > MAX_REFS_PER_CARD) {
    throw new RangeError(`每张卡最多 ${MAX_REFS_PER_CARD} 条引用，收到 ${value.length} 条`);
  }
  const seen = new Map();
  const normalized = value.map((raw, index) => {
    if (!isPlainRef(raw)) throw new TypeError(`第 ${index + 1} 条引用不是对象`);
    const { id, sourceCardId, sourceTitle, text } = raw;
    if (typeof id !== 'string' || !ID_REGEX.test(id)) {
      throw new RangeError(`第 ${index + 1} 条引用的 id 不合法`);
    }
    if (typeof sourceCardId !== 'string' || !ID_REGEX.test(sourceCardId)) {
      throw new RangeError(`第 ${index + 1} 条引用的 sourceCardId 不合法`);
    }
    if (ownerCardId && sourceCardId === ownerCardId) {
      throw new RangeError(`第 ${index + 1} 条引用指向自己，不允许自引用`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError(`第 ${index + 1} 条引用的正文为空`);
    }
    if (contextByteLength(text) > MAX_REF_TEXT_BYTES) {
      throw new RangeError(`第 ${index + 1} 条引用的正文超过 ${MAX_REF_TEXT_BYTES} 字节`);
    }
    const title = String(sourceTitle ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if ([...title].length > MAX_REF_SOURCE_TITLE) {
      throw new RangeError(`第 ${index + 1} 条引用的来源标题超过 ${MAX_REF_SOURCE_TITLE} 字`);
    }
    if (seen.has(id)) {
      const previous = seen.get(id);
      if (previous.text !== text || previous.sourceCardId !== sourceCardId) {
        throw new RangeError(`引用 id ${id} 重复且内容不同`);
      }
      throw new RangeError(`引用 id ${id} 重复`);
    }
    const ref = { id, sourceCardId, sourceTitle: title, text };
    seen.set(id, ref);
    return Object.freeze(ref);
  });
  return Object.freeze(normalized);
}

/** 历史预算用的体积估计：缓存友好，只算内容不建对象 */
export function estimateReferenceBytes(ref) {
  if (!ref) return 0;
  return contextByteLength(ref.text) + contextByteLength(ref.sourceTitle) + 64;
}

/**
 * 删除预检：删掉这些卡之后，会不会让某条原本被排除的引用
 * 悄悄恢复入模。
 *
 * 规则很保守：只报告「删除集合外仍存活的 owner」指向「删除集合内、且当前是 exclude 的来源」。
 * 有冲突就整次删除拒绝，由调用方在改动任何东西之前拦下。
 */
export function findDeletionReferenceConflicts({ cards = [], deletingIds } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const deleting = deletingIds instanceof Set ? deletingIds : new Set(deletingIds || []);
  const conflicts = [];
  for (const card of list) {
    if (deleting.has(card?.id)) continue; // owner 自己也要删，引用随之消失，不构成冲突
    const refs = Array.isArray(card?.contextRefs) ? card.contextRefs : [];
    for (const ref of refs) {
      const sourceId = ref?.sourceCardId;
      if (!sourceId || !deleting.has(sourceId)) continue;
      const source = list.find(item => item?.id === sourceId);
      if (!source) continue;
      if (getContextMode(source) !== 'exclude') continue;
      conflicts.push({ sourceCardId: sourceId, ownerCardId: card.id, refId: ref.id });
    }
  }
  return conflicts;
}

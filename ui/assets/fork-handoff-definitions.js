/**
 * 交接协议的共享定义：完整性说明的常量与从已验证结构重建说明的纯函数。
 *
 * 这里不导出任何宿主、DOM 或存储能力，也不接受客户端提供的说明文本：
 * 说明由 collectHandoffFacts + buildHandoffNotices 从已验证 DTO 重算，
 * 这样客户端伪造、删改 notices 都不会改变必要告知。
 */

export const HANDOFF_NOTICE_CODES = Object.freeze(Object.fromEntries([
  'SNAPSHOT_ONLY',
  'TARGET_EXCLUDED',
  'EXCLUDED_ANCESTORS',
  'FAILED_MESSAGES',
  'LOCAL_NOTICES_OMITTED',
  'REFERENCE_SOURCE_DELETED',
  'REFERENCE_SOURCE_EXCLUDED',
  'DUPLICATE_REFERENCES_DEDUPED',
  'ORIGINALS_NOT_RETAINED',
  'DUPLICATE_ARTIFACTS_DEDUPED',
  'NEXT_STEP_PENDING',
  'UNSENT_NOT_INCLUDED',
].map(code => [code, code])));

const NOTICE_ORDER = Object.freeze([
  'SNAPSHOT_ONLY',
  'TARGET_EXCLUDED',
  'EXCLUDED_ANCESTORS',
  'FAILED_MESSAGES',
  'LOCAL_NOTICES_OMITTED',
  'REFERENCE_SOURCE_DELETED',
  'REFERENCE_SOURCE_EXCLUDED',
  'DUPLICATE_REFERENCES_DEDUPED',
  'ORIGINALS_NOT_RETAINED',
  'DUPLICATE_ARTIFACTS_DEDUPED',
  'NEXT_STEP_PENDING',
  'UNSENT_NOT_INCLUDED',
]);

/** 统计里确有其事的事实；不读客户端自报的 notices 或统计 */
export function collectHandoffFacts(context) {
  const nodes = Array.isArray(context.nodes) ? context.nodes : [];
  const target = nodes.find(node => node?.cardId === context?.source?.targetCardId);
  let unfinishedCount = 0;
  let attachmentCount = 0;
  let docCount = 0;
  const artifactOccurrences = new Map();
  const bumpArtifact = (id) => {
    if (typeof id !== 'string') return;
    artifactOccurrences.set(id, (artifactOccurrences.get(id) ?? 0) + 1);
  };
  for (const node of nodes) {
    if (node?.doc) docCount++;
    for (const id of Array.isArray(node?.artifactIds) ? node.artifactIds : []) bumpArtifact(id);
    for (const message of Array.isArray(node?.messages) ? node.messages : []) {
      if (message?.status !== 'ok') unfinishedCount++;
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      attachmentCount += attachments.length;
      for (const id of Array.isArray(message?.artifactIds) ? message.artifactIds : []) bumpArtifact(id);
    }
  }
  let deletedSources = 0;
  let excludedSources = 0;
  for (const source of Array.isArray(context?.referenceSources) ? context.referenceSources : []) {
    if (!source?.exists) deletedSources++;
    else if (source.contextMode === 'exclude') excludedSources++;
  }
  return {
    targetExcluded: target?.contextMode === 'exclude',
    excludedCount: Array.isArray(context?.exclusions) ? context.exclusions.length : 0,
    unfinishedCount,
    localNoticeCount: context?.omissions?.localNoticeCount ?? 0,
    deletedSources,
    excludedSources,
    duplicateReferences: (Array.isArray(context?.references) ? context.references : [])
      .some(reference => Array.isArray(reference?.positions) && reference.positions.length > 1),
    duplicateArtifacts: [...artifactOccurrences.values()].some(count => count > 1),
    hasOriginalBodies: docCount > 0 || attachmentCount > 0,
    hasNextStep: Boolean(context?.nextStep),
    unsentCount: Array.isArray(context?.unsent) ? context.unsent.length : 0,
  };
}

const NOTICE_TEXT = Object.freeze({
  SNAPSHOT_ONLY: () => '导入内容只是 App 当前保存的快照，不是原始文件、原始会话或实时画布的逐字副本。',
  TARGET_EXCLUDED: () => '目标节点自身被标记为不向后代贡献正文；本次仍将其纳入，且不修改它的排除设置。',
  EXCLUDED_ANCESTORS: facts => `${facts.excludedCount} 个祖先节点按现有上下文策略被排除，未导入其正文；本次不代表整条原始对话链无遗漏。`,
  FAILED_MESSAGES: facts => `${facts.unfinishedCount} 条消息未正常完成（失败/中断/部分回答），已逐条标注，不能当作已完成结论。`,
  LOCAL_NOTICES_OMITTED: facts => `${facts.localNoticeCount} 条本地提示不是业务内容，未导入。`,
  REFERENCE_SOURCE_DELETED: facts => `${facts.deletedSources} 条引用的来源已不可定位，只保留保存时的引用快照。`,
  REFERENCE_SOURCE_EXCLUDED: facts => `${facts.excludedSources} 条引用因来源被排除而未导入正文。`,
  DUPLICATE_REFERENCES_DEDUPED: () => '相同内容的重复引用已合并，引用位置全部保留。',
  ORIGINALS_NOT_RETAINED: () => '资料与附件的原文件没有随交接保留，这里只有 App 保存的解析正文。',
  DUPLICATE_ARTIFACTS_DEDUPED: () => '同一产物在多个位置出现，按不可变产物标识去重交付。',
  NEXT_STEP_PENDING: () => '下一步要求只是写入交接正文的待执行文字，不会自动发送，也不会启动模型。',
  UNSENT_NOT_INCLUDED: () => '所选分支还有未发送的草稿或暂存附件，它们没有纳入本次交接。',
});

/** 从事实重建完整说明列表；顺序固定，客户端无法增删 */
export function buildHandoffNotices(context) {
  const facts = collectHandoffFacts(context);
  const notices = [];
  for (const code of NOTICE_ORDER) {
    if (code === 'TARGET_EXCLUDED' && !facts.targetExcluded) continue;
    if (code === 'EXCLUDED_ANCESTORS' && facts.excludedCount === 0) continue;
    if (code === 'FAILED_MESSAGES' && facts.unfinishedCount === 0) continue;
    if (code === 'LOCAL_NOTICES_OMITTED' && facts.localNoticeCount === 0) continue;
    if (code === 'REFERENCE_SOURCE_DELETED' && facts.deletedSources === 0) continue;
    if (code === 'REFERENCE_SOURCE_EXCLUDED' && facts.excludedSources === 0) continue;
    if (code === 'DUPLICATE_REFERENCES_DEDUPED' && !facts.duplicateReferences) continue;
    if (code === 'ORIGINALS_NOT_RETAINED' && !facts.hasOriginalBodies) continue;
    if (code === 'DUPLICATE_ARTIFACTS_DEDUPED' && !facts.duplicateArtifacts) continue;
    if (code === 'NEXT_STEP_PENDING' && !facts.hasNextStep) continue;
    if (code === 'UNSENT_NOT_INCLUDED' && facts.unsentCount === 0) continue;
    notices.push({ code, message: NOTICE_TEXT[code](facts) });
  }
  return notices;
}

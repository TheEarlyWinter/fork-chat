import { normalizeArtifactList } from './artifact-contract.js';
import { groupArtifactVersions } from './artifact-versions.js';

/*
 * 会话级文档面板的纯数据层（2.2 专项②）。
 *
 * 从画布全部卡片的消息里聚合文档资产视图：
 * - 每个版本组一条记录：rootId、最新版、全部版本、来源卡片/消息定位；
 * - 版本组数据只来自 messages.artifacts（版本组的家），artifactRefs 仅用于
 *   「引用过该文档的卡片」提示，不参与版本聚合（引用不是版本）；
 * - 输出按最新版 createdAt 倒序；非法元数据经 normalize 哨兵过滤。
 * 纯函数、无 DOM：视图层（panel-artifact-panel.js）负责渲染与操作。
 */

/** @returns {Array<{rootId, current, versions: Array, sourceCardId, sourceRequestId, referencedBy: Array<{cardId, cardTitle}>}>} */
export function collectSessionArtifacts({ cards = [] } = {}) {
  const byRoot = new Map();
  const cardList = Array.isArray(cards) ? cards : [];
  for (const card of cardList) {
    const messages = Array.isArray(card?.messages) ? card.messages : [];
    for (const message of messages) {
      const versions = normalizeArtifactList(message?.artifacts);
      for (const artifact of versions) {
        const rootId = artifact.revisionRootId || artifact.artifactId;
        let entry = byRoot.get(rootId);
        if (!entry) {
          entry = { rootId, versions: [], sourceCardId: card.id, sourceCardTitle: card.title || '', sourceRequestId: message.requestId || '', referencedBy: [] };
          byRoot.set(rootId, entry);
        }
        if (!entry.versions.some(item => item.artifactId === artifact.artifactId)) entry.versions.push(artifact);
      }
    }
  }
  // 引用关系：refs 指到版本组（按 revisionRootId 或 artifactId 归属）
  for (const card of cardList) {
    const messages = Array.isArray(card?.messages) ? card.messages : [];
    for (const message of messages) {
      const refs = normalizeArtifactList(message?.artifactRefs);
      for (const ref of refs) {
        const rootId = ref.revisionRootId || ref.artifactId;
        const entry = byRoot.get(rootId);
        if (entry && !entry.referencedBy.some(item => item.cardId === card.id)) {
          entry.referencedBy.push({ cardId: card.id, cardTitle: card.title || '' });
        }
      }
    }
  }
  return Array.from(byRoot.values())
    .map(entry => {
      const groups = groupArtifactVersions(entry.versions);
      const current = groups.length === 1 ? groups[0].current : entry.versions.at(-1);
      const sorted = groups.length === 1 ? groups[0].versions : entry.versions;
      return { ...entry, current, versions: sorted };
    })
    .sort((a, b) => String(b.current?.createdAt || '').localeCompare(String(a.current?.createdAt || '')));
}

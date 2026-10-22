/**
 * 画布历史撤销与重做控制器模块
 *
 * 封装 createHistoryManager 实例创建，并提供 onRestore 适配层：
 * 布局撤销只回填几何与结构属性（x, y, width, height, isCollapsed, zIndex, parentId, parentIds, statusStamp），
 * 业务内容（messages, docContent, 附件, 标记等）以当前卡片为准；
 * 若卡片被删除，则优先从 removedCardArchive 恢复完整历史内容。
 * 严禁在顶层访问裸 window 或 document，不反向依赖 panel.js。
 */

import { createHistoryManager } from './panel-history.js';

export function createHistoryController(deps) {
  const {
    getCards,
    setCards,
    getSelectedCardId,
    setSelectedCardId,
    getRemovedCardArchive,
    removedCardArchive,
    renderCards,
    renderConnectors,
    scheduleSave,
    isDisposed,
    maxDepth = 30,
  } = deps;

  const checkDisposed = () => (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));
  const getArchive = () => (typeof getRemovedCardArchive === 'function' ? getRemovedCardArchive() : removedCardArchive);

  const LIVE_KEYS = ['x', 'y', 'width', 'height', 'isCollapsed', 'zIndex', 'parentId', 'parentIds', 'statusStamp'];

  const historyManager = createHistoryManager({
    maxDepth,
    onRestore: (restoredCards, restoredSelectedId) => {
      if (checkDisposed()) return;
      const currentCards = getCards ? getCards() : [];
      const liveById = new Map((currentCards || []).map(c => [c.id, c]));
      const archive = getArchive();
      const merged = [];

      for (const snap of restoredCards) {
        const live = liveById.get(snap.id);
        if (!live) {
          // 快照里有、现在没有：这张卡是被删掉的。
          // 先用删除时留档的完整内容，实在没有才退回快照。
          const remembered = archive?.get?.(snap.id);
          merged.push(remembered ? { ...remembered } : snap);
          continue;
        }
        for (const key of LIVE_KEYS) {
          if (snap[key] !== undefined) live[key] = snap[key];
        }
        liveById.delete(snap.id);
        merged.push(live);
      }

      if (setCards) setCards(merged);
      if (setSelectedCardId) {
        setSelectedCardId(restoredSelectedId && merged.some(c => c.id === restoredSelectedId) ? restoredSelectedId : null);
      }
      renderCards?.();
      renderConnectors?.();
      scheduleSave?.();
    },
  });

  return historyManager;
}

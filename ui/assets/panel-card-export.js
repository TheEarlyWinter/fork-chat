/**
 * 两种导出：结构大纲（只有节点与父边）和整链 Markdown（带全文）。
 *
 * 屏幕上看不见的排版差异在这里不处理，这里只管拿到文本、复制出去、报结果。
 * 绑定逻辑和面板其它按钮同形：谁点、点完调哪个函数、失败怎么提示。
 */

/**
 * 把两个导出按钮接到各自的按钮上。按钮不存在就跳过——不是每张卡都带导出入口。
 *
 * @param {object} args
 * @param {Element} args.cardEl 卡片根节点
 * @param {object} args.card 卡片数据
 * @param {Function} args.on 绑定函数（由调用方提供，负责登记到清理列表）
 * @param {() => boolean} args.getIsDisposed
 * @param {() => Array} args.cardsNow
 * @param {Array} args.cardParentIds
 * @param {Function} args.buildTopologyOutline
 * @param {Function} args.findCardAncestorChain
 * @param {Function} args.formatCardChainMarkdown
 * @param {(text: string) => Promise<void>} args.copyText
 * @param {Function} args.flashMessage
 * @param {Function} args.safeDetail
 */
export function bindCardExportHandlers({
  cardEl, card, on, getIsDisposed, cardsNow, cardParentIds,
  buildTopologyOutline, findCardAncestorChain, formatCardChainMarkdown,
  copyText, flashMessage, safeDetail,
}) {
  if (!cardEl || !card || typeof on !== 'function') return;

  // 结构大纲：只导节点与父边，不含正文，可以放心给人看
  const btnExportTopology = cardEl.querySelector('[data-action="export-topology"]');
  if (btnExportTopology) {
    on(btnExportTopology, 'click', async (e) => {
      e.stopPropagation();
      if (getIsDisposed()) return;
      try {
        const outline = buildTopologyOutline({
          cards: cardsNow(),
          targetCard: card,
          title: `结构大纲：${card.title || '长文'}`,
        });
        await copyText(outline);
        flashMessage('已复制结构大纲（只含节点与父边，不含正文）');
      } catch (err) {
        flashMessage(`结构大纲导出失败：${safeDetail(err?.message || String(err))}`);
      }
    });
  }

  // 顺藤摸瓜：整链导出为 Markdown 并复制
  const btnExportChain = cardEl.querySelector('[data-action="export-chain"]');
  if (btnExportChain) {
    on(btnExportChain, 'click', async (e) => {
      e.stopPropagation();
      if (getIsDisposed()) return;
      const chain = findCardAncestorChain({ cards: cardsNow(), targetCardId: card.id, cardParentIds });
      if (!chain || chain.length === 0) {
        flashMessage('未找到该卡片的推导链路');
        return;
      }
      const markdown = formatCardChainMarkdown(chain, { title: `链路推导：${card.title || '长文'}` });
      try {
        await copyText(markdown);
        flashMessage(`已顺藤摸瓜将 ${chain.length} 个节点的完整推导长文复制到剪贴板！`);
      } catch (err) {
        flashMessage(`导出复制失败：${safeDetail(err?.message || String(err))}`);
      }
    });
  }
}

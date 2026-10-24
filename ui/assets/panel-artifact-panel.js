import { collectSessionArtifacts } from './artifact-session-index.js';
import { escapeHtml, formatFileSize } from './panel-format.js';

/*
 * 会话级文档面板（2.2 专项②）：画布全部文档资产的独立入口。
 *
 * 形态：顶栏「文档」按钮 → 全屏 overlay 列出本会话全部版本组
 * （最新版优先、倒序），每条可预览/另存当前版本，展开看完整版本链，
 * 并标注引用过该文档的卡片。操作沿用 data-artifact-action 契约，
 * 由 panel-artifact-view.js 的既有 actions（owner 鉴权）执行——
 * 面板只做展示与定位，不另开权限通道、不复制文件。
 *
 * DOM 从 deps 注入（与 contextPreview 同规矩），身份失效即关。
 */

const versionLabel = file => file.revisedFrom ? `v${file.version}` : 'v1';

export function createArtifactPanel(deps = {}) {
  for (const key of ['getDocument', 'getCards']) {
    if (typeof deps[key] !== 'function') throw new TypeError(`createArtifactPanel 缺少依赖：${key}`);
  }
  const { getDocument, getCards, getGeneration = () => null, locateCard = () => {}, onAction = () => false } = deps;
  // onAction(artifactId, action, event)：预览/另存的真实执行器由调用方注入
  // （复用 panel-artifact-view 的 createArtifactActions 语义）；返回 true 表示已处理。

  let overlay = null;
  let disposed = false;

  function doc() { return getDocument(); }
  function el(tag, className, text) {
    const node = doc().createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function artifactRow(file) {
    const row = el('div', 'artifact-panel-version');
    const meta = el('span', 'artifact-panel-version-meta',
      `${versionLabel(file)} · ${file.name} · ${formatFileSize(file.bytes)} · ${file.createdAt.slice(0, 10)}`);
    row.appendChild(meta);
    for (const [action, label] of [['preview', '预览'], ['save', '另存']]) {
      const btn = el('button', 'artifact-panel-version-btn', label);
      btn.type = 'button';
      btn.dataset.artifactAction = action;
      btn.dataset.artifactId = file.artifactId;
      row.appendChild(btn);
    }
    return row;
  }

  function entryNode(entry, index) {
    const node = el('details', 'artifact-panel-entry');
    node.dataset.panelRootId = entry.rootId;
    const summary = el('summary', 'artifact-panel-summary');
    const badge = el('span', 'artifact-file-badge', entry.current.format.toUpperCase());
    const name = el('strong', null, entry.current.name);
    const versionTag = el('span', 'artifact-panel-version-tag',
      entry.versions.length > 1 ? `${entry.versions.length} 个版本 · 最新 v${entry.current.version}` : '单版本 v1');
    summary.append(badge, name, versionTag);
    node.appendChild(summary);

    const body = el('div', 'artifact-panel-entry-body');
    const currentRow = el('div', 'artifact-panel-current');
    currentRow.appendChild(el('span', 'artifact-panel-version-meta',
      `最新版 ${formatFileSize(entry.current.bytes)} · 来自「${entry.sourceCardTitle || entry.sourceCardId}」`));
    for (const [action, label] of [['preview', '预览最新'], ['save', '另存最新']]) {
      const btn = el('button', 'artifact-panel-version-btn', label);
      btn.type = 'button';
      btn.dataset.artifactAction = action;
      btn.dataset.artifactId = entry.current.artifactId;
      currentRow.appendChild(btn);
    }
    body.appendChild(currentRow);

    if (entry.versions.length > 1) {
      const chain = el('details', 'artifact-panel-chain');
      chain.appendChild(el('summary', null, `版本记录（${entry.versions.length}）`));
      for (const file of entry.versions) chain.appendChild(artifactRow(file));
      body.appendChild(chain);
    }

    if (entry.referencedBy.length) {
      const refs = el('div', 'artifact-panel-refs');
      refs.appendChild(el('span', 'artifact-panel-version-meta', '引用过：'));
      for (const ref of entry.referencedBy) {
        const btn = el('button', 'artifact-panel-ref-link', ref.cardTitle || ref.cardId);
        btn.type = 'button';
        btn.dataset.locateCardId = ref.cardId;
        refs.appendChild(btn);
      }
      body.appendChild(refs);
    }
    if (index === 0) node.open = true;
    node.appendChild(body);
    return node;
  }

  function close() {
    if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  return {
    /** 打开面板；返回聚合结果供测试核对 */
    show() {
      if (disposed) return null;
      const ownerDoc = doc();
      if (!ownerDoc) return null;
      close();
      const entries = collectSessionArtifacts({ cards: getCards() });
      overlay = el('div', 'artifact-panel-overlay');
      const panel = el('div', 'artifact-panel');
      const header = el('div', 'artifact-panel-header');
      header.appendChild(el('h2', 'artifact-panel-title', `会话文档 · ${entries.length} 份`));
      const closeBtn = el('button', 'artifact-panel-close', '×');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', close);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      const list = el('div', 'artifact-panel-list');
      if (!entries.length) {
        list.appendChild(el('p', 'artifact-panel-empty', '本会话还没有生成或导入过文档。'));
      } else {
        entries.forEach((entry, index) => list.appendChild(entryNode(entry, index)));
      }
      panel.appendChild(list);
      overlay.appendChild(panel);
      overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
      overlay.addEventListener('click', event => {
        const actionBtn = event.target?.closest?.('[data-artifact-action]');
        if (actionBtn) {
          event.preventDefault(); event.stopPropagation();
          onAction(actionBtn.dataset.artifactId, actionBtn.dataset.artifactAction, event);
          return;
        }
        const locate = event.target?.closest?.('[data-locate-card-id]');
        if (locate) { close(); locateCard(locate.dataset.locateCardId); }
      });
      const onKey = event => { if (event.key === 'Escape') close(); };
      ownerDoc.addEventListener('keydown', onKey);
      ownerDoc.body.appendChild(overlay);
      return entries;
    },
    close,
    dispose() { if (!disposed) { disposed = true; close(); } },
    isOpen: () => Boolean(overlay),
  };
}

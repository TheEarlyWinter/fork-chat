/**
 * panel-cards.js
 * 画布卡片 DOM 结构组装、尺寸拖拽约束与卡片内部交互组件引擎
 */

export const MIN_CARD_WIDTH = 340;
export const MAX_CARD_WIDTH = 720;
export const MIN_CARD_HEIGHT = 240;
export const MAX_CARD_HEIGHT = 1200;

/**
 * 限制卡片宽度在合法安全区间内
 */
export function clampCardWidth(width, min = MIN_CARD_WIDTH, max = MAX_CARD_WIDTH) {
  if (typeof width !== 'number' || Number.isNaN(width)) return min;
  return Math.min(Math.max(width, min), max);
}

/**
 * 限制卡片高度在合法安全区间内
 */
export function clampCardHeight(height, min = MIN_CARD_HEIGHT, max = MAX_CARD_HEIGHT) {
  if (typeof height !== 'number' || Number.isNaN(height)) return min;
  return Math.min(Math.max(height, min), max);
}

/**
 * 组装单张卡片的完整内部 HTML 结构（纯函数）
 */
export function buildCardHtml({
  card,
  currentAgent = {},
  isSelected = false,
  isMultiSelected = false,
  isBusy = false,
  chainBusy = false,
  escapeHtml = (s) => String(s || ''),
  messageMarkup = () => '',
  statusText = () => '',
  formatFileSize = (s) => `${s} B`,
  isReady = true,
}) {
  if (!card) return '';

  const isBranch = Boolean(card.parentId || (Array.isArray(card.parentIds) && card.parentIds.length > 0));
  const isBattle = Boolean(card.isBattle || card.title?.startsWith('对比 #'));
  const isMerge = Boolean(card.isMerge || card.title?.startsWith('合并总结'));
  const isDoc = Boolean(card.isDoc);

  const dotStyle = isDoc
    ? 'background-color: #18181b; border-radius: 1px;'
    : (isMerge
      ? 'background-color: #18181b; border-radius: 2px;'
      : (isBattle
        ? 'background-color: #18181b;'
        : (isBranch ? 'background-color: #71717a;' : '')));

  const originTag = isDoc
    ? '<span class="card-origin-tag tag-doc">[资料源]</span>'
    : (isMerge
      ? '<span class="card-origin-tag tag-merge">[合并总结]</span>'
      : (isBattle
        ? '<span class="card-origin-tag tag-battle">[对比推导]</span>'
        : (isBranch ? '<span class="card-origin-tag">[追问分支]</span>' : '')));

  const sourceRefHtml = card.sourceRef ? `
    <div class="source-ref-badge" title="导入时的会话标题快照：${escapeHtml(card.sourceRef.titleAtImport || '')}">
      本体导入快照 · ${escapeHtml(card.sourceRef.titleAtImport || card.sourceRef.sessionId)}
      <button type="button" data-action="jump-source">跳回本体</button>
    </div>
  ` : '';

  const messagesHtml = (card.messages || []).map(m => `
    <div class="msg-row ${m.role === 'user' ? 'msg-user' : 'msg-asst'}">
      <span class="msg-role">${m.role === 'user' ? 'User' : escapeHtml(m.agentName || currentAgent.name || 'Assistant')}</span>
      ${messageMarkup(m)}
      ${m.requestId ? `<div class="request-status" id="status-${m.requestId}" role="status">${escapeHtml(statusText(m))}</div>` : ''}
    </div>
  `).join('');

  const attachmentsHtml = Array.isArray(card.stagedAttachments) && card.stagedAttachments.length > 0 ? `
    <div class="staged-attachments-bar">
      ${card.stagedAttachments.map((att, idx) => `
        <div class="staged-att-chip" title="${escapeHtml(att.name)} (${formatFileSize(att.size)})">
          <span class="staged-att-name">${escapeHtml(att.name)}</span>
          <span class="staged-att-size">${formatFileSize(att.size)}</span>
          <button class="staged-att-remove" data-action="remove-attachment" data-index="${idx}" title="移除附件">×</button>
        </div>
      `).join('')}
    </div>
  ` : '';

  const placeholder = isDoc ? '输入关于此文档的问题...' : '输入对话或追问...';
  const inputDisabled = !isReady ? 'disabled' : '';

  return `
    <div class="card-header" data-drag-handle="true">
      <div class="card-title-box">
        <div class="card-dot" style="${dotStyle}"></div>
        <span class="card-title">${escapeHtml(card.title)}</span>
        ${originTag}
      </div>
      <button class="card-close-btn" title="关闭卡片" data-action="close">×</button>
    </div>
    ${sourceRefHtml}

    <div class="card-body" id="body-${card.id}">
      ${messagesHtml}
    </div>

    <div class="card-footer">
      ${attachmentsHtml}
      <div class="card-input-row">
        <button class="btn-card-attach" data-action="attach" title="添加文档资料附件" ${chainBusy ? 'disabled' : ''}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <input type="text" class="card-input" placeholder="${placeholder}" id="input-${card.id}" ${inputDisabled}>
        <button class="card-send-btn" data-action="send" ${chainBusy ? 'disabled' : ''}>发送</button>
        <button class="card-send-btn btn-card-battle" data-action="battle" ${chainBusy ? 'disabled' : ''} title="多模型横向推导 / 对抗">对比 ▾</button>
        <button class="card-send-btn" data-action="cancel" ${isBusy ? '' : 'hidden'}>取消</button>
      </div>
      <input type="file" id="file-${card.id}" class="card-file-input" style="display: none;" accept=".md,.markdown,.txt,.docx,.pdf,.json,.csv,.py,.js,.ts,.html,.css,.yml,.yaml,.xml,.sh,.sql" multiple>
    </div>

    <!-- 右侧连线追问与对比锚点组 -->
    <div class="branch-anchors-group">
      <div class="branch-anchor-btn" data-action="branch" role="button" aria-disabled="${chainBusy}" title="${chainBusy ? '请等待当前路径请求结束后再分叉' : (isDoc ? '从此资料开辟分析' : '从这里开辟追问分支')}">
        +
        <div class="branch-tooltip">${isDoc ? '从此资料开辟分析' : '从此拉出追问'}</div>
      </div>
      <div class="branch-anchor-btn btn-anchor-battle" data-action="branch-battle" role="button" aria-disabled="${chainBusy}" title="${chainBusy ? '请等待当前路径请求结束后再分叉' : '多模型横向对比分支'}">
        ⑂
        <div class="branch-tooltip">对比分支</div>
      </div>
    </div>

    <!-- 2D 自由拉伸手柄组：右边缘(宽)、底边缘(高)、右下角(宽高对角) -->
    <div class="card-resize-handle handle-right" data-action="resize-card" data-direction="right" title="按住拖拽调整卡片宽度"></div>
    <div class="card-resize-handle handle-bottom" data-action="resize-card" data-direction="bottom" title="按住拖拽调整卡片高度"></div>
    <div class="card-resize-handle handle-corner" data-action="resize-card" data-direction="corner" title="按住拖拽同时调整宽高"></div>
  `;
}

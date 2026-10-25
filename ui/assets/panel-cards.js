/**
 * panel-cards.js
 * 画布卡片 DOM 结构组装、尺寸拖拽约束与卡片内部交互组件引擎
 */

/**
 * 默认转义器：同时处理 & < > " '。
 * 供未传入 escapeHtml 的调用方兼底，避免默认行为退化成无转义。
 */
function defaultEscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const MIN_CARD_WIDTH = 340;
export const MAX_CARD_WIDTH = 720;
export const MIN_CARD_HEIGHT = 240;
export const MAX_CARD_HEIGHT = 1200;

/**
 * 创建新画布的初始卡片模型
 */
export function createInitialCard() {
  return {
    id: 'card-1',
    parentId: null,
    title: '主线对话 #01',
    x: 80,
    y: 80,
    width: 340,
    messages: [
      {
        role: 'assistant',
        localOnly: true,
        text: '你好！这里是你的第一张对话卡片。\n\n在下方输入框打入你想聊的内容开启主线；随时点击卡片右侧的 [+] 按钮，即可开辟一条独立的追问分支。'
      }
    ]
  };
}

export function createInitialCards() {
  return [createInitialCard()];
}

/**
 * 展示暂态：更新卡片输入草稿（逐字保留，含纯空格与换行）
 */
export function setCardDraft(card, draft) {
  if (!card) return;
  card.draft = String(draft ?? '');
}

/**
 * 展示暂态：显式清除卡片输入草稿
 */
export function clearCardDraft(card) {
  if (!card) return;
  delete card.draft;
}

export function getCardDraft(card) {
  return typeof card?.draft === 'string' ? card.draft : '';
}

/**
 * 展示暂态：更新助手思考/副栏的展开状态
 */
export function setMessageAsidesOpen(message, open) {
  if (!message) return;
  if (typeof open === 'boolean') {
    message.asidesOpen = open;
  } else {
    delete message.asidesOpen;
  }
}

/**
 * 展示暂态：标记卡片是否需滚动到底部
 */
export function setCardScrollToEnd(card, scrollToEnd) {
  if (!card) return;
  if (Boolean(scrollToEnd)) {
    card.scrollToEnd = true;
  } else {
    delete card.scrollToEnd;
  }
}

/**
 * 展示暂态：记录或清除卡片主体滚动高度（保留合法 0 滚动位置，不当作缺省）
 */
export function setCardSavedScrollTop(card, scrollTop) {
  if (!card) return;
  if (typeof scrollTop === 'number' && !Number.isNaN(scrollTop) && scrollTop >= 0) {
    card.savedScrollTop = scrollTop;
  } else if (scrollTop === undefined) {
    delete card.savedScrollTop;
  }
}

/**
 * 几何尺寸与坐标更新命令：部分更新必须保留未提供字段，使用 hasOwn 判定
 */
export function setCardGeometry(card, patch) {
  if (!card || !patch || typeof patch !== 'object') return;
  if (Object.hasOwn(patch, 'x') && typeof patch.x === 'number' && !Number.isNaN(patch.x)) {
    card.x = patch.x;
  }
  if (Object.hasOwn(patch, 'y') && typeof patch.y === 'number' && !Number.isNaN(patch.y)) {
    card.y = patch.y;
  }
  if (Object.hasOwn(patch, 'width')) {
    if (typeof patch.width === 'number' && !Number.isNaN(patch.width)) {
      card.width = patch.width;
    } else if (patch.width === undefined) {
      delete card.width;
    }
  }
  if (Object.hasOwn(patch, 'height')) {
    if (typeof patch.height === 'number' && !Number.isNaN(patch.height)) {
      card.height = patch.height;
    } else if (patch.height === undefined) {
      delete card.height;
    }
  }
}

/**
 * 完整历史快照恢复：回填几何与结构字段，快照中缺省的字段予以删除，保留活对象身份与原始数值
 */
export function applyCardTopologySnapshot(card, snapshot, keys = [
  'parentId', 'parentIds', 'title', 'x', 'y', 'width', 'height',
  'isCollapsed', 'zIndex', 'isDoc', 'isBattle', 'isMerge', 'statusStamp',
  // 上下文策略也是用户操作结果，默认调用同样要还原它
  'contextMode', 'contextRefs',
]) {
  if (!card || !snapshot || typeof snapshot !== 'object') return;
  for (const key of keys) {
    if (key === 'id') continue;
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      delete card[key];
      continue;
    }
    if (key === 'contextRefs' && Array.isArray(snapshot[key])) {
      // 恢复出来的引用数组同样只读：展开成普通数组会让人直接 push 进去
      card[key] = Object.freeze([...snapshot[key]]);
      continue;
    }
    card[key] = Array.isArray(snapshot[key]) ? [...snapshot[key]] : snapshot[key];
  }
}

/**
 * 拓扑结构：更新卡片子树折叠状态
 */
export function setCardCollapsed(card, isCollapsed) {
  if (!card) return;
  if (Boolean(isCollapsed)) {
    card.isCollapsed = true;
  } else {
    delete card.isCollapsed;
  }
}

/**
 * 标记状态：更新卡片状态徽章
 */
export function setCardStatusStamp(card, statusStamp) {
  if (!card) return;
  if (typeof statusStamp === 'string' && statusStamp) {
    card.statusStamp = statusStamp;
  } else {
    delete card.statusStamp;
  }
}

/**
 * 视觉层级：更新卡片 zIndex
 */
export function setCardZIndex(card, zIndex) {
  if (!card) return;
  if (typeof zIndex === 'number' && !Number.isNaN(zIndex)) {
    card.zIndex = zIndex;
  } else {
    delete card.zIndex;
  }
}

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
 * 循环切换卡片的状态标记：
 * null/undefined -> 'starred' (星标关注) -> 'accepted' (采纳方案) -> 'rejected' (否决放弃) -> null (清除复位)
 * @param {string|null|undefined} currentStamp
 * @returns {'starred'|'accepted'|'rejected'|null}
 */
export function cycleCardStatusStamp(currentStamp) {
  if (!currentStamp) return 'starred';
  if (currentStamp === 'starred') return 'accepted';
  if (currentStamp === 'accepted') return 'rejected';
  return null;
}

/**
 * 卡片父边：parentId 与 parentIds 合并去重。
 *
 * 这是拓扑唯一入口，panel-context 与编译器都从这里取，
 * 免得各自实现一份「父亲是谁」的规则。
 */
export function cardParentIds(card) {
  return Array.from(new Set([
    ...(card?.parentId ? [card.parentId] : []),
    ...(Array.isArray(card?.parentIds) ? card.parentIds : []),
  ]));
}

export function cardHasParent(card, parentId) {
  return cardParentIds(card).includes(parentId);
}

/**
 * 向上递归回溯祖先节点，得到从根到目标的去重链路（后序）。
 *
 * 后序是关键：父节点先入链，子节点后入链，顺序与既有编译输出一致。
 * 已访问集合顺带做防环保护，菱形结构里的公共祖先只出现一次。
 */
export function collectChainCards({ cards = [], targetCard } = {}) {
  const cardList = Array.isArray(cards) ? cards : [];
  const chain = [];
  const added = new Set();
  const visiting = new Set();
  function visit(card) {
    if (!card || added.has(card.id)) return;
    if (visiting.has(card.id)) return;
    visiting.add(card.id);
    for (const parentId of cardParentIds(card)) {
      visit(cardList.find(item => item.id === parentId));
    }
    visiting.delete(card.id);
    added.add(card.id);
    chain.push(card);
  }
  visit(targetCard);
  return chain;
}

/**
 * 沿 DAG / 树溯源追溯目标卡片的所有祖先，返回拓扑有序且去重的根到叶卡片数组
 * @param {object} options
 * @param {Array<object>} options.cards
 * @param {string} options.targetCardId
 * @param {Function} [options.cardParentIds]
 * @returns {Array<object>}
 */
export function findCardAncestorChain({ cards = [], targetCardId, cardParentIds } = {}) {
  if (!Array.isArray(cards) || !targetCardId) return [];
  const cardMap = new Map(cards.map(c => [c.id, c]));
  const target = cardMap.get(targetCardId);
  if (!target) return [];

  const resolveParentIds = (card) => {
    if (typeof cardParentIds === 'function') {
      const res = cardParentIds(card);
      if (Array.isArray(res)) return res;
    }
    const ids = [];
    if (card?.parentId) ids.push(card.parentId);
    if (Array.isArray(card?.parentIds)) ids.push(...card.parentIds);
    return Array.from(new Set(ids));
  };

  const visited = new Set();
  const chain = [];
  const activePath = new Set();

  function dfs(currId) {
    if (!currId || visited.has(currId) || activePath.has(currId)) return;
    const card = cardMap.get(currId);
    if (!card) return;

    activePath.add(currId);
    const pIds = resolveParentIds(card);
    for (const pId of pIds) {
      dfs(pId);
    }
    activePath.delete(currId);

    if (!visited.has(currId)) {
      visited.add(currId);
      chain.push(card);
    }
  }

  dfs(targetCardId);
  return chain;
}

/**
 * 将整条推导链路卡片格式化为整齐的 Markdown 文档
 * @param {Array<object>} chainCards
 * @param {object} [options]
 * @param {string} [options.title]
 * @returns {string}
 */
export function formatCardChainMarkdown(chainCards = [], { title } = {}) {
  if (!Array.isArray(chainCards) || chainCards.length === 0) return '';
  const lastCard = chainCards[chainCards.length - 1];
  const docTitle = title || lastCard?.title || '完整推演链路';

  const lines = [
    `# ${docTitle}`,
    '',
    `> 导出自分叉对话 · 共 ${chainCards.length} 个思考节点`,
    '',
    '---',
    '',
  ];

  chainCards.forEach((card, index) => {
    let stampText = '';
    if (card.statusStamp === 'starred') stampText = ' [星标]';
    else if (card.statusStamp === 'accepted') stampText = ' [已采纳]';
    else if (card.statusStamp === 'rejected') stampText = ' [已否决]';

    lines.push(`## 节点 ${index + 1}：${card.title || '卡片'}${stampText}`);
    lines.push('');

    const messages = Array.isArray(card.messages) ? card.messages : [];

    // 资料卡的正文本身是内容，不是"附件"。以前只导 messages，导出来的
    // 链路里那张文档卡是空的，看着像没内容。
    if (typeof card.docContent === 'string' && card.docContent.trim()) {
      lines.push('### 资料正文');
      lines.push('');
      lines.push(card.docContent.trim());
      lines.push('');
    }
    if (Array.isArray(card.stagedAttachments) && card.stagedAttachments.length) {
      lines.push('### 附件');
      lines.push('');
      card.stagedAttachments.forEach(att => {
        const label = att?.name || '附件';
        lines.push(`#### ${label}`);
        lines.push('');
        if (typeof att?.content === 'string' && att.content.trim()) {
          lines.push(att.content.trim());
        } else {
          lines.push(`*（仅有文件名，未保存正文）*`);
        }
        lines.push('');
      });
    }

    if (messages.length === 0 && !(typeof card.docContent === 'string' && card.docContent.trim())) {
      lines.push('*（暂无对话内容）*');
      lines.push('');
    } else {
      messages.forEach(msg => {
        const isUser = msg.role === 'user';
        const roleLabel = isUser ? 'User' : (msg.agentName ? `Assistant (${msg.agentName})` : 'Assistant');
        // 未完成的回答不能冒充完整推导，导出时如实标出来
        const badges = [];
        if (msg.status === 'failed') badges.push('失败/未完成');
        else if (msg.status === 'cancelled') badges.push('已中断');
        if (msg.partial) badges.push('部分内容');
        if (msg.localOnly) badges.push('本地提示');
        lines.push(`### ${roleLabel}${badges.length ? ` · ${badges.join(' / ')}` : ''}`);
        lines.push('');
        lines.push(msg.text ? msg.text.trim() : '');
        lines.push('');
        if (Array.isArray(msg.attachments) && msg.attachments.length) {
          msg.attachments.forEach(att => {
            const label = att?.name || '附件';
            lines.push(`#### 附件：${label}`);
            lines.push('');
            if (typeof att?.content === 'string' && att.content.trim()) {
              lines.push(att.content.trim());
            } else {
              lines.push(`*（仅有文件名，未保存正文）*`);
            }
            lines.push('');
          });
        }
      });
    }

    lines.push('---');
    lines.push('');
  });

  return lines.join('\n').trim() + '\n';
}

/**
 * 组装单张卡片的完整内部 HTML 结构（纯函数）
 */
export function buildCardHtml({
  card,
  childCount = 0,
  currentAgent = {},
  isSelected = false,
  isMultiSelected = false,
  isBusy = false,
  chainBusy = false,
  escapeHtml = defaultEscapeHtml,
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

  let stampBadge = '';
  if (card.statusStamp === 'starred') {
    stampBadge = '<span class="card-stamp-badge stamp-starred" data-status-stamp="starred" title="星标关注方案">★</span>';
  } else if (card.statusStamp === 'accepted') {
    stampBadge = '<span class="card-stamp-badge stamp-accepted" data-status-stamp="accepted" title="最终采纳方案">✓ [已采纳]</span>';
  } else if (card.statusStamp === 'rejected') {
    stampBadge = '<span class="card-stamp-badge stamp-rejected" data-status-stamp="rejected" title="已否决方案">✗ [已否决]</span>';
  }

  const stampBtnTitle = card.statusStamp === 'starred'
    ? '当前：星标关注 (点击切换为采纳)'
    : (card.statusStamp === 'accepted'
      ? '当前：已采纳方案 (点击切换为否决)'
      : (card.statusStamp === 'rejected'
        ? '当前：已否决 (点击清除标记)'
        : '标记方案状态 (星标/采纳/否决)'));

  const stampBtnIcon = card.statusStamp === 'starred'
    ? '★'
    : (card.statusStamp === 'accepted'
      ? '✓'
      : (card.statusStamp === 'rejected' ? '✗' : '☆'));

  const truncatedHtml = card.docContentTruncated
    ? `<div class="bridge-warn" title="存储上限 ${card.docContentTruncated.kept} 字符">正文超出存储上限，只保留了 ${card.docContentTruncated.kept} / ${card.docContentTruncated.original} 字符</div>`
    : (card.stagedAttachmentsDropped
      ? `<div class="bridge-warn">附件过多，有 ${card.stagedAttachmentsDropped} 个没有保存</div>`
      : '');

  const hasChildren = typeof childCount === 'number' && childCount > 0;
  const isCollapsed = Boolean(card.isCollapsed);

  const collapsedPillHtml = (hasChildren && isCollapsed)
    ? `<span class="card-stamp-badge collapsed-pill" data-action="toggle-collapse" title="已折叠 ${childCount} 个子分支，点击展开">已折叠 ${childCount}</span>`
    : '';

  const collapseBtnHtml = hasChildren
    ? `<button class="card-collapse-btn" data-action="toggle-collapse" title="${isCollapsed ? '展开子分支' : '收起子分支'}">${isCollapsed ? '+' : '−'}</button>`
    : '';

  const sourceRefHtml = card.sourceRef ? `
    <div class="source-ref-badge" title="导入时的会话标题快照：${escapeHtml(card.sourceRef.titleAtImport || '')}">
      本体导入快照 · ${escapeHtml(card.sourceRef.titleAtImport || card.sourceRef.sessionId)}
      <button type="button" data-action="jump-source">跳回本体</button>
    </div>
  ` : '';

  // data-message-index 只在当前渲染周期有效：划词候选靠它把 DOM 对回 card.messages 里的活对象，
  // 不当稳定消息 ID 存盘（消息没有可靠的统一 ID，伪造一个反而会骗到自己）。
  const messagesHtml = (card.messages || []).map((m, messageIndex) => `
    <div class="msg-row ${m.role === 'user' ? 'msg-user' : 'msg-asst'}" data-message-index="${messageIndex}">
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

  const isContextExcluded = card.contextMode === 'exclude';
  const refCount = Array.isArray(card.contextRefs) ? card.contextRefs.length : 0;
  const placeholder = isDoc ? '输入关于此文档的问题...' : '输入对话或追问...';
  const inputDisabled = !isReady ? 'disabled' : '';

  return `
    <div class="card-header" data-drag-handle="true">
      <div class="card-title-box">
        <div class="card-dot" style="${dotStyle}"></div>
        <span class="card-title" title="${escapeHtml(card.title || '')}">${escapeHtml(card.title)}</span>
        ${originTag}
        ${stampBadge}
        ${collapsedPillHtml}
      </div>
      <div class="card-header-actions">
        ${collapseBtnHtml}
        <button class="card-export-btn" title="导出结构大纲：只含节点与父边，不含正文" data-action="export-topology">◇</button>
        <button class="card-export-btn" title="顺藤摸瓜：导出整条问答链路为 Markdown" data-action="export-chain">⎘</button>
        <button class="card-stamp-btn" title="${stampBtnTitle}" data-action="cycle-stamp">${stampBtnIcon}</button>
        <button class="card-close-btn" title="关闭卡片" data-action="close">×</button>
      </div>
    </div>
    ${sourceRefHtml}
    ${truncatedHtml}

    <div class="card-body" id="body-${card.id}">
      ${messagesHtml}
    </div>

    <div class="card-footer">
      <div class="card-context-row">
        <button class="ctx-toggle${isContextExcluded ? ' is-excluded' : ''}" data-action="toggle-context-mode"
          title="${isContextExcluded ? '这张卡的内容不会进入后续分支的上下文，再次单击确认恢复' : '这张卡的内容会进入后续分支的上下文，再次单击确认停止提供'}">
          ${isContextExcluded ? '不向后续分支提供上下文' : '向后续分支提供上下文'}
        </button>
        <button class="ctx-preview" data-action="preview-context" title="预览这次请求会带上的内容">预览</button>
        ${refCount > 0 ? `<button class="ctx-preview" data-action="manage-refs" title="管理这张卡引用的原文快照">引用 ${refCount}</button>` : ''}
        <button class="ctx-preview btn-handoff" data-action="handoff" title="以当前分支为基础，在 Hana 中继续">在 Hana 中继续</button>
      </div>
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

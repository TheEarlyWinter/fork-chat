/**
 * panel-search.js
 * 全画布卡片全文检索、搜索结果导航与高亮控制器
 */

/**
 * 在卡片列表中模糊匹配关键词（纯函数，大小写不敏感，支持标题、草稿、对话正文、附件）
 * @param {object} options
 * @param {Array<object>} [options.cards=[]]
 * @param {string} [options.query='']
 * @returns {Array<object>} 命中匹配的卡片数组
 */
export function findCardsByKeyword({ cards = [], query = '' } = {}) {
  if (!Array.isArray(cards) || !query || typeof query !== 'string') return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const matched = [];

  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;

    let isMatch = false;

    // 1. 匹配卡片标题
    if (typeof card.title === 'string' && card.title.toLowerCase().includes(q)) {
      isMatch = true;
    }

    // 2. 匹配卡片当前草稿输入
    if (!isMatch && typeof card.draft === 'string' && card.draft.toLowerCase().includes(q)) {
      isMatch = true;
    }

    // 3. 匹配卡片内所有历史消息正文
    if (!isMatch && Array.isArray(card.messages)) {
      for (const msg of card.messages) {
        if (!msg) continue;
        if (typeof msg.text === 'string' && msg.text.toLowerCase().includes(q)) {
          isMatch = true;
          break;
        }
      }
    }

    // 4. 匹配资料源文件名与暂存附件名
    if (!isMatch && card.docMeta && typeof card.docMeta.name === 'string' && card.docMeta.name.toLowerCase().includes(q)) {
      isMatch = true;
    }
    if (!isMatch && Array.isArray(card.stagedAttachments)) {
      for (const att of card.stagedAttachments) {
        if (att && typeof att.name === 'string' && att.name.toLowerCase().includes(q)) {
          isMatch = true;
          break;
        }
      }
    }

    if (isMatch) {
      matched.push(card);
    }
  }

  return matched;
}

/**
 * 环形计算上一个/下一个搜索结果索引
 * @param {object} options
 * @param {number} [options.currentIndex=0]
 * @param {number} [options.totalCount=0]
 * @param {'next'|'prev'} [options.direction='next']
 * @returns {number}
 */
export function getNextMatchIndex({ currentIndex = 0, totalCount = 0, direction = 'next' } = {}) {
  if (typeof totalCount !== 'number' || totalCount <= 0) return -1;
  const curr = typeof currentIndex === 'number' && currentIndex >= 0 ? currentIndex : 0;
  if (direction === 'prev') {
    return (curr - 1 + totalCount) % totalCount;
  }
  return (curr + 1) % totalCount;
}

/**
 * 绑定搜索悬浮工具栏控制器
 * @param {object} options
 * @returns {object}
 */
export function bindSearchBarController({
  searchBarEl,
  inputEl,
  counterEl,
  btnPrev,
  btnNext,
  btnClose,
  onSearch,
  onNavigate,
  onClose,
  listen = (el, type, fn) => el.addEventListener(type, fn),
} = {}) {
  let isVisible = false;

  const open = () => {
    isVisible = true;
    if (searchBarEl) {
      searchBarEl.hidden = false;
      searchBarEl.classList.add('is-open');
    }
    if (inputEl) {
      inputEl.focus?.();
      inputEl.select?.();
    }
    if (inputEl?.value) {
      onSearch?.(inputEl.value);
    }
  };

  const close = () => {
    isVisible = false;
    if (searchBarEl) {
      searchBarEl.hidden = true;
      searchBarEl.classList.remove('is-open');
    }
    onClose?.();
  };

  if (inputEl) {
    listen(inputEl, 'input', () => {
      onSearch?.(inputEl.value);
    });

    listen(inputEl, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onNavigate?.(e.shiftKey ? 'prev' : 'next');
      }
    });
  }

  if (btnPrev) {
    listen(btnPrev, 'click', (e) => {
      e.stopPropagation();
      onNavigate?.('prev');
    });
  }

  if (btnNext) {
    listen(btnNext, 'click', (e) => {
      e.stopPropagation();
      onNavigate?.('next');
    });
  }

  if (btnClose) {
    listen(btnClose, 'click', (e) => {
      e.stopPropagation();
      close();
    });
  }

  return {
    open,
    close,
    isOpen: () => isVisible,
    updateCounter(current, total) {
      if (counterEl) {
        counterEl.textContent = total > 0 ? `${current + 1}/${total}` : '0/0';
      }
    },
  };
}

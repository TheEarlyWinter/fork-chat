/**
 * 把一段文本放进剪贴板。
 *
 * 优先用异步剪贴板 API，失败再退回隐藏文本框——权限受限、页面不在安全上下文、
 * 或者宿主收走了权限时，前者会直接抛错，这时候必须还能复制出去。
 * 两个导出入口共用这一条路径，行为要一致。
 */

/**
 * @param {{ doc?: () => Document|null, getNavigator?: () => Navigator|null }} deps
 *   doc 和 getNavigator 都用函数形式传入，模块本身不碰全局对象。
 * @returns {(text: string) => Promise<void>}
 */
export function createClipboardWriter({ doc, getNavigator } = {}) {
  return async function copyText(text) {
    const nav = typeof getNavigator === 'function' ? getNavigator() : null;
    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(text);
        return;
      } catch {
        // 权限受限或非安全上下文：继续走下面的 textarea 兜底
      }
    }

    const root = typeof doc === 'function' ? doc() : null;
    if (!root) throw new Error('剪贴板不可用');
    const ta = root.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    root.body.appendChild(ta);
    try {
      ta.select();
      // execCommand 的返回值是这条兜底路径唯一的成功凭据。返回 false 表示浏览器拒绝
      // 执行命令，不能解释成“剪贴板为空”，否则调用方会照常显示“已复制”。
      if (root.execCommand('copy') !== true) throw new Error('浏览器未确认复制成功');
    } finally {
      // select 或 copy 失败时同样要释放临时节点，不留残影在 DOM 里。
      root.body.removeChild(ta);
    }
  };
}

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
    ta.select();
    root.execCommand('copy');
    root.body.removeChild(ta);
  };
}

/**
 * 画布用到的纯格式化与几何小工具。
 *
 * 这些函数跟面板状态无关，放在 panel.js 里只会让它更长。
 * 搬出来后可以单独测，也能被别的面板模块复用。
 */

/**
 * 把二进制转成 base64。
 *
 * 分块各转各的，再拼字符串。
 * 原来是把整个文件拼成一个二进制字符串再 btoa，
 * 16 MB 的文件在内存里同时躺着原始字节、字符串和 base64 三份，低配环境会直接翻车。
 * 块长取 3 的倍数，保证每段 base64 都能独立成立、直接首尾相接。
 */
export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunk = 8190;
  let out = '';
  for (let i = 0; i < len; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, len));
    out += btoa(String.fromCharCode.apply(null, slice));
  }
  return out;
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * 第 index 张根卡片的落点（index 从 1 开始）。
 *
 * 以前是每次只挪 40×60 像素，而卡片本身 340×360，
 * 连着建几张就叠成一摞，几乎完整盖住前一张。
 * 改成三列网格，格子比卡片略大，留出拖拽与连线的空间。
 */
export function rootSlotPosition(index) {
  const col = (index - 1) % 3;
  const row = Math.floor((index - 1) / 3);
  return { x: 80 + col * 400, y: 100 + row * 440 };
}

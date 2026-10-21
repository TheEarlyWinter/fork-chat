/**
 * assistant-output.js
 * 纯函数解析 Assistant 输出文本中的 <mood>、<pulse> 与 <reflect> 块。
 * 对齐 Hana 官方原生规则：
 * 1. 仅在文本开头（允许开头的 BOM \uFEFF 及空白）识别精确小写无 attributes 的 <mood> / <pulse> / <reflect>；
 * 2. 连续前缀多块支持；但若首块后已出现非空正文，后续任何标签都必须字面保留在 body 中；
 * 3. body 保留原始未移除部分的空白，不做 trim（例如 <mood>x</mood>\nPublic answer -> body 为 '\nPublic answer'）；
 * 4. 大小写变体、标签内空白变体以及带 attributes 均作为字面正文处理（不分流）；
 * 5. streaming 期间仅对开头/块间的开标签前缀及块内未完成的闭标签前缀进行暂存，普通正文末尾不暂存；
 * 6. 未闭合块在 EOF 时保留独立块（closed: false）并不丢弃文本；
 * 7. 无 DOM 依赖，不使用 innerHTML，不执行 HTML。
 */

const SUPPORTED_TAGS = Object.freeze(["mood", "pulse", "reflect"]);

function isBomOrWhitespace(ch) {
  return ch === "\uFEFF" || /\s/u.test(ch);
}

function matchOpenTag(text, startIndex = 0) {
  for (const tag of SUPPORTED_TAGS) {
    const openTag = `<${tag}>`;
    if (text.startsWith(openTag, startIndex)) {
      return { tag, openTag };
    }
  }
  return null;
}

function isPendingOpenTag(text) {
  if (!text) return false;
  return SUPPORTED_TAGS.some((tag) => `<${tag}>`.startsWith(text));
}

function getPendingCloseLength(text, closeTag) {
  const maxCheck = Math.min(text.length, closeTag.length - 1);
  for (let n = maxCheck; n >= 1; n--) {
    if (text.endsWith(closeTag.slice(0, n))) {
      return n;
    }
  }
  return 0;
}

/**
 * 解析 Assistant 输出文本
 * @param {string} raw - 原始文本
 * @param {object} [options]
 * @param {boolean} [options.streaming=false] - 是否处于流式传输中
 * @returns {{ body: string, blocks: Array<{ type: 'mood'|'pulse'|'reflect', text: string, closed: boolean }> }}
 */
export function parseAssistantOutput(raw, options = {}) {
  const { streaming = false } = options;

  if (typeof raw !== "string" || !raw) {
    return { body: "", blocks: [] };
  }

  let i = 0;
  const len = raw.length;
  const blocks = [];

  // 前缀头部扫描：仅提取文本开头的连续合规块
  while (i < len) {
    let p = i;
    while (p < len && isBomOrWhitespace(raw[p])) {
      p++;
    }
    const rest = raw.slice(p);

    if (!rest) {
      if (streaming) {
        return { body: "", blocks };
      } else {
        const body = blocks.length > 0 ? raw.slice(i) : raw;
        return { body, blocks };
      }
    }

    // 检查是否命中精确小写无属性开标签
    const match = matchOpenTag(raw, p);
    if (match) {
      const { tag, openTag } = match;
      const closeTag = `</${tag}>`;
      const contentStart = p + openTag.length;

      // 寻找闭合标签，支持同名标签深度计数以防嵌套内容丢失
      let depth = 1;
      let scanIdx = contentStart;
      let closeIdx = -1;

      while (scanIdx < len) {
        if (raw.startsWith(closeTag, scanIdx)) {
          depth--;
          if (depth === 0) {
            closeIdx = scanIdx;
            break;
          }
          scanIdx += closeTag.length;
          continue;
        }
        if (raw.startsWith(openTag, scanIdx)) {
          depth++;
          scanIdx += openTag.length;
          continue;
        }
        scanIdx++;
      }

      if (closeIdx !== -1) {
        const text = raw.slice(contentStart, closeIdx);
        blocks.push({
          type: tag,
          text,
          closed: true,
        });
        i = closeIdx + closeTag.length;
        continue;
      } else {
        // 未闭合块到达当前尾部
        const unclosedContent = raw.slice(contentStart);
        if (streaming) {
          const pendingLen = getPendingCloseLength(unclosedContent, closeTag);
          const text = pendingLen > 0 ? unclosedContent.slice(0, -pendingLen) : unclosedContent;
          blocks.push({
            type: tag,
            text,
            closed: false,
          });
          return { body: "", blocks };
        } else {
          blocks.push({
            type: tag,
            text: unclosedContent,
            closed: false,
          });
          return { body: "", blocks };
        }
      }
    }

    // 流式状态下检查是否属于合规开标签的前缀碎片（仅限开头或连续块间）
    if (streaming && isPendingOpenTag(rest)) {
      return { body: "", blocks };
    }

    // 遇到非标签且非待定前缀字符，前缀头部阶段彻底结束，剩余内容全部归入正文
    break;
  }

  // 保留原始未移除部分的空白，不做 trim
  const body = blocks.length > 0 ? raw.slice(i) : raw;
  return { body, blocks };
}

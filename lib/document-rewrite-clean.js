import { documentError } from './document-spec.js';

/*
 * 修订正文的思考块剥离（server 侧，rewrite 专用）。
 *
 * rewrite child 的宿主模型可能在正文前输出 <mood>/<pulse>/<reflect> 思考块
 * （UI 层由 ui/assets/assistant-output.js 剥离，child 流没有这层）。
 * 这里按同一语法做前缀剥离：仅精确小写无属性开标签、允许前导 BOM/空白、
 * 支持同名嵌套计数。空白谓词必须与 UI 的 isBomOrWhitespace（/\s/u）一致，
 * 否则全角空格/NBSP 开头的思考块会绕过剥离（实机验收后的定向复核已复现）。
 * 未闭合的前缀块视为模型尚未回到正文：内容为空，
 * 让调用方按「修订正文为空」报错，绝不把思考文本当正文发布。
 */

const PREFIX_TAGS = Object.freeze(['mood', 'pulse', 'reflect']);
const MAX_NESTING = 64;
const WHITESPACE = /\s/u;

function isPrefixSpace(ch) {
  return ch === '\uFEFF' || WHITESPACE.test(ch);
}

function matchOpenTag(text, start) {
  if (text[start] !== '<') return null;
  for (const tag of PREFIX_TAGS) {
    const openTag = `<${tag}>`;
    if (text.startsWith(openTag, start)) return { tag, openTag, closeTag: `</${tag}>` };
  }
  return null;
}

/** @returns {string|null} 剥离后的正文；null 表示存在未闭合的前缀块 */
export function stripAssistantPrefixBlocks(raw) {
  if (typeof raw !== 'string' || !raw) return raw ?? '';
  let i = 0;
  const len = raw.length;
  while (i < len) {
    let p = i;
    while (p < len && isPrefixSpace(raw[p])) p++;
    const match = matchOpenTag(raw, p);
    if (!match) break;
    const contentStart = p + match.openTag.length;
    let depth = 1;
    let scanIdx = contentStart;
    let closeIdx = -1;
    while (scanIdx < len && depth <= MAX_NESTING) {
      if (raw.startsWith(match.closeTag, scanIdx)) {
        depth--;
        if (depth === 0) { closeIdx = scanIdx; break; }
        scanIdx += match.closeTag.length;
        continue;
      }
      if (raw.startsWith(match.openTag, scanIdx)) {
        depth++;
        scanIdx += match.openTag.length;
        continue;
      }
      scanIdx++;
    }
    if (closeIdx === -1) return null;
    i = closeIdx + match.closeTag.length;
  }
  return raw.slice(i);
}

/** 与 stripAssistantPrefixBlocks 同规则，但未闭合时直接拒绝（修订发布路径用） */
export function documentBodyFromModelText(raw) {
  const body = stripAssistantPrefixBlocks(raw);
  if (body === null) throw documentError('INVALID_CONTENT', '修订正文被未闭合的思考块污染，未发布新文件');
  return body;
}

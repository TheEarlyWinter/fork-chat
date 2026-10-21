import zlib from "node:zlib";
import path from "node:path";
import { extractText, getDocumentProxy, getResolvedPDFJS } from "./vendor/unpdf/dist/index.mjs";

/**
 * 提取质量阈值。数值来自真实样本分布，不是拍脑袋：
 *   正常英文论文   latinExt 0.11%~0.13% | control 0~0.25% | 乱码连串 0~0.07/百字
 *   中文乱码 PDF   latinExt 13%~25%     | control 1.3%~7.7% | 乱码连串 5.6~7.4/百字
 *   扫描图片型     latinExt 94.9%       | control 3.07%     | 乱码连串 6.49/百字
 * 正常与异常之间隔着一到两个数量级，阈值取在中间偏安全的一侧。
 * 调整阈值前请先跑 tests/quality.test.mjs，别凭感觉改。
 */
export const QUALITY_THRESHOLDS = Object.freeze({
  minChars: 200,
  latinExtRatio: 0.02,
  controlRatio: 0.01,
  garbledRunPer100: 1,
});

/** PDF 体积上限，超过直接拒绝，避免把内存撑爆 */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** 低于该字符数视为可疑，需要进一步判断是扫描件还是字体映射缺失 */
const MIN_PDF_CHARS = 200;

/** 拉丁扩展区字符，mojibake 与字体编码错配的高发区 */
const LATIN_EXT_RE = /[\u00a0-\u00ff]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** 乱码里高频出现的装饰性符号，正常英文技术文本几乎不出现 */
const GARBLED_RUN_RE = /[\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u00aa\u00ab\u00ac\u00ae\u00af\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u00ba\u00bb\u00bc\u00bd\u00be\u00bf\u00c3\u00c2\u00c5\u00c4\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00d0\u00d1\u00d2\u00de\u00df]/g;

/**
 * 符号修表。PDF 字体把连字与破折号映射到拉丁扩展码位，抽出来就成了怪字符。
 * 每条规则都限定在语法上下文内，避免把真正的外文字母改错。
 * 注意：ff / ffi 一类连字一旦被解成单个 f，原始信息已丢失，无法逆向还原，
 * 这里不做词典级猜测，只在 quality 里如实告知。
 */
const SYMBOL_FIXES = [
  {
    id: "fi-ligature",
    re: /(\p{L})\u00de(\p{L})/gu,
    to: "$1fi$2",
    note: "Þ→fi",
    minHits: 3,
  },
  {
    id: "fl-ligature",
    re: /(\p{L})\u00df(\p{L})/gu,
    to: "$1fl$2",
    note: "ß→fl",
    minHits: 3,
  },
  {
    id: "degree-celsius",
    re: /(?<=[\d\s])\u00a1(?=\s?C\b)/g,
    to: "°",
    note: "¡C→°C",
  },
  {
    id: "dash-between-numbers",
    re: /(?<=\d)\s?[\u00d0\u00d1\u2013\u2014]\s?(?=\d)/g,
    to: "-",
    note: "数字区间破折号",
  },
];

/**
 * 对已抽出的文本做保守的符号修复
 * @param {string} text
 * @returns {{ text: string, fixes: string[] }}
 */
export function applySymbolFixes(text) {
  if (!text) return { text: "", fixes: [] };
  let out = text;
  const fixes = [];
  for (const rule of SYMBOL_FIXES) {
    // 连字修正是有损启发式（德语 Straße 里的 ß 也可能被误伤）。
    // 只在同一篇文档里成体系出现时才启用，零星出现一律不动。
    if (rule.minHits && (out.match(rule.re) || []).length < rule.minHits) continue;
    const before = out;
    out = out.replace(rule.re, rule.to);
    if (out !== before) fixes.push(rule.note);
  }
  return { text: out, fixes };
}

/**
 * 给提取结果打分，决定这份文本能不能直接喂给模型
 * @param {string} text
 * @returns {{ readable: boolean, score: number, reasons: string[], metrics: object }}
 */
export function scoreExtractedText(text) {
  const total = text ? text.length : 0;
  const metrics = {
    charCount: total,
    cjkCount: 0,
    latinExtRatio: 0,
    controlRatio: 0,
    garbledRunPer100: 0,
  };

  if (total < QUALITY_THRESHOLDS.minChars) {
    return { readable: false, score: 0, reasons: ["too-short"], metrics };
  }

  const cjkCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latinExt = (text.match(LATIN_EXT_RE) || []).length;
  const control = (text.match(CONTROL_RE) || []).length;
  const garbledRun = (text.match(GARBLED_RUN_RE) || []).length;

  metrics.cjkCount = cjkCount;
  metrics.latinExtRatio = latinExt / total;
  metrics.controlRatio = control / total;
  metrics.garbledRunPer100 = (garbledRun / total) * 100;

  const reasons = [];
  if (metrics.controlRatio > QUALITY_THRESHOLDS.controlRatio) reasons.push("control-noise");
  if (metrics.latinExtRatio > QUALITY_THRESHOLDS.latinExtRatio) reasons.push("mojibake");
  if (metrics.garbledRunPer100 > QUALITY_THRESHOLDS.garbledRunPer100) reasons.push("garbled-run");

  const score = Math.max(
    0,
    1 - metrics.latinExtRatio * 2 - metrics.controlRatio * 2 - metrics.garbledRunPer100 / 50,
  );

  return { readable: reasons.length === 0, score: Number(score.toFixed(4)), reasons, metrics };
}

/** 收敛空白，去掉 NUL 与多余空行 */
function cleanPdfText(raw) {
  return String(raw || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 提取不到文字时，翻前几页的绘制指令，看有没有“画字”的动作。
 * 有画字却读不出字 = 字体映射有问题；连画字都没有 = 真扫描件。
 * 这两种情况该给用户的说法完全不同，不能混成一句“读不出来”。
 */
async function detectTextOps(pdf) {
  try {
    const PDFJS = await getResolvedPDFJS();
    const OPS = PDFJS?.OPS || {};
    const showOps = new Set(
      [OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].filter(
        (n) => typeof n === "number",
      ),
    );
    if (!showOps.size) return null;
    const max = Math.min(pdf.numPages || 1, 5);
    for (let i = 1; i <= max; i += 1) {
      const page = await pdf.getPage(i);
      const ops = await page.getOperatorList();
      if ((ops.fnArray || []).some((fn) => showOps.has(fn))) return true;
      try {
        page.cleanup?.();
      } catch {}
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * PDF 文本抽取：基于 pdf.js（unpdf 打包版）。
 * 纯 JS 运行，不写临时文件、不起子进程、不需要额外权限；
 * CMap / CID / ToUnicode 由 pdf.js 处理，中文不再是乱码。
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfText(buffer) {
  // pdf.js 按构造器严格校验，Buffer 会被拒；必须转成裸 Uint8Array
  const uint8 =
    buffer && buffer.constructor === Uint8Array ? buffer : new Uint8Array(buffer ?? []);

  if (uint8.byteLength === 0) throw new Error("文件内容为空");
  if (uint8.byteLength > MAX_PDF_BYTES) {
    const err = new Error(`PDF 体积过大（${Math.round(uint8.byteLength / 1048576)} MB，上限 50 MB）`);
    err.code = "file_too_big";
    throw err;
  }

  let pdf;
  try {
    pdf = await getDocumentProxy(uint8);
  } catch (e) {
    const err = new Error(`PDF 解析失败（文件损坏或不是 PDF）：${e?.message || e}`);
    err.code = "parse_fail";
    throw err;
  }

  let text = "";
  let totalPages = 0;
  let textOps = null;
  try {
    const result = await extractText(pdf, { mergePages: true });
    text = result.text || "";
    totalPages = result.totalPages || 0;
    // 只有在可能失败时才回去翻算符，正常文档不多花这一遍
    if (applySymbolFixes(cleanPdfText(text)).text.length < MIN_PDF_CHARS) {
      textOps = await detectTextOps(pdf);
    }
  } finally {
    try {
      pdf.destroy?.();
    } catch {}
  }

  const clean = applySymbolFixes(cleanPdfText(text)).text;

  if (clean.length < MIN_PDF_CHARS) {
    const err = new Error(
      textOps === true
        ? `这份 PDF 有文字层，但字体映射读不出来，仅提取到 ${clean.length} 个字符（共 ${totalPages} 页）。它不是扫描件，是编码问题。`
        : `这份 PDF 只提取到 ${clean.length} 个字符（共 ${totalPages} 页），看起来是没有文字层的扫描件或图片版，需要 OCR。`,
    );
    err.code = textOps === true ? "font_mapping" : "no_text_layer";
    err.textLayerPresent = textOps === true;
    err.pageCount = totalPages;
    throw err;
  }

  return clean;
}

/**
 * 从 Word (.docx) 的 Buffer 中提取段落纯文本
 * 基于标准 ZIP 格式与 word/document.xml 解析，零外部依赖
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractDocxText(buffer) {
  let offset = 0;
  while (offset < buffer.length - 30) {
    // 匹配 ZIP Local File Header 标识 0x04034b50
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset++;
      continue;
    }
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.toString("utf8", offset + 30, offset + 30 + fileNameLen);
    const dataStart = offset + 30 + fileNameLen + extraLen;

    if (fileName === "word/document.xml") {
      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
      let xml = "";
      if (compression === 0) {
        xml = compressedData.toString("utf8");
      } else if (compression === 8) {
        xml = zlib.inflateRawSync(compressedData).toString("utf8");
      } else {
        throw new Error(`Unsupported docx compression method: ${compression}`);
      }

      // 解析 XML 段落 (<w:p>) 与文本片元 (<w:t>)
      const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
      const lines = [];
      for (const p of paragraphs) {
        // 匹配段落内的所有文本节点
        const texts = p.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g) || [];
        const line = texts.map((t) => t.replace(/<[^>]+>/g, "")).join("");
        if (line.trim()) {
          lines.push(line.trim());
        }
      }
      return lines.join("\n\n");
    }
    offset = dataStart + compressedSize;
  }
  return "";
}

/**
 * 统一文件提取调度中心
 * @param {object} params
 * @param {string} params.filename 文件名
 * @param {string} [params.text] 纯文本内容
 * @param {string} [params.contentBase64] Base64 编码的二进制流
 * @returns {Promise<object>}
 */
export async function parseDocument({ filename, text, contentBase64 }) {
  if (!filename || typeof filename !== "string") {
    throw new Error("缺少有效文件名");
  }

  const ext = path.extname(filename).toLowerCase();
  let extractedText = "";

  const textExtensions = new Set([
    ".md", ".markdown", ".txt", ".json", ".csv", ".tsv",
    ".js", ".ts", ".jsx", ".tsx", ".py", ".c", ".cpp",
    ".h", ".hpp", ".java", ".go", ".rs", ".html", ".css",
    ".sh", ".bash", ".sql", ".yaml", ".yml", ".xml", ".ini",
  ]);

  if (typeof text === "string" && text.length > 0) {
    extractedText = text;
  } else if (contentBase64) {
    const buffer = Buffer.from(contentBase64, "base64");
    if (ext === ".docx") {
      extractedText = extractDocxText(buffer);
    } else if (ext === ".pdf") {
      // PDF 的各种失败要给用户可读的说明，不能笼统抛“解析异常”
      extractedText = await extractPdfText(buffer);
    } else if (textExtensions.has(ext)) {
      extractedText = buffer.toString("utf8");
    } else {
      // 默认尝试当作 UTF-8 文本解析
      extractedText = buffer.toString("utf8");
    }
  } else {
    throw new Error("文件内容为空");
  }

  const charCount = extractedText.length;
  const lines = extractedText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lineCount = lines.length;
  const preview = extractedText.slice(0, 1500) + (charCount > 1500 ? "\n\n... (文档较长，后续内容已完全载入上下文)" : "");

  // 质量评估：只标记、不阻断，让 UI 与后续流水线自行决定怎么处理
  const assessment = scoreExtractedText(extractedText);

  return {
    ok: true,
    filename,
    extension: ext,
    charCount,
    lineCount,
    text: extractedText,
    preview,
    quality: {
      source: "local",
      readable: assessment.readable,
      score: assessment.score,
      reasons: assessment.reasons,
      metrics: assessment.metrics,
      // 内容过短不算“读不动”，不值得为几十个字大惊小怪
      recommendation:
        assessment.readable || assessment.reasons.includes("too-short") ? "accept" : "check",
    },
  };
}

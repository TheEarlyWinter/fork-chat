import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreExtractedText,
  applySymbolFixes,
  parseDocument,
  QUALITY_THRESHOLDS,
} from "../lib/document-parser.js";

// 真实样本的近似片段：正常英文论文正文
const GOOD_ENGLISH = `
Research Article How to cite: Angew. Chem. Int. Ed. Photochemistry
Functional materials with photo-regulated solid-liquid transition have garnered
significant attention and found extensive applications across cutting-edge domains.
The light-to-heat conversion efficiency of Azo-PTA was as high as 84.9%, and the
temperature could increase to above 90 degrees within 30 s of green light irradiation.
`.repeat(3);

// 真实样本的近似片段：中文 PDF 被按拉丁编码硬解后的产物
const MOJIBAKE_SAMPLE = `
2025 30 30 1. 4u&16;7± 2. eeRJcó &ú& có 3. OU# 47R¸ 47R¸
4. 1éH¿^o 5. "åÿKz5.!(D' H¼.Ä 6. 6b3®6; Iu3®6;
7. 8. $¸eÿ6; .&eÿ6; $¸ 9. 8þ^o^m_ 20 10. o" 11. 1éH¿_
`.repeat(6);

// 真实样本的近似片段：扫描件栅格噪声伪装成的可打印字符
const SCAN_NOISE = `0+2086=6<CCJJCJQOV¥SZ©W_®Y\`¯Y\`¯Y\`¯W^­T[ªPW¦MT¢JQFMJRJR[Zd¡_j¢cn£fs£iv¥my¨p|«t°z¶µºÀÆÍ¤Ó«Ú¦²á«·æ°½ëµÂð´Áð¯¼ë«·æªÙÇy´mz©gs¢am\`lcofr¡fs¡eq`.repeat(8);

test("quality: 正常英文正文判定为可读", () => {
  const result = scoreExtractedText(GOOD_ENGLISH);
  assert.equal(result.readable, true, `不应判为不可读，reasons=${result.reasons}`);
  assert.ok(result.score > 0.9);
  assert.deepEqual(result.reasons, []);
});

test("quality: 中文乱码判定为不可读", () => {
  const result = scoreExtractedText(MOJIBAKE_SAMPLE);
  assert.equal(result.readable, false);
  assert.ok(result.reasons.includes("garbled-run") || result.reasons.includes("mojibake"));
});

test("quality: 扫描件噪声判定为不可读", () => {
  const result = scoreExtractedText(SCAN_NOISE);
  assert.equal(result.readable, false);
  assert.ok(result.reasons.includes("mojibake"));
});

test("quality: 过短文本直接拒绝", () => {
  const result = scoreExtractedText("短");
  assert.equal(result.readable, false);
  assert.deepEqual(result.reasons, ["too-short"]);
  assert.equal(result.metrics.charCount, 1);
});

test("quality: 空输入不抛异常", () => {
  const result = scoreExtractedText("");
  assert.equal(result.readable, false);
  assert.deepEqual(result.reasons, ["too-short"]);
});

test("quality: 阈值是一份可读的常量表", () => {
  assert.equal(typeof QUALITY_THRESHOLDS.latinExtRatio, "number");
  assert.equal(typeof QUALITY_THRESHOLDS.controlRatio, "number");
  assert.ok(Object.isFrozen(QUALITY_THRESHOLDS));
});

test("symbol: 连字需成体系出现才修正", () => {
  const text = "scienti\u00dec work and scienti\u00dec method and scienti\u00dec value";
  const { text: fixed, fixes } = applySymbolFixes(text);
  assert.match(fixed, /scientific/);
  assert.ok(fixes.includes("Þ→fi"));
});

test("symbol: 零星德语 ß 不被误伤", () => {
  const text = "Institut für Chemie, Strasse 12, Größe der Probe";
  const { text: fixed, fixes } = applySymbolFixes(text);
  assert.equal(fixed, text);
  assert.deepEqual(fixes, []);
});

test("symbol: 摄氏度恢复", () => {
  const { text } = applySymbolFixes("heated to above 90 \u00a1C within 30 s");
  assert.match(text, /90 °C/);
});

test("symbol: 数字区间的破折号归一化", () => {
  const { text } = applySymbolFixes("Energy Convers. Manage 157 , 372\u00d0381 (2018)");
  assert.match(text, /372-381/);
});

test("symbol: 两个数字之间没有破折号时不做替换", () => {
  const original = "sample 1 000 units";
  const { text } = applySymbolFixes(original);
  assert.equal(text, original);
});

test("parseDocument: 返回 quality 元数据", async () => {
  const result = await parseDocument({
    filename: "note.md",
    text: GOOD_ENGLISH,
  });
  assert.equal(result.ok, true);
  assert.equal(result.quality.source, "local");
  assert.equal(result.quality.readable, true);
  assert.equal(result.quality.recommendation, "accept");
  assert.equal(typeof result.quality.score, "number");
});

test("parseDocument: 读不动的内容标记为需要人工确认", async () => {
  const result = await parseDocument({
    filename: "broken.md",
    text: MOJIBAKE_SAMPLE,
  });
  assert.equal(result.quality.readable, false);
  assert.equal(result.quality.recommendation, "check");
  assert.ok(result.quality.reasons.length > 0);
});

test("parseDocument: 短文本不升级，不为几十个字开后台会话", async () => {
  const result = await parseDocument({
    filename: "note.md",
    text: "这是一段很短的中文笔记，说明某个实验参数。",
  });
  assert.equal(result.quality.readable, false);
  assert.deepEqual(result.quality.reasons, ["too-short"]);
  assert.equal(result.quality.recommendation, "accept");
});

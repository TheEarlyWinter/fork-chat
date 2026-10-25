import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  cleanMineruMarkdown,
  readZipEntries,
  resolveMineruOptions,
  mineruReady,
} from "../lib/mineru-parse.js";

/** 造一个最小合法 ZIP：不压缩存放一个文件，便于验证解析而不是验证压缩算法 */
function buildZip(name, content, { method = 0 } = {}) {
  const fileName = Buffer.from(name, "utf8");
  const raw = Buffer.from(content, "utf8");
  const payload = method === 8 ? deflateRawSync(raw) : raw;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);

  const localBlock = Buffer.concat([local, fileName, payload]);
  const centralBlock = Buffer.concat([central, fileName]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

test("mineru: Markdown 清理把图片引用换成占位，保留正文结构", () => {
  const raw = [
    "# 标题",
    "",
    "![](images/a.jpg)",
    "",
    "正文第一段。",
    "",
    "",
    "",
    "正文第二段 ![](images/b.png) 结尾。",
  ].join("\n");
  const cleaned = cleanMineruMarkdown(raw);
  assert.match(cleaned, /\[图片\]/);
  assert.doesNotMatch(cleaned, /images\//);
  assert.doesNotMatch(cleaned, /\n{3,}/);
  assert.match(cleaned, /正文第一段。/);
});

test("mineru: 纯内存 ZIP 读取（store 与 deflate 两种方式）", () => {
  for (const method of [0, 8]) {
    const zip = buildZip("full.md", "# 你好\n正文内容。", { method });
    const entries = readZipEntries(zip);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "full.md");
    assert.equal(entries[0].data.toString("utf8"), "# 你好\n正文内容。");
  }
});

test("mineru: 损坏的 ZIP 给出明确错误而不是崩溃", () => {
  assert.throws(() => readZipEntries(Buffer.from("not a zip")), /ZIP|中央目录/);
  assert.throws(() => readZipEntries(Buffer.alloc(0)), /为空/);
});

test("mineru: 配置默认值与非法值回退", () => {
  const get = (map) => (key) => map[key];
  const defaults = resolveMineruOptions(get({}));
  assert.equal(defaults.modelVersion, "vlm");
  assert.equal(defaults.language, "ch");
  assert.equal(defaults.enabled, false, "默认必须关闭，不能偷偷上传");
  assert.equal(defaults.timeoutSeconds, 600);
  assert.equal(defaults.apiBase, "https://mineru.net/api/v4");

  const bogus = resolveMineruOptions(get({ mineruModelVersion: "gpt", mineruLanguage: "klingon" }));
  assert.equal(bogus.modelVersion, "vlm");
  assert.equal(bogus.language, "ch");
});

test("mineru: 只接受官方 HTTPS 域名，防 SSRF", () => {
  const get = (value) => (key) => (key === "mineruApiBaseUrl" ? value : undefined);
  assert.throws(() => resolveMineruOptions(get("http://mineru.net/api/v4")), /HTTPS/);
  assert.throws(() => resolveMineruOptions(get("https://evil.example.com/api")), /HTTPS|域名/);
  assert.throws(() => resolveMineruOptions(get("https://user:pass@mineru.net/api")), /域名|HTTPS/);
  const ok = resolveMineruOptions(get("https://mineru.net/api/v4/"));
  assert.equal(ok.apiBase, "https://mineru.net/api/v4");
});

test("mineru: 未填 token 或未开启时不算就绪", () => {
  const make = (map) => (key) => map[key];
  assert.equal(mineruReady(make({})).ready, false);
  assert.equal(mineruReady(make({ mineruEnabled: true })).ready, false);
  assert.equal(mineruReady(make({ mineruApiToken: "sk-abc" })).ready, false, "没开开关不算就绪");
  assert.equal(mineruReady(make({ mineruEnabled: true, mineruApiToken: "sk-abc" })).ready, true);
});

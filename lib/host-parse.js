import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 宿主 Agent 文档解析（L2）
 *
 * 本地算法读不动的文档，交给 Hana 宿主里的助手在一条私有会话中解析一遍。
 * 走的是官方总线通道，不碰子进程、不往沙盒外写文件。
 *
 * 设计要点：
 * - 结果按内容哈希缓存，同一份文件第二次拖入零成本零延迟
 * - 提示词固定，输出必须是指定格式的 Markdown，读不出文字层时回 NO_TEXT_LAYER
 * - 任何一步失败都要回滚会话，不留半截私有会话
 */

const DEFAULTS = Object.freeze({
  timeoutMs: 45000,
  maxChars: 40000,
  pollIntervalMs: 1200,
});

export const NO_TEXT_LAYER = "NO_TEXT_LAYER";

export function buildParsePrompt({ filename, maxChars, filePath }) {
  const target = filePath ? `\n文件绝对路径：${filePath}\n请先调用你的文档读取工具（office_read-document 或等价能力）读取该文件，再按下面的要求输出。\n` : "";
  return [
    "你是一个文档解析器，不是问答助手。",
    `请把附件《${filename}》的内容提取成结构化 Markdown。`,
    target,
    "",
    "硬性要求：",
    "1. 只输出 Markdown 正文，不要任何开场白、总结、评论或“以下是”之类的引导语。",
    "2. 保留原文的标题层级，用 # / ## / ### 表示章节。",
    "3. 表格必须还原成 Markdown 表格，保留表头与单位；跨行跨列结构拆成多行并重复关键列名。",
    "4. 公式输出为 $$ ... $$，行内公式用 $...$。",
    "5. 图注单独成行，以 <!-- 图注 --> 开头，不要并入正文段落。",
    `6. 全文不超过 ${maxChars} 字符；超出部分在末尾单独一行标注 [已截断]。`,
    `7. 如果这份文档没有可提取的文字层（纯扫描件或图片），只输出一行：${NO_TEXT_LAYER}`,
    "8. 不要臆测看不清的内容，识别不出的字符原样保留或省略，宁可缺不要编。",
  ].join("\n");
}

/** 从会话历史里挑出最后一条非空的助手消息 */
export function pickAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

/**
 * @param {object} options
 * @param {Function} options.busRequest  (verb, input) => Promise<output>
 * @param {Function} options.stage       (input) => Promise<{ resource: { fileId: string } }>
 * @param {string}   options.dataDir
 * @param {object}   [options.logger]
 * @param {object}   [options.defaults]
 */
export function createHostParseService({ busRequest, stage, dataDir, logger, defaults = {} }) {
  const config = { ...DEFAULTS, ...defaults };
  const cacheDir = path.join(dataDir, "doc-cache");
  const uploadDir = path.join(dataDir, "uploads");

  function cacheFile(hash) {
    return path.join(cacheDir, `${hash}.json`);
  }

  async function readCache(hash) {
    try {
      const raw = await fs.readFile(cacheFile(hash), "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.text === "string" && parsed.text.length > 0) return parsed;
    } catch {}
    return null;
  }

  async function writeCache(hash, payload) {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile(hash), JSON.stringify(payload), "utf-8");
    } catch (err) {
      await logger?.warn?.(`文档解析缓存写入失败: ${err?.message || err}`);
    }
  }

  /** 等到助手把话说完：连续两次取到同一段文本，且不是空 */
  async function collectResult(sessionId, { timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stable = 0;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      let messages = [];
      try {
        const history = await busRequest("session:history", { sessionId, limit: 20 });
        messages = history?.messages ?? [];
      } catch (err) {
        await logger?.warn?.(`读取解析会话历史失败: ${err?.message || err}`);
        continue;
      }
      const text = pickAssistantText(messages).trim();
      if (!text) continue;
      if (text === previous) {
        stable += 1;
        // 连续两轮不变，认为这一轮已经结束
        if (stable >= 2) return text;
      } else {
        previous = text;
        stable = 0;
        await logger?.info?.(`解析轮询: 助手文本已增至 ${text.length} 字`);
      }
    }

    if (previous) return previous;
    throw new Error("宿主解析超时");
  }

  /**
   * @param {object} input
   * @param {string} input.filename
   * @param {Buffer} input.buffer
   * @param {string} [input.mime]
   * @param {string} [input.agentId]   指定助手
   * @param {object} [input.model]     指定模型 { provider, modelId } 或 { id }
   * @param {number} [input.timeoutMs]
   * @param {number} [input.maxChars]
   */
  async function parse({ filename, buffer, mime, agentId, model, timeoutMs, maxChars }) {
    if (!filename || !buffer || !buffer.length) throw new Error("缺少文件内容");

    const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);

    const cached = await readCache(hash);
    if (cached) {
      return { ...cached, cached: true };
    }

    const ext = path.extname(filename) || ".bin";
    const uploadPath = path.join(uploadDir, `${hash}${ext}`);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(uploadPath, buffer);

    let sessionId = null;
    const startedAt = Date.now();

    try {
      // 先建会话：后续发消息必须落在一个已存在的会话里
      const created = await busRequest("session:create", {
        ...(agentId ? { agentId } : {}),
        ...(model ? { model } : {}),
      });
      sessionId = created?.sessionId || created?.sessionRef?.sessionId;
      if (!sessionId) throw new Error("创建解析会话失败");

      await busRequest("session:send", {
        sessionId,
        text: buildParsePrompt({
          filename,
          maxChars: maxChars ?? config.maxChars,
          filePath: uploadPath,
        }),
      });

      const text = await collectResult(sessionId, { timeoutMs: timeoutMs ?? config.timeoutMs });

      if (text.trim() === NO_TEXT_LAYER) {
        const result = {
          ok: false,
          reason: "no-text-layer",
          filename,
          message: "这份文档没有可提取的文字层，需要 OCR",
        };
        return result;
      }

      const result = {
        ok: true,
        filename,
        text,
        charCount: text.length,
        source: "host-agent",
        agentId: created.agentId ?? agentId ?? null,
        agentName: created.agentName ?? null,
        modelId: created.modelId ?? null,
        modelProvider: created.modelProvider ?? null,
        elapsedMs: Date.now() - startedAt,
        cached: false,
      };

      await logger?.info?.(
        `宿主解析完成: ${filename} · ${result.charCount} 字 · ${result.modelProvider || "?"}/${result.modelId || "?"} · ${result.elapsedMs}ms`,
      );

      await writeCache(hash, {
        ok: true,
        filename,
        text: result.text,
        charCount: result.charCount,
        source: result.source,
        modelId: result.modelId,
        modelProvider: result.modelProvider,
        createdAt: Date.now(),
      });

      return result;
    } finally {
      if (sessionId) {
        // 宿主拒绝直接删除未归档的会话，先归档再清理
        try {
          await busRequest("session:archive", { sessionId });
        } catch (err) {
          await logger?.warn?.(`解析会话归档失败: ${err?.message || err}`);
        }
        try {
          await busRequest("session:delete", { sessionId });
        } catch (err) {
          await logger?.warn?.(`解析会话清理失败: ${err?.message || err}`);
        }
      }
      try {
        await fs.unlink(uploadPath);
      } catch {}
    }
  }

  return { parse, cacheFile, buildParsePrompt };
}

import { parseDocument, scoreExtractedText } from "./document-parser.js";
import { parsePdfWithMineru, mineruReady, storeMineruCache, MineruError } from "./mineru-parse.js";

/**
 * 统一解析入口：本地优先，读不动才考虑上云。
 *
 * 为什么不是让模型自己挑引擎：模型看不到 PDF 内部，不知道这份有没有文字层，
 * 只能靠文件名和用户描述猜。猜错的两个方向都难看——保守到永远不用云端，
 * 或者每份都往云上扔、白烧额度。
 *
 * 所以判断放这里，覆盖权留给模型：
 *   mode = "auto"  本地先跑，不合格且配了 key 才升级（默认）
 *   mode = "local" 只用本地，断网也能跑，不花钱
 *   mode = "cloud" 直接上云，跳过本地
 */

export const PARSE_MODES = Object.freeze(["auto", "local", "cloud"]);

/** 本地结果里哪些情况值得花钱上云 */
function needsCloud({ local, localError }) {
  if (localError) {
    const code = localError.code;
    // 扫描件与字体映射缺失是 pdf.js 的明确死角，正是云端存在的理由
    if (code === "no_text_layer" || code === "font_mapping") return { needs: true, reason: code };
    if (code === "file_too_big" || code === "parse_fail") return { needs: true, reason: code };
    return { needs: false, reason: "local-error-not-recoverable" };
  }
  if (!local?.quality?.readable) {
    return { needs: true, reason: (local?.quality?.reasons || []).join(",") || "low-quality" };
  }
  // 本地读出来只有零星几十个字，通常是图片型文档里夹了几行水印
  if (local.charCount < 120) return { needs: true, reason: "suspiciously-short" };
  return { needs: false, reason: "" };
}

function shapeLocalResult(local) {
  return {
    ok: true,
    engine: "local",
    engineLabel: "pdf.js（本地）",
    filename: local.filename,
    extension: local.extension,
    charCount: local.charCount,
    lineCount: local.lineCount,
    pageCount: local.pageCount || null,
    text: local.text,
    preview: local.preview,
    quality: local.quality,
    degraded: false,
  };
}

function shapeCloudResult(cloud, originalFilename) {
  const assessment = scoreExtractedText(cloud.text);
  return {
    ok: true,
    engine: "mineru",
    engineLabel: `MinerU（云端 · ${cloud.modelVersion}${cloud.ocrFallback ? " · OCR" : ""}）`,
    filename: cloud.fileName || originalFilename,
    extension: ".pdf",
    charCount: cloud.charCount,
    lineCount: cloud.text.split(/\r?\n/).filter((line) => line.trim()).length,
    pageCount: cloud.pageCount || null,
    text: cloud.text,
    preview: cloud.text.slice(0, 1500) + (cloud.charCount > 1500 ? "\n\n... (文档较长，后续内容已完全载入上下文)" : ""),
    quality: {
      source: "mineru",
      readable: assessment.readable || cloud.charCount >= 200,
      score: assessment.score,
      reasons: assessment.reasons,
      metrics: assessment.metrics,
      modelVersion: cloud.modelVersion,
      ocrFallback: cloud.ocrFallback,
      imageCount: cloud.imageCount,
      elapsedMs: cloud.elapsedMs,
    },
    degraded: false,
  };
}

/**
 * @param {object} params
 * @param {string} params.filename
 * @param {string} [params.text] 纯文本（本地解析用）
 * @param {string} [params.contentBase64] 二进制（本地解析用）
 * @param {Buffer} [params.buffer] 已解码的字节（云端解析用，省一次 base64 解码）
 * @param {"auto"|"local"|"cloud"} [params.mode]
 * @param {(key: string) => unknown} params.getConfig 读 App 配置
 * @param {(input: string, init?: object) => Promise<Response>} [params.fetchFn] 宿主网络出口
 * @param {string} [params.dataDir]
 * @param {object} [params.logger]
 * @param {(stage: string, message: string) => void} [params.onProgress]
 */
export async function parseDocumentSmart({
  filename,
  text,
  contentBase64,
  buffer,
  mode = "auto",
  getConfig,
  fetchFn,
  dataDir,
  logger,
  onProgress,
  localFn,
  cloudFn,
}) {
  const chosen = PARSE_MODES.includes(mode) ? mode : "auto";
  const isPdf = String(filename || "").toLowerCase().endsWith(".pdf");

  // 云端只处理 PDF；其它格式没必要送出去
  if (chosen === "cloud" && !isPdf) {
    throw new Error("云端解析只支持 PDF");
  }

  // ---- 只上云 ----
  if (chosen === "cloud") {
    return await runCloud({ filename, buffer, contentBase64, getConfig, fetchFn, dataDir, logger, onProgress, cloudFn, attemptReason: "requested" });
  }

  // ---- 本地 ----
  let local = null;
  let localError = null;
  try {
    local = localFn ? await localFn() : await parseDocument({ filename, text, contentBase64 });
  } catch (err) {
    localError = err;
  }

  const localOk = Boolean(local?.ok);

  // ---- 只用本地 ----
  if (chosen === "local") {
    if (localOk) return shapeLocalResult(local);
    throw localError || new Error("本地解析失败");
  }

  // ---- 自动：够用就返回，不够才升级 ----
  if (localOk) {
    const verdict = needsCloud({ local, localError: null });
    if (!verdict.needs) return shapeLocalResult(local);

    const availability = mineruReady(getConfig);
    if (!availability.ready || (!fetchFn && !cloudFn)) {
      // 不满足上云条件就老老实实把本地结果交出去，并说明为什么没升级
      return {
        ...shapeLocalResult(local),
        quality: {
          ...local.quality,
          cloudSkipped: !availability.ready
            ? (availability.options.enabled ? "未配置 API Token" : "云端解析未启用")
            : "宿主网络不可用",
        },
      };
    }
    try {
      return await runCloud({
        filename, buffer, contentBase64, getConfig, fetchFn, dataDir, logger, onProgress, cloudFn, attemptReason: verdict.reason,
      });
    } catch (err) {
      // 云端失败不该让整件事白费，本地结果能看就先给本地
      const message = err?.message || String(err);
      logger?.warn?.(`MinerU 解析失败，回落到本地结果：${message}`);
      return {
        ...shapeLocalResult(local),
        quality: { ...local.quality, cloudFailed: message },
      };
    }
  }

  // ---- 本地彻底失败：只能靠云端 ----
  const availability = mineruReady(getConfig);
  if (!availability.ready) {
    // 把本地失败原因说得更具体一点，别让用户只看到"解析失败"
    const hint = availability.options.enabled ? "（已启用云端解析，但还没填 API Token）" : "（云端解析未启用，可在设置里打开）";
    const err = localError || new Error("本地解析失败");
    err.message = `${err.message}${isPdf ? ` ${hint}` : ""}`;
    throw err;
  }
  if (!fetchFn && !cloudFn) throw localError || new Error("宿主网络不可用");
  return await runCloud({
    filename, buffer, contentBase64, getConfig, fetchFn, dataDir, logger, onProgress, cloudFn, attemptReason: localError?.code || "local-failed",
  });
}

async function runCloud({ filename, buffer, contentBase64, getConfig, fetchFn, dataDir, logger, onProgress, cloudFn, attemptReason }) {
  const availability = mineruReady(getConfig);
  if (!availability.ready) {
    throw new Error(
      availability.options.enabled
        ? "云端解析已启用，但还没有填写 MinerU API Token"
        : "云端解析未启用，请先在设置里打开并填写 API Token",
    );
  }
  if (cloudFn) {
    const cloud = await cloudFn();
    return { ...shapeCloudResult(cloud, filename), escalatedFrom: attemptReason };
  }
  const bytes = buffer || (contentBase64 ? Buffer.from(contentBase64, "base64") : null);
  if (!bytes?.length) throw new Error("文件内容为空");

  try {
    const cloud = await parsePdfWithMineru({
      buffer: bytes,
      fileName: filename,
      options: availability.options,
      fetchFn,
      onProgress,
    });
    if (dataDir && cloud.cacheId) {
      await storeMineruCache({ dataDir, cacheId: cloud.cacheId, zipBytes: cloud._zip, logger });
    }
    const shaped = shapeCloudResult(cloud, filename);
    delete cloud._zip;
    return { ...shaped, escalatedFrom: attemptReason };
  } catch (err) {
    if (err instanceof MineruError) {
      logger?.warn?.(`MinerU[${err.stage}] ${err.message}`);
    }
    throw err;
  }
}

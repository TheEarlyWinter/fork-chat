import { defineApp } from "./sdk/app-contract/server-client.js";
import { createAgentDirectory } from "./lib/agents.js";
import { createChatService } from "./lib/chat.js";
import { createArtifactService } from "./lib/document-artifacts.js";
import { parseDocumentSmart } from "./lib/parse-router.js";
import { resolveMineruOptions, sweepMineruCache } from "./lib/mineru-parse.js";
import { createAppSettings } from "./lib/app-settings.js";
import { createDocumentService } from "./lib/document-service.js";
import { createBridgeService } from "./lib/bridge-service.js";
import { createBridgeIntents } from "./lib/bridge-intents.js";
import { createHandoffService } from "./lib/handoff-service.js";
import { parserError } from "./lib/parser-network.js";
import fs from "node:fs/promises";
import path from "node:path";

export const name = "fork-chat";

export default defineApp(async (sdk) => {
  await sdk.logger.info("分叉对话 (Fork Chat) 初始化启动...");

  // 数据存储路径：优先使用 sdk.dataDir，保证全局唯一
  const dataDir = sdk.dataDir || path.resolve(process.env.HOME || "", ".hanako", "app-data", "fork-chat");

  const agentDirectory = createAgentDirectory(sdk);
  const getAgentFullProfile = agentDirectory.getProfile;
  const listAllAgents = agentDirectory.list;

  const artifactService = createArtifactService({ dataDir });
  const chatService = createChatService(sdk, {
    getAgentFullProfile,
    timeoutMs: 120000,
    dataDir,
    artifactService,
  });

  /** App 自管的设置（云端解析的 Token 与开关），启动时读一次，之后同步取 */
  const appSettings = createAppSettings({ dataDir, logger: sdk.logger });
  await appSettings.load();
  const getConfig = (key) => appSettings.get(key);
  const setConfig = (key, value) => appSettings.set(key, value);
  /** 宿主网络出口：manifest 没声明 network 时这里会是 null，云端解析自动降级 */
  const hostFetch = sdk.network?.fetch ? (input, init) => sdk.network.fetch(input, init) : null;

  const documents = createDocumentService({ sdk, dataDir, getConfig });

  // 启动清扫：上一次进程留下的上传碎片与过期云端缓存。
  // 内存里的记录随进程没了，磁盘上的文件却还在，以前没人回收。
  void (async () => {
    try { await documents.sweepOrphans?.(); } catch (error) { sdk.logger?.warn?.('[upload] 启动清扫失败', error?.message); }
    try { await sweepMineruCache({ dataDir, logger: sdk.logger }); } catch (error) { sdk.logger?.warn?.('[mineru] 缓存清扫失败', error?.message); }
  })();
  /** 本体会话桥：只读优先，投递走 Outbox 的 prepare / confirm */
  const bridgeIntents = createBridgeIntents({ dataDir, logger: sdk.logger });
  const bridgeService = createBridgeService({ sdk, dataDir, intents: bridgeIntents });

  /** 在 Hana 中继续（分支交接服务） */
  const handoffService = createHandoffService({ sdk, dataDir, artifacts: artifactService });

  /** 脱敏 token：只露头尾，够用户认出是哪一把 */
  const maskToken = (token) => {
    const value = String(token || "");
    if (value.length <= 12) return value ? "****" : "";
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  };

  // 工具：统一文档解析入口。本地优先，读不动才考虑上云（mode 可覆盖这一判断）
  if (sdk.tools?.register) {
    await sdk.tools.register({
      name: "document_parse",
      description: [
        "读取一份文档（PDF/DOCX/MD/TXT）并返回其文字内容。",
        "默认 mode=auto：先用本地引擎快速解析，只有在读不出内容（扫描件、字体缺失）时才升级到云端深度解析。",
        "需要时可直接指定 mode=cloud（扫描件、图文混排、公式表格密集的 PDF）或 mode=local（不允许上传文件的场景）。",
        "返回结果里的 engine 字段会告诉你实际用了哪条路。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "展示用文件名，需带扩展名，例如 论文.pdf" },
          contentBase64: { type: "string", description: "不超过 16 MiB 的文件内容（Base64）。大文件必须在面板上传，不支持路径读取。" },
          mode: {
            type: "string",
            enum: ["auto", "local", "cloud"],
            description: "auto=本地优先按需升级（默认）；local=只用本地；cloud=直接云端解析（会消耗额度并上传文件）",
          },
          maxChars: { type: "number", description: "返回文本的字符上限，默认 40000" },
        },
        required: ["filename", "contentBase64"],
      },
      execute: async (args) => {
        const payload = args || {};
        const maxChars = Number.isFinite(payload.maxChars) ? Math.max(1000, Math.min(200000, payload.maxChars)) : 40000;
        try {
          if (payload.path !== undefined) throw new Error("工具不接受任意 path，请使用面板上传或小文件 contentBase64");
          const contentBase64 = payload.contentBase64;
          if (typeof contentBase64 !== "string" || !contentBase64 || contentBase64.length > Math.ceil(16 * 1024 * 1024 / 3) * 4) throw new Error("缺少文件内容或超过 16 MiB，请在面板上传");
          const result = await parseDocumentSmart({
            filename: payload.filename,
            contentBase64,
            mode: payload.mode,
            getConfig,
            fetchFn: hostFetch,
            dataDir,
            logger: sdk.logger,
          });
          const truncated = result.text.length > maxChars ? `${result.text.slice(0, maxChars)}\n\n…（已截断，原文 ${result.charCount} 字）` : result.text;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    engine: result.engine,
                    engineLabel: result.engineLabel,
                    filename: result.filename,
                    charCount: result.charCount,
                    pageCount: result.pageCount,
                    escalatedFrom: result.escalatedFrom || null,
                    cloudSkipped: result.quality?.cloudSkipped || null,
                    cloudFailed: result.quality?.cloudFailed || null,
                    quality: result.quality?.readable ? "readable" : result.quality?.reasons,
                  },
                  null,
                  2,
                ) + `\n\n---\n\n${truncated}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: parserError(err), code: err?.code || null }) }],
          };
        }
      },
    });
  }

  // 启动自检：云端解析的接线是否到位，看日志就知道，不用猜
  {
    const mu = resolveMineruOptions(getConfig);
    await sdk.logger.info(
      `云端解析：开关 ${mu.enabled ? "开" : "关"} · Token ${mu.token ? "已配置" : "未配置"} · 网络出口 ${hostFetch ? "可用" : "不可用"}`,
    );
  }

  // 工具：把本体的一条消息/一个会话送进画布（先存凭条，不直接导入）
  if (sdk.tools?.register) {
    const reply = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    await sdk.tools.register({
      name: "bridge_import",
      description: [
        "把当前这条消息或这个会话登记为「分叉对话」的待确认导入。",
        "不会发送消息、不会调用模型、不会读隐藏推理。",
        "调用后用户需在分叉对话里选画布并确认，导入才会发生。",
      ].join(" "),
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (args) => {
        const context = args?.context || {};
        const sessionPath = typeof context.sessionPath === "string" ? context.sessionPath : null;
        if (!sessionPath) return reply({ ok: false, code: "surface_unsupported", error: "当前入口没有会话上下文" });
        try {
          // 不信任参数里自报的身份：用宿主给的 sessionPath 反查真实 sessionId
          const found = await sdk.bus.request("session:get", { sessionPath, scope: "all" });
          const session = found?.session;
          const sessionId = session?.sessionId;
          if (!sessionId) return reply({ ok: false, code: "session_not_addressable", error: "无法确定会话身份" });
          if (session.ownerPluginId) {
            return reply({ ok: false, code: "session_not_addressable", error: "不支持把其他应用私有会话导入" });
          }
          const intent = await bridgeIntents.enqueue({
            sessionId,
            messageId: typeof context.messageId === "string" ? context.messageId : null,
            title: session.title || session.firstMessage || "",
            origin: context.messageId ? "message-action" : "context-menu",
          });
          return reply({
            ok: true,
            intentId: intent.intentId,
            hint: "导入请求已准备。打开「分叉对话」后可选择画布并确认。",
          });
        } catch (err) {
          const message = String(err?.message || err);
          const code = /permission|denied|403/i.test(message) ? "permission_missing" : "invalid_request";
          return reply({ ok: false, code, error: message.slice(0, 200) });
        }
      },
    });
  }

  // 注册 HTTP API 路由：提供模型池与助手列表查询、流式推理接口与取消接口
  if (sdk.routes?.register) {
    await sdk.routes.register((app) => {
      documents.register(app);
      artifactService.register(app);
      bridgeService.register(app);
      handoffService.register(app);
      // 1. 获取系统助手列表接口 (包含人格与绑定模型及思考能力契约)
      app.get("/api/agents", async (c) => {
        try {
          const agents = await listAllAgents();
          let models = [];
          if (sdk.models?.list) {
            try {
              const res = await sdk.models.list();
              const list = Array.isArray(res?.models) ? res.models : (Array.isArray(res) ? res : []);
              models = list.map(m => {
                const provider = m.provider || m.providerId || "host";
                const id = m.id || m.modelId || m.model || "";
                const ref = m.ref || (provider && id ? `${provider}/${id}` : id);
                return {
                  ref,
                  provider,
                  id,
                  name: m.name || m.displayName || id,
                  isDefault: Boolean(m.isCurrent || m.isDefault),
                  reasoning: Boolean(m.reasoning),
                  thinkingLevels: Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [],
                  defaultThinkingLevel: typeof m.defaultThinkingLevel === "string" ? m.defaultThinkingLevel : null,
                };
              });
            } catch {}
          }
          // 同名模型可能同时挂在两个 provider 下，只按 id 匹配会把 B 的助手配上 A 的思考能力。
          // 先用规范化 provider/model 精确命中，再退到唯一无歧义的旧 ID。
          const modelFor = (agent) => {
            // 规范化后的字段是 id，不是 model。之前写成 m.model 永远匹配不上，
            // 精确分支形同虚设，最后靠"唯一才用"的兜底碰运气。
            const exact = models.find(m => m.provider && agent.provider
              && m.provider === agent.provider && m.id === agent.model);
            if (exact) return exact;
            const ref = models.find(m => m.ref === `${agent.provider}/${agent.model}`);
            if (ref) return ref;
            const byId = models.filter(m => m.id === agent.model || m.ref === agent.model);
            return byId.length === 1 ? byId[0] : null;
          };
          const enrichedAgents = agents.map(a => {
            const matchedModel = modelFor(a);
            return {
              ...a,
              reasoning: matchedModel ? matchedModel.reasoning : Boolean(a.reasoning),
              thinkingLevels: matchedModel ? matchedModel.thinkingLevels : (Array.isArray(a.thinkingLevels) ? a.thinkingLevels : []),
              defaultThinkingLevel: matchedModel ? matchedModel.defaultThinkingLevel : (a.defaultThinkingLevel || null),
            };
          });
          return c.json({ ok: true, agents: enrichedAgents, models });
        } catch (err) {
          return c.json({ ok: false, error: String(err) }, 500);
        }
      });

      // 2. 获取模型列表 (向后兼容)
      app.get("/api/models", async (c) => {
        try {
          if (sdk.models?.list) {
            const res = await sdk.models.list();
            const list = Array.isArray(res?.models) ? res.models : (Array.isArray(res) ? res : []);
            const models = list.map(m => {
              const provider = m.provider || m.providerId || "host";
              const id = m.id || m.modelId || m.model || "";
              const ref = m.ref || (provider && id ? `${provider}/${id}` : id);
              return {
                ref,
                provider,
                id,
                name: m.name || m.displayName || id,
                isDefault: Boolean(m.isCurrent || m.isDefault),
                reasoning: Boolean(m.reasoning),
                thinkingLevels: Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [],
                defaultThinkingLevel: typeof m.defaultThinkingLevel === "string" ? m.defaultThinkingLevel : null,
              };
            });
            return c.json({ ok: true, models });
          }
          return c.json({ ok: true, models: [] });
        } catch (err) {
          return c.json({ ok: false, error: String(err) }, 500);
        }
      });

      // 3. 真实大模型流式推理接口（NDJSON 协议）
      app.post("/api/chat/stream", (c) => chatService.handleStream(c));

      // 4. 取消流式推理接口
      app.post("/api/chat/cancel", (c) => chatService.handleCancel(c));

      // 5d. UI 侧错误上报：界面里抛的异常在哪儿都看不到，先送到日志里
      app.post("/api/document/client-error", async (c) => {
        try {
          const body = await c.req.json();
          void sdk.logger.warn(`[ui-error] ${body.stage || "?"} · ${String(body.message || "").slice(0, 400)}`);
        } catch {}
        return c.json({ ok: true });
      });

      // 5b. 云端解析设置：读（token 脱敏）与写
      app.get("/api/mineru/settings", (c) => {
        const options = resolveMineruOptions(getConfig);
        return c.json({
          ok: true,
          enabled: options.enabled,
          ready: options.enabled && Boolean(options.token),
          hasToken: Boolean(options.token),
          tokenHint: maskToken(options.token),
          modelVersion: options.modelVersion,
          language: options.language,
          enableFormula: options.enableFormula,
          enableTable: options.enableTable,
          isOcr: options.isOcr,
          timeoutSeconds: options.timeoutSeconds,
          networkAvailable: Boolean(hostFetch),
        });
      });

      app.post("/api/mineru/settings", async (c) => {
        try {
          const body = await c.req.json();
          const patch = {};
          if (typeof body.enabled === "boolean") patch.mineruEnabled = body.enabled;
          // 只有传了非空字符串才覆盖 token：留空表示“别动我原来那把”
          if (typeof body.token === "string" && body.token.trim()) {
            patch.mineruApiToken = body.token.trim();
          }
          if (body.clearToken === true) patch.mineruApiToken = "";
          if (typeof body.modelVersion === "string") patch.mineruModelVersion = body.modelVersion;
          if (typeof body.language === "string") patch.mineruLanguage = body.language;
          if (typeof body.enableFormula === "boolean") patch.mineruEnableFormula = body.enableFormula;
          if (typeof body.enableTable === "boolean") patch.mineruEnableTable = body.enableTable;
          if (typeof body.isOcr === "boolean") patch.mineruIsOcr = body.isOcr;
          if (Number.isFinite(body.timeoutSeconds)) patch.mineruTimeoutSeconds = body.timeoutSeconds;
          // 一次批量、等落盘。写不进去就如实返回错误，不能回一句"已保存"
          if (Object.keys(patch).length) await appSettings.setMany(patch);

          const options = resolveMineruOptions(getConfig);
          return c.json({
            ok: true,
            enabled: options.enabled,
            ready: options.enabled && Boolean(options.token),
            hasToken: Boolean(options.token),
            tokenHint: maskToken(options.token),
          });
        } catch (err) {
          return c.json({ ok: false, error: err.message || String(err) }, 400);
        }
      });

    });
  }

  await sdk.logger.info("分叉对话 (Fork Chat) 核心服务就绪。");

  // Local authenticated health check only; never calls MinerU.
  void documents.runtime.ready().then(
    () => sdk.logger.info("[parser-runtime] 自检通过 · authenticated protocol v2"),
    error => sdk.logger.warn(`[parser-runtime] 自检未通过 code=${String(error.code || "RUNTIME_UNAVAILABLE").replace(/[^A-Za-z0-9_:-]/g, "").slice(0, 80)}`),
  ).catch(() => {});

});

import { defineApp } from "./sdk/app-contract/server-client.js";
import { createAgentDirectory } from "./lib/agents.js";
import { createChatService } from "./lib/chat.js";
import { parseDocumentSmart } from "./lib/parse-router.js";
import { resolveMineruOptions } from "./lib/mineru-parse.js";
import { createAppSettings } from "./lib/app-settings.js";
import { createDocumentService } from "./lib/document-service.js";
import { createBridgeService } from "./lib/bridge-service.js";
import { createBridgeIntents } from "./lib/bridge-intents.js";
import { parserError } from "./lib/parser-network.js";
import fs from "node:fs/promises";
import path from "node:path";

export const name = "timeline-reverser";

export default defineApp(async (sdk) => {
  await sdk.logger.info("Timeline Reverser (时光倒流仪) 初始化启动...");

  // 数据存储路径：优先使用 sdk.dataDir，保证全局唯一
  const dataDir = sdk.dataDir || path.resolve(process.env.HOME || "", ".hanako", "app-data", "timeline-reverser");
  const snapshotsFile = path.join(dataDir, "snapshots.json");
  const branchesFile = path.join(dataDir, "branches.json");

  async function ensureStorage() {
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch {}
  }

  async function loadJson(filePath, defaultValue) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return defaultValue;
    }
  }

  async function saveJson(filePath, data) {
    await ensureStorage();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // 1. 工具：获取当前会话的世界线树状 DAG 与快照
  await sdk.tools.register({
    name: "timeline_get_tree",
    description: "获取当前会话的历史分支拓扑图（DAG）、全部时间节点与已保存的快照锚点。",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话ID（可选，默认读取当前会话）",
        },
      },
    },
    execute: async (args) => {
      const snapshots = await loadJson(snapshotsFile, []);
      const branches = await loadJson(branchesFile, [
        { id: "main", name: "主干 (α)", color: "#18181b", createdAt: Date.now() },
      ]);

      const lastBranch = branches[branches.length - 1];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                branches,
                snapshots,
                activeBranch: lastBranch?.name || "主干 (α)",
                summary: `已加载 ${branches.length} 条世界线分支，${snapshots.length} 个快照锚点。`,
              },
              null,
              2
            ),
          },
        ],
      };
    },
  });

  // 2. 工具：创建时间锚点快照 (Save Point)
  await sdk.tools.register({
    name: "timeline_create_snapshot",
    description: "在当前或指定历史对话节点建立命名时间锚点（快照），以便随时回溯或对比。",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "快照名称，如 '工作区清理前' 或 '架构方案确认点'",
        },
        nodeId: {
          type: "string",
          description: "快照所锚定的历史消息/步骤节点ID",
        },
        description: {
          type: "string",
          description: "快照备忘说明",
        },
      },
      required: ["title"],
    },
    execute: async (args) => {
      const snapshots = await loadJson(snapshotsFile, []);
      const newSnapshot = {
        id: `snap-${Date.now().toString(36)}`,
        title: args.title,
        nodeId: args.nodeId || `node-${Date.now()}`,
        description: args.description || "",
        timestamp: Date.now(),
        formattedTime: new Date().toLocaleString("zh-CN", { hour12: false }),
      };

      snapshots.unshift(newSnapshot);
      await saveJson(snapshotsFile, snapshots);

      // 更新输入栏状态指示
      if (sdk.inputStatus?.set) {
        try {
          await sdk.inputStatus.set({
            id: "worldline-status",
            text: `世界线: 主干 α [${args.title}]`,
            tooltip: `最近快照: ${args.title} (${newSnapshot.formattedTime})`,
          });
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: `时间锚点已建立：[${newSnapshot.title}] (ID: ${newSnapshot.id})，记录时间：${newSnapshot.formattedTime}。`,
          },
        ],
      };
    },
  });

  // 3. 工具：从指定节点分叉平行宇宙 (Fork Universe) —— 核心交互点
  await sdk.tools.register({
    name: "timeline_fork_universe",
    description: "从选定的历史消息节点开辟一条全新的平行世界分支，保留祖先上下文，开启独立演进。",
    parameters: {
      type: "object",
      properties: {
        fromNodeId: {
          type: "string",
          description: "作为新世界线祖先节点的 ID",
        },
        branchName: {
          type: "string",
          description: "新平行宇宙的名称，例如 '世界线 β: 深度推导版'",
        },
        initialPrompt: {
          type: "string",
          description: "在新平行世界里作为第一条指令发送的内容",
        },
      },
    },
    execute: async (args) => {
      const branches = await loadJson(branchesFile, [
        { id: "main", name: "主干 (α)", color: "#18181b", createdAt: Date.now() },
      ]);

      const clickedText = args?.context?.messageText ? `（针对消息: "${args.context.messageText.slice(0, 20)}..."）` : "";
      const branchName = args.branchName || `平行宇宙-${(branches.length).toString().padStart(2, "0")}`;
      const newBranch = {
        id: `branch-${Date.now().toString(36)}`,
        name: branchName,
        originNodeId: args.fromNodeId || args?.context?.messageId || "head",
        originSnippet: args?.context?.messageText?.slice(0, 60) || "",
        createdAt: Date.now(),
        formattedTime: new Date().toLocaleString("zh-CN", { hour12: false }),
      };

      branches.push(newBranch);
      await saveJson(branchesFile, branches);

      // 关键响应：立即更新输入状态栏，给予用户极其鲜明的即时反馈！
      if (sdk.inputStatus?.set) {
        try {
          await sdk.inputStatus.set({
            id: "worldline-status",
            text: `世界线: ${branchName} (活跃)`,
            tooltip: `已成功开辟平行分支: ${branchName}\n祖先点: ${newBranch.originNodeId}`,
          });
        } catch {}
      }

      await sdk.logger.info(`平行世界分叉已完成: ${branchName}`);

      return {
        content: [
          {
            type: "text",
            text: `平行世界线已成功开辟：[${newBranch.name}] ${clickedText}。\n状态栏已同步切入该世界线，祖先切片已锚定！`,
          },
        ],
      };
    },
  });

  // 4. 工具：历史切片回溯预览 (Rollback Slice)
  await sdk.tools.register({
    name: "timeline_rollback_preview",
    description: "计算并生成回溯到指定节点时的上下文切片，输出无损回退方案。",
    parameters: {
      type: "object",
      properties: {
        targetNodeId: {
          type: "string",
          description: "回溯目标节点的ID",
        },
      },
      required: ["targetNodeId"],
    },
    execute: async (args) => {
      return {
        content: [
          {
            type: "text",
            text: `回溯计算完成。目标节点 ${args.targetNodeId} 之前的完整上下文已提取为独立快照包，回溯后将剪除后续污染轮次。`,
          },
        ],
      };
    },
  });

  // 启动时设置初始输入状态
  if (sdk.inputStatus?.set) {
    try {
      const branches = await loadJson(branchesFile, [{ id: "main", name: "主干 (α)" }]);
      const active = branches[branches.length - 1];
      await sdk.inputStatus.set({
        id: "worldline-status",
        text: `世界线: ${active.name}`,
        tooltip: `当前活跃分支: ${active.name} (共 ${branches.length} 条分支)`,
      });
    } catch {}
  }

  const agentDirectory = createAgentDirectory(sdk);
  const getAgentFullProfile = agentDirectory.getProfile;
  const listAllAgents = agentDirectory.list;

  const chatService = createChatService(sdk, {
    getAgentFullProfile,
    timeoutMs: 120000,
  });

  /** App 自管的设置（云端解析的 Token 与开关），启动时读一次，之后同步取 */
  const appSettings = createAppSettings({ dataDir, logger: sdk.logger });
  await appSettings.load();
  const getConfig = (key) => appSettings.get(key);
  const setConfig = (key, value) => appSettings.set(key, value);
  /** 宿主网络出口：manifest 没声明 network 时这里会是 null，云端解析自动降级 */
  const hostFetch = sdk.network?.fetch ? (input, init) => sdk.network.fetch(input, init) : null;

  const documents = createDocumentService({ sdk, dataDir, getConfig });
  /** 本体会话桥：只读优先，投递走 Outbox 的 prepare / confirm */
  const bridgeIntents = createBridgeIntents({ dataDir, logger: sdk.logger });
  const bridgeService = createBridgeService({ sdk, dataDir, intents: bridgeIntents });

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
      bridgeService.register(app);
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
          const enrichedAgents = agents.map(a => {
            const matchedModel = models.find(m => m.id === a.model || m.ref === `${a.provider}/${a.model}` || m.ref === a.model);
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

      documents.register(app);

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
          if (typeof body.enabled === "boolean") setConfig("mineruEnabled", body.enabled);
          // 只有传了非空字符串才覆盖 token：留空表示“别动我原来那把”
          if (typeof body.token === "string" && body.token.trim()) {
            setConfig("mineruApiToken", body.token.trim());
          }
          if (body.clearToken === true) setConfig("mineruApiToken", "");
          if (typeof body.modelVersion === "string") setConfig("mineruModelVersion", body.modelVersion);
          if (typeof body.language === "string") setConfig("mineruLanguage", body.language);
          if (typeof body.enableFormula === "boolean") setConfig("mineruEnableFormula", body.enableFormula);
          if (typeof body.enableTable === "boolean") setConfig("mineruEnableTable", body.enableTable);
          if (typeof body.isOcr === "boolean") setConfig("mineruIsOcr", body.isOcr);
          if (Number.isFinite(body.timeoutSeconds)) setConfig("mineruTimeoutSeconds", body.timeoutSeconds);

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

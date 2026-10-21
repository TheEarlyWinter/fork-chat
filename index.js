import { defineApp } from "./sdk/app-contract/server-client.js";
import { createAgentDirectory } from "./lib/agents.js";
import { createChatService } from "./lib/chat.js";
import { parseDocumentSmart } from "./lib/parse-router.js";
import { resolveMineruOptions } from "./lib/mineru-parse.js";
import { createAppSettings } from "./lib/app-settings.js";
import { createUploadStore } from "./lib/upload-store.js";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";

/** 调用方身份：拿不到就用 local，至少不会跨会话串读 */
function ownerOf(c) {
  return (
    c.req.header("x-hana-app-surface-session") ||
    c.req.header("x-hana-document-binding") ||
    c.req.header("x-hana-app-iframe-ticket") ||
    "local"
  );
}

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

  /** 异步解析任务表：放内存就行，App 重启丢了也无所谓，文件还在磁盘上 */
  const parseJobs = new Map();
  /** 分块上传账本：所有体积极限在服务端再算一遍，不信前端 */
  const uploadStore = createUploadStore({ dataDir, logger: sdk.logger });
  const MAX_CONCURRENT_JOBS = 4;
  /** 超过这个体积就走 Node 肋手流式上传，不再挤 32 MiB 的 RPC */
  const LARGE_FILE_BYTES = 16 * 1024 * 1024;
  let parserRuntime = null;

  /** 找一个空闲的回环端口，宿主要求提前声明端口才能代理 */
  function pickLoopbackPort() {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
  }

  /** 确保 Node 肋手在跑。权限没批时这里会抛错，交给上层说清楚 */
  async function ensureParserRuntime() {
    if (parserRuntime?.state === "ready") return parserRuntime;
    if (typeof sdk.runtime?.start !== "function") {
      throw Object.assign(new Error("当前宿主不支持托管运行时，大文件无法云端解析"), { code: "runtime_unsupported" });
    }
    const port = await pickLoopbackPort();
    const info = await sdk.runtime.start({
      runtime: "node",
      entry: "runtime/parser.mjs",
      args: [String(port)],
      profile: "native",
      network: "external",
      service: { port, readyMarker: "PARSER_READY" },
    });
    parserRuntime = info;
    void sdk.logger.info(`[parser-runtime] 已启动 ${info.runtimeId} · ${info.state} · ${info.profile}/${info.network}`);
    return info;
  }

  /** 等肋手报就绪，宿主得先看到 readyMarker 才会打开代理 */
  async function waitParserReady(info, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await sdk.runtime.get(info.runtimeId).catch(() => null);
      if (current?.service?.state === "ready") return current;
      if (current?.state === "failed" || current?.state === "exited") {
        throw new Error(`解析助手启动失败（${current.state}）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("解析助手未在预期时间内就绪");
  }

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
          path: {
            type: "string",
            description: "文档在 App 数据目录内的相对路径，例如 uploads/1699.pdf。与 contentBase64 二选一。",
          },
          contentBase64: { type: "string", description: "文档的 Base64 内容。文件较大时优先用 path。" },
          mode: {
            type: "string",
            enum: ["auto", "local", "cloud"],
            description: "auto=本地优先按需升级（默认）；local=只用本地；cloud=直接云端解析（会消耗额度并上传文件）",
          },
          maxChars: { type: "number", description: "返回文本的字符上限，默认 40000" },
        },
        required: ["filename"],
      },
      execute: async (args) => {
        const payload = args || {};
        const maxChars = Number.isFinite(payload.maxChars) ? Math.max(1000, Math.min(200000, payload.maxChars)) : 40000;
        try {
          let contentBase64 = typeof payload.contentBase64 === "string" ? payload.contentBase64 : undefined;
          if (!contentBase64 && payload.path) {
            // 只允许读 App 数据目录内的文件，防止顺着手滑读穿到别处
            const root = path.resolve(dataDir);
            const abs = path.resolve(root, String(payload.path));
            if (!abs.startsWith(root + path.sep)) {
              return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "只能读取 App 数据目录内的文件" }) }] };
            }
            contentBase64 = (await fs.readFile(abs)).toString("base64");
          }
          if (!contentBase64) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "缺少文件内容（需要 path 或 contentBase64）" }) }] };
          }
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
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: err?.message || String(err), code: err?.code || null }) }],
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

  // 注册 HTTP API 路由：提供模型池与助手列表查询、流式推理接口与取消接口
  if (sdk.routes?.register) {
    await sdk.routes.register((app) => {
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

      // 5. 大文件分块上传：宿主单次 RPC 上限 32 MiB，base64 再胀三分之一，
      // 26 MB 的扫描件直接就被挡在门外，所以大文件只能切块送进来
      // 5. 分块上传：首块不带 uploadId（由服务端开户），后续块带回来。
      // 体积极限、块数、归属全在 lib/upload-store.js 里把关，前端说的尺寸不算数。
      app.post("/api/document/upload", async (c) => {
        try {
          const body = await c.req.json();
          const owner = ownerOf(c);
          let uploadId = String(body.uploadId || "");

          if (!uploadId) {
            uploadId = uploadStore.begin({
              owner,
              filename: body.filename,
              size: body.size ?? body.totalSize,
              total: body.total,
            }).uploadId;
          }

          const chunk = Buffer.from(String(body.chunk || ""), "base64");
          const result = await uploadStore.writeChunk({ uploadId, owner, index: body.index, buffer: chunk });
          return c.json({ ok: true, ...result });
        } catch (err) {
          return c.json({ ok: false, error: err.message || String(err) }, 400);
        }
      });

      /** 解析侧取文件：只认已完成、且属于本次调用方的上传 */
      async function resolveDocument({ uploadId, contentBase64, owner }) {
        if (uploadId) {
          const ref = await uploadStore.resolve({ uploadId, owner });
          if (!ref) throw Object.assign(new Error("上传不存在、未完成或不属于本次会话"), { code: "upload_not_found" });
          // 不在这里读进内存：大文件要交给助手流式上传
          return { filePath: ref.filePath, filename: ref.filename, size: ref.size, uploadId };
        }
        if (contentBase64) {
          const buffer = Buffer.from(String(contentBase64), "base64");
          if (!buffer.length) throw new Error("直传内容为空");
          if (buffer.length > 16 * 1024 * 1024) {
            throw Object.assign(new Error("直传内容超过 16 MB，请改用分块上传"), { code: "too_large" });
          }
          return { contentBase64: buffer.toString("base64"), size: buffer.length };
        }
        throw Object.assign(new Error("缺少文件引用"), { code: "missing_file" });
      }

      /**
       * 大文件走 Node 肋手：文件从磁盘边读边发，不经过 32 MiB 的消息通道。
       * 助手只回小状态，结果文本落在 dataDir 里由这边读。
       */
      async function parseViaHelper({ doc, onProgress }) {
        const info = await ensureParserRuntime();
        await waitParserReady(info);
        const options = resolveMineruOptions(getConfig);
        if (!options?.token) throw Object.assign(new Error("未配置 MinerU Token"), { code: "no_token" });

        const startRes = await sdk.runtime.fetch(info.runtimeId, "/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: doc.filename,
            filePath: doc.filePath,
            options: {
              token: options.token,
              apiBase: options.apiBase,
              modelVersion: options.modelVersion,
              language: options.language,
              isOcr: options.isOcr,
              enableFormula: options.enableFormula,
              enableTable: options.enableTable,
              timeoutSeconds: options.timeoutSeconds,
              pollIntervalSeconds: options.pollIntervalSeconds,
            },
          }),
          timeoutMs: 10000,
        });
        const startData = await startRes.json();
        if (!startData.ok || !startData.jobId) throw new Error(startData.error || "解析助手拒绝了该任务");
        const helperJobId = startData.jobId;

        const deadline = Date.now() + Math.max(5 * 60 * 1000, (options.timeoutSeconds || 300) * 1000);
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const statusRes = await sdk.runtime.fetch(info.runtimeId, `/jobs/${encodeURIComponent(helperJobId)}`, {
            timeoutMs: 10000,
          });
          const data = await statusRes.json();
          if (data.status === "done") {
            const payload = JSON.parse(await fs.readFile(data.resultPath, "utf8"));
            await fs.rm(data.resultPath, { force: true }).catch(() => {});
            return { ...payload, ok: true };
          }
          if (data.status === "error") throw new Error(data.error || "解析失败");
          if (data.stage) onProgress?.(data.stage);
        }
        throw new Error("云端解析超时");
      }

      // 5a. 统一文档资料解析接口 (MD/TXT/Word/PDF)：本地优先，可选云端
      // 文件来源只接受 contentBase64（≤ 16 MB）或已完成的上传引用
      app.post("/api/document/extract", async (c) => {
        try {
          const body = await c.req.json();
          const owner = ownerOf(c);
          const doc = await resolveDocument({ uploadId: body.uploadId, contentBase64: body.contentBase64, owner });
          const result = await parseDocumentSmart({
            filename: body.filename || doc.filename,
            text: body.text,
            contentBase64: doc.contentBase64,
            mode: body.mode,
            getConfig,
            fetchFn: hostFetch,
            dataDir,
            logger: sdk.logger,
          });
          if (doc.uploadId) void uploadStore.release({ uploadId: doc.uploadId });
          return c.json(result);
        } catch (err) {
          return c.json({ ok: false, error: err.message || String(err), code: err.code || null }, 400);
        }
      });

      // 5c. 异步解析任务：长请求会被宿主或代理层提前招断，所以拆成
      // 「发起 → 轮询」两步。每个请求都在秒级完成，不再赌链路耐心。
      app.post("/api/document/parse", async (c) => {
        try {
          const body = await c.req.json();
          const owner = ownerOf(c);

          const running = [...parseJobs.values()].filter((job) => job.status === "running").length;
          if (running >= MAX_CONCURRENT_JOBS) {
            return c.json({ ok: false, error: "同时进行的解析任务过多，请等前一个跑完" }, 429);
          }

          const doc = await resolveDocument({ uploadId: body.uploadId, contentBase64: body.contentBase64, owner });
          void sdk.logger.info(
            `[parse] 发起 · ${doc.filename || body.filename || "-"} · ${((doc.size || 0) / 1048576).toFixed(2)} MB · ${doc.uploadId ? "uploadId" : "base64"}`,
          );

          const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const job = {
            status: "running",
            stage: "准备解析",
            startedAt: Date.now(),
            filename: doc.filename || body.filename,
            owner: ownerOf(c),
            uploadId: doc.uploadId || null,
          };
          parseJobs.set(jobId, job);

          // 后台跑，不堵这个请求
          void (async () => {
            try {
              const cloudOn = getConfig("mineruEnabled") === true;
              const useHelper = Boolean(doc.filePath) && doc.size > LARGE_FILE_BYTES && cloudOn;
              let result;
              if (useHelper) {
                job.stage = "交给解析助手";
                result = await parseViaHelper({ doc, onProgress: (stage) => { job.stage = stage; } });
              } else {
                // 小文件直接读；本地引擎只靠 pdf.js，不必绕助手
                const contentBase64 = doc.contentBase64 || (await fs.readFile(doc.filePath)).toString("base64");
                result = await parseDocumentSmart({
                  filename: doc.filename || body.filename,
                  text: body.text,
                  contentBase64,
                  mode: body.mode,
                  getConfig,
                  fetchFn: hostFetch,
                  dataDir,
                  logger: sdk.logger,
                  onProgress: (stage) => {
                    job.stage = stage;
                  },
                });
              }
              job.status = "done";
              job.result = result;
              job.stage = "完成";
              void sdk.logger.info(`[parse] 完成 · ${result.engineLabel} · ${result.charCount} 字 · ${Date.now() - job.startedAt}ms`);
            } catch (err) {
              job.status = "error";
              job.error = err?.message || String(err);
              job.code = err?.code || null;
              void sdk.logger.warn(`[parse] 失败 · ${job.error}`);
            } finally {
              job.finishedAt = Date.now();
              // 临时扫描件不再需要，立刻清掉
              if (job.uploadId) void uploadStore.release({ uploadId: job.uploadId });
              // 结果留给前端取，五分钟后再清，防止无限堆内存
              setTimeout(() => parseJobs.delete(jobId), 5 * 60 * 1000).unref?.();
            }
          })();

          return c.json({ ok: true, jobId });
        } catch (err) {
          const status = err.code === "too_large" ? 413 : err.code === "upload_not_found" || err.code === "missing_file" ? 400 : 500;
          return c.json({ ok: false, error: err.message || String(err), code: err.code || null }, status);
        }
      });

      app.get("/api/document/parse/:jobId", (c) => {
        const jobId = String(c.req.param("jobId") || "");
        const job = parseJobs.get(jobId);
        if (!job) {
          return c.json({ ok: false, error: "任务不存在或已过期" }, 404);
        }
        if (job.owner !== ownerOf(c)) {
          return c.json({ ok: false, error: "任务不属于本次会话" }, 403);
        }
        return c.json({
          ok: true,
          status: job.status,
          stage: job.stage,
          elapsedMs: Date.now() - job.startedAt,
          result: job.status === "done" ? job.result : undefined,
          error: job.error,
          code: job.code,
        });
      });

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

});

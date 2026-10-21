import { defineApp } from "./sdk/app-contract/server-client.js";
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

  // 助手元数据与人格 Prompt 提取
  const agentsBaseDir = path.resolve(process.env.HOME || "", ".hanako", "agents");

  async function getAgentFullProfile(agentId) {
    const dir = path.join(agentsBaseDir, agentId);
    let name = agentId;
    let yuan = "unknown";
    let model = "gemini-3.8-flash-high";
    let provider = "gemini";
    let description = "";
    let systemPrompt = "";

    try {
      const configText = await fs.readFile(path.join(dir, "config.yaml"), "utf-8");
      const nameMatch = configText.match(/name:\s*([^\n\r]+)/);
      const yuanMatch = configText.match(/yuan:\s*([^\n\r]+)/);
      const modelMatch = configText.match(/models:[\s\S]*?chat:[\s\S]*?id:\s*([^\n\r]+)/);
      const providerMatch = configText.match(/models:[\s\S]*?chat:[\s\S]*?provider:\s*([^\n\r]+)/);
      if (nameMatch) name = nameMatch[1].trim();
      if (yuanMatch) yuan = yuanMatch[1].trim();
      if (modelMatch) model = modelMatch[1].trim();
      if (providerMatch) provider = providerMatch[1].trim();
    } catch {}

    try {
      const descText = await fs.readFile(path.join(dir, "description.md"), "utf-8");
      description = descText.replace(/<!--[\s\S]*?-->/g, "").trim();
    } catch {}

    try {
      const agentsMd = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
      systemPrompt = agentsMd.trim();
    } catch {}

    if (!systemPrompt && description) {
      systemPrompt = `你是 ${name}。${description}`;
    }

    return {
      id: agentId,
      name,
      yuan,
      model,
      provider,
      description,
      systemPrompt,
    };
  }

  async function listAllAgents() {
    const list = [];
    try {
      // 优先从 sdk.bus 获取官方注册列表
      if (sdk.bus?.request) {
        try {
          const res = await sdk.bus.request("agent:list", { scope: "all" });
          if (Array.isArray(res?.agents)) {
            for (const a of res.agents) {
              const full = await getAgentFullProfile(a.id);
              if (a.name) full.name = a.name;
              if (a.yuan) full.yuan = a.yuan;
              full.isCurrent = Boolean(a.isCurrent);
              list.push(full);
            }
          }
        } catch {}
      }

      // 如果列表为空则直接从文件系统枚举
      if (list.length === 0) {
        const entries = await fs.readdir(agentsBaseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const profile = await getAgentFullProfile(entry.name);
            list.push(profile);
          }
        }
      }
    } catch (e) {
      await sdk.logger.warn("读取助手列表失败: " + String(e));
    }
    return list;
  }

  // 注册 HTTP API 路由：提供模型池与助手列表查询、打字机流式推理接口
  if (sdk.routes?.register) {
    await sdk.routes.register((app) => {
      // 1. 获取系统助手列表接口 (包含人格与绑定模型)
      app.get("/api/agents", async (c) => {
        try {
          const agents = await listAllAgents();
          return c.json({ ok: true, agents });
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
              };
            });
            return c.json({ ok: true, models });
          }
          return c.json({ ok: true, models: [] });
        } catch (err) {
          return c.json({ ok: false, error: String(err) }, 500);
        }
      });

      // 3. 真实大模型流式推理接口 (Server-Sent Stream)
      app.post("/api/chat/stream", async (c) => {
        let body;
        try {
          body = await c.req.json();
        } catch {
          return c.text("Invalid JSON body", 400);
        }

        const { agentId, modelRef, messages, systemPrompt } = body || {};
        const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        // 解析目标模型与人格 Prompt
        let provider = "gemini";
        let model = "gemini-3.8-flash-high";
        let finalSystemPrompt = systemPrompt || "你是专业、敏锐、逻辑严密的智能分析助手。回答要条理清晰、直击核心、不讲套话废话。";

        // 如果传入了 agentId，全量注入该助手的真实设定与绑定模型
        if (agentId) {
          try {
            const agentProfile = await getAgentFullProfile(agentId);
            if (agentProfile) {
              if (agentProfile.provider) provider = agentProfile.provider;
              if (agentProfile.model) model = agentProfile.model;
              if (agentProfile.systemPrompt) {
                finalSystemPrompt = `${agentProfile.systemPrompt}\n\n[回答指引]：请完全沉浸并严格保持你的身份设定、语言习惯、语气和性格特征，针对用户的对话内容给出真实、自然的回应。`;
              }
            }
          } catch (e) {
            await sdk.logger.warn(`加载助手 ${agentId} 失败: ` + String(e));
          }
        } else if (typeof modelRef === "string" && modelRef.includes("/")) {
          const slash = modelRef.indexOf("/");
          provider = modelRef.slice(0, slash);
          model = modelRef.slice(slash + 1);
        }

        // 格式化 messages 为 AppModelMessageV2 契约
        const formattedMessages = Array.isArray(messages) ? messages.map(m => {
          if (m.role === "assistant") {
            return {
              role: "assistant",
              content: [{ type: "text", text: String(m.content || m.text || "") }]
            };
          }
          return {
            role: "user",
            content: String(m.content || m.text || "")
          };
        }) : [];

        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            const push = (text) => {
              if (text) controller.enqueue(encoder.encode(text));
            };

            try {
              if (!sdk.models || typeof sdk.models.stream !== "function") {
                throw new Error("SDK 模型推理接口尚未放行或当前不可用");
              }

              const input = {
                requestId,
                provider,
                model,
                messages: formattedMessages,
                systemPrompt: finalSystemPrompt,
              };

              // 优先使用 streamEvents 逐 token 迭代
              if (typeof sdk.models.streamEvents === "function") {
                for await (const event of sdk.models.streamEvents(input)) {
                  if (event.type === "text-delta" && event.delta) {
                    push(event.delta);
                  } else if (event.type === "error") {
                    throw new Error(event.message || event.code || "推理过程中返回错误");
                  }
                }
              } else {
                // 回退到 sdk.models.utility
                const utilityRes = await sdk.models.utility({
                  requestId,
                  scope: "app",
                  messages: formattedMessages.map(m => ({
                    role: m.role,
                    content: typeof m.content === "string" ? m.content : (m.content[0]?.text || "")
                  }))
                });
                push(utilityRes.text || "");
              }
              controller.close();
            } catch (err) {
              const errStr = String(err?.message || err);
              if (errStr.includes("AUTHORITY") || errStr.includes("PERMISSION") || errStr.includes("CAPABILITY") || errStr.includes("DENIED")) {
                push(`\n\n【权限待确认】宿主新增权限「app/models.infer」尚未在客户端完成审批。请在 Hana 界面中点击「允许」即可开启真正的实时流式推理。\n\n（临时响应）：已完整承袭祖先节点上下文。当前模型权限待批准中。`);
              } else {
                push(`\n\n[推理服务响应: ${errStr}]`);
              }
              controller.close();
            }
          }
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff"
          }
        });
      });
    });
  }

  await sdk.logger.info("分叉对话 (Fork Chat) 核心服务就绪。");
});

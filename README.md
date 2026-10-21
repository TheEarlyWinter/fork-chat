# 分叉对话 (Fork Chat)

> **打破单向线性聊天。**  
> 基于 HanaAgent (v2 App) 的无限 2D 树状多分支对话与模型推导工作台。支持自由拖拽连线、向右分叉追问、祖先思考链递归继承与打字机流式推理。

---

## 核心设计理念

传统的 AI 对话界面本质上是单向的**一维线性链条（Linear Linked List）**。当你在对话中想针对某一句话做延伸测试、对比不同推导思路，或者想“岔开话题”时，后续的讨论会严重污染主线上下文，试错成本极高。

**分叉对话 (Fork Chat)** 将会话状态重构为 **二维树状分支拓扑（Tree / DAG）**：

- **无限 2D 拓扑画布**：卡片支持任意自由拖拽、平移、缩放（0.4x ~ 2.2x）与视野居中；
- **向右分叉追问（Non-linear Branching）**：点击卡片右侧的 `[+]` 锚点，即可向右分裂出独立的追问卡片，通过动态 SVG 贝塞尔曲线平滑连接；
- **思考链祖先上下文递归继承（Thought-Chain Inheritance）**：在任意子分支中发问，系统自动顺着 `parentId` 向上递归攀爬直至根节点，按时序无损拼装祖先上下文，分支探索绝不反向污染主干；
- **原生打字机流式推理（Typewriter Streaming）**：基于 Web 原生 `ReadableStream` 管道，逐 token 实时打字机吐字与平滑滚动；
- **侧边栏原生模型池（Function Panel Integration）**：深度集成 Hana `fpFullPanel` 原生左侧抽屉，动态枚举宿主当前可用模型，支持跨面板广播即时热切换；
- **纯白极简美学（Pure White Minimalist）**：遵循纯白底色（`#ffffff`）、浅灰微边框（`#e4e4e7`）、炭黑文字（`#18181b`）与等宽字体排版，无多余彩色杂质与 emoji。

---

## 目录结构

```text
fork-chat/
├── manifest.json              # Hana v2 App 规范清单 (声明模型推理与侧边栏抽屉契约)
├── index.js                   # 后端路由 (提供 /api/models 与 /api/chat/stream 管道)
├── README.md                  # 项目说明文档
├── assets/
│   ├── icon.png               # 应用图标
│   └── cover.png              # 封面预览图
├── sdk/                       # Hana App Contract SDK
└── ui/
    ├── panel.html             # 2D 无限画布主工作台
    ├── function-panel.html    # Hana 左侧原生抽屉模型切换面板
    └── assets/
        ├── panel.css          # 纯白极简画布样式
        ├── panel.js           # 画布拖拽、贝塞尔连线、上下文递归与流式推导
        ├── function-panel.js  # 模型池动态拉取与跨面板广播联动
        └── sdk.js             # Hana 前端桥接 SDK
```

---

## 安装方式

### 方式一：本地软链接 / 复制至 Hana Apps 目录

```bash
# 克隆仓库
git clone https://github.com/TheEarlyWinter/fork-chat.git

# 链接至 Hana 扩展目录 (推荐目录名为 timeline-reverser 或 fork-chat)
ln -s "$(pwd)/fork-chat" "$HOME/.hanako/apps/timeline-reverser"
```

进入 HanaAgent 界面，在扩展管理中重新加载或确认 `app/models.infer` 权限，即可在左侧导航栏中看到 **「分叉对话」**。

---

## 依赖与权限声明

本 App 声明了以下 Hana v2 能力：
- `app/models.infer`: 用于调用宿主已配置的底层大模型（如 Gemini、DeepSeek、GPT 等）进行实时推理与流式响应；
- `app/tools.expose-to-model`: 暴露树状节点管理工具给 Agent；
- `app/sessions.read`: 会话快照辅助读取；
- `app/input.status`: 输入状态栏微件展示；
- `app/ui.clipboard-write`: 支持一键复制分支思考链。

---

## License

[MIT License](LICENSE) © 2026 TheEarlyWinter

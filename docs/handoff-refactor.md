# panel.js 解耦交接

写于第 6 步完成时。给下一个接手的人（或下一轮的我）。

## 交接时的事实

| 项目 | 值 |
|---|---|
| 仓库 | `/home/theearlywinter/Desktop/OH-WorkSpace/OH-Works/Projects/fork-chat` |
| 分支 | `main`，最新提交见 `git log -1` |
| 测试 | `node --experimental-vm-modules --test tests/*.test.mjs` → **460 通过 / 0 失败** |
| panel.js | 3087 行 → **1171 行** |
| 已拆模块 | 28 个（panel-*.js） |
| 版本 | manifest 1.9.4 |

跑测试要留够时间，全量大约两分钟。`tests/` 和 `*.test.mjs` 在 `.gitignore` 里，测试改动不会进版本库。

## 已经拆出去的

| 模块 | 行数 | 职责 |
|---|---|---|
| `panel-format.js` | 57 | base64 分块转换、文件大小格式化、根卡落点几何、`escapeHtml` 唯一实现 |
| `panel-context.js` | 82 | 父关系解析、链上下文组装（含连续 user 收敛） |
| `panel-messages.js` | 97 | 状态文案、输出投影、消息标记、`createMessagePainter` |
| `panel-documents.js` | 220 | 文件读取、分块上传、解析轮询、按卡片取消 |
| `panel-agents.js` | 196 | 当前助手与思考档位、名单加载、广播处理 |
| `panel-canvas-view.js` | 267 | 选择、聚焦、方向导航、连线、取景、自动整理 |
| `panel-canvas-actions.js` | 272 | 根卡/分支/资料卡创建、级联删除、删除留档 |
| `panel-history-controller.js` | 69 | 撤销栈与恢复适配 |
| `panel-chat-engine.js` | 189 | 流式发送、终止判定、三重失效检查 |
| `panel-battle-flow.js` | 99 | 对比推导弹窗与并发开分支 |
| `panel-merge.js` | 164 | 多选集合、合流工具栏、合流卡与提示词合成 |
| `panel-bridge-send.js` | 237 | 回传两阶段 prepare/confirm、正文冻结、unknown 不重试 |

侧边栏另有三个：`function-panel.js`（267，原 1239）、`function-agents.js`（351）、`function-sessions.js`（790）。

## 拆分的既定顺序（Sol 的方案，剩 10 步）

按这个顺序做，不要跳。往后每一步的依赖都建立在前一步上。

| 步 | 目标文件 | 搬什么 | 为什么排这里 |
|---|---|---|---|
| 9 | `panel-bridge-intents.js` | 凭条认领、释放、持久化、ACK | 与第 8 步协议不同，必须单独做 |
| 10 | `panel-bridge.js` | 导入弹窗、预览、来源快照、装配 | 收口前两块 |
| 11 | `panel-document-ui.js` | 附件选择、卡片拖放、导入按钮 | 只搬 UI，解析器已在第 4 步搬走 |
| 12 | `panel-card-gestures.js` | 卡片移动与缩放 | 事件层里最独立的一段 |
| 13 | `panel-card-events.js` | 其余卡片事件协调 | 依赖 11、12 先搬走 |
| 14 | `panel-renderer.js` | `renderCards`、IME 保护 | 最大的依赖面，最后搬 |
| 15 | `panel-search-controller.js` | 搜索业务适配与防抖 | 独立，随时可做 |
| 16 | `panel-session-ui.js` | 快照捕获/应用、会话命令、删除确认 | 涉及销毁顺序，收尾做 |

**目标形态**：`panel.js` 只剩画布实例状态、模块装配与依赖注入、总线单一入口、启动与销毁、`window.__forkChat` 兼容层。

## 每一步都必须守住的（详见 `docs/refactor-invariants.md`）

那份文档有 27 条，逐条对应一个曾经真实发生过的 bug。这里只列最容易在搬家时踩的：

1. **新模块不许在顶层碰 `window` / `document`**。集成测试在 VM 里加载 `panel.js`，拆出去的模块是原生 import 进来的，拿不到 VM 的 `window`。踩过一次，表现是文档卡全部建不出来且只返回失败、不抛错。
2. **会被整体替换的状态必须用 getter/setter**：`cards`、`currentAgent`、`selectedCardId`。容器身份不变的（`view`、`activeRequests`、`multiSelectedCardIds`）可以直接传引用。
3. **依赖里凡是晚于接线处才定义的，包成箭头**。否则模块求值时就把它算死了，或者直接 TDZ 报错。
4. **`runChat` 必须注入**。写死 import 会让那批替换 `./chat-client.js` 的测试全变假绿。
5. **三重失效检查**：generation、`activeRequests.get(card.id) !== active`、`cards.includes(card)`。第三条用对象身份，不能按 id 查。
6. **名字相近的依赖要看清是「拉」还是「读」**。第 6 步把 `loadAvailableAgents`（拉）接成了 `getAvailableAgents`（读），弹窗列表一直空着，提交被校验挡下，症状和原因隔了两层。
7. **按内容锚点删，不要按行号删**。按行号删 `sendCardPrompt` 时连带吃掉 260 行，测试报 `battleDialog is not defined`。撤回来重做才成。

## 已知欠账

这些不是这次拆分造成的，但都还没处理：

### 这次改造带进来的

- `panel-chat-engine.js` 里有三处可选链，让「依赖没接好」从当场报错变成静默跳过：`scheduleSave?.()`、`documentRef?.getElementById?.()`、`getCards() || []`。Sol 判断正常路径等价，但这等于把接线错误藏起来了。要收紧就改回直接调用。

### 功能缺口

- 流式响应有 16 MiB 积压上限，但**没有自动化测试**证明它会关流。写过一条，测的是复制品，删了。
- 删除确认对辅助工具有门槛：已从静默无效改成明确提示，但读屏软件模拟的点击仍删不掉。
- helper 关闭时不清结果文件（启动清扫已加，关闭时仍留）；云端缓存有 7 天 TTL 但只在启动时扫。

### 测试牢度

- `tests/panel-modules.test.mjs` 里 `panel-agents` 那一项把状态流转、广播、`deferSave`、`restoreAgent` 四件事塞在一条里，哪块坏了分不清。该拆成四条。
- 性能断言（400 条连线 <100ms）受机器负载影响，且单点耗时证明不了复杂度。
- 真实宿主总线、真实消息投递、权限被拒的表现、超大会话 RPC、跨平台、几百张卡的性能——**全部未验证**。

## 怎么接着做

1. 先跑一次全量测试，确认基线仍是 424 通过。
2. 读 `docs/refactor-invariants.md`，那份比这份重要。
3. 挑第 7 步开始，一次只做一个模块，做完就提交。
4. 每步验收：`node --check` → 全量测试 → grep 新模块有没有裸 `window`/`document` → 数行数 → 确认关键行为还在。
5. 提交信息写**为什么**，不只写改了什么。

## 协作方式

- 我（小鲸鱼）动手拆、验收、提交。
- `sol-architect` 出方案、逐行核对搬迁是否忠实。他只有只读权限，跑不了 `git`，需要对比历史版本时先把旧文件导到 `/tmp` 再让他读。
- `luna-tester` 写测试。只让她改 `tests/`，改完必须自己跑一遍再报数。
- 并行时**按文件划界**，两个人不许同时改 `panel.js`。

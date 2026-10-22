# 重构不变量清单

拆 `panel.js` 的过程中，有些行为是**修过的坑**，搬家时一旦"顺手优化"就会复发，而且测试不一定拦得住。
这份清单是给下一个动这些文件的人看的：**不要改，除非你清楚自己在撤销哪个修复。**

---

## 上下文与请求

### 1. 两条连续的 `user` 消息必须被收敛掉

`panel-context.js` 里那三行：遍历时若当前是 `user` 且前一条也是 `user`，把前一条弹掉。

一次请求失败后用户在同一张卡里重发，失败的助手回复会被剔除，前一条提问就落单了。
两条连续的 `user` 会让严格校验轮次的模型接口直接返回 400（`roles must alternate`），
这张卡此后**再也发不出去**，重试无效。

### 2. 错误判成功的范围只留一个窄口子

只有同时满足三个条件才算"其实成功了"：

- 是宿主的转换器报错（`The model provider could not complete the request` 或 `APP_MODEL_PROVIDER_ERROR`）
- 报文里出现 `signature` / `thinking` / `reasoning`
- 且已经有正文

其余一律 `failed`；已吐出的正文可以留，但要打 `partial: true`，不能冒充完整回答。
放宽这条，就会把普通的连接失败当成完整回答，还会跟着分支进入下一轮上下文。

### 3. 三重失效检查缺一不可

流式回调写回之前必须同时成立：

```js
sessionController.generation === requestGeneration
activeRequests.get(card.id) === active          // 对象身份，不是 id 相等
cards.includes(card)                            // 对象身份，不是按 id 查
```

第三条尤其不能用 id 判断：新会话里卡片 id 会从 `card-1` 重新长出来，
按 id 查会把上一轮的回复写进新会话的卡片。

同理，`finally` 里删 `activeRequests` 前要确认删的是自己那一条，否则会把同 id 的新请求删掉。

### 4. 只有心境、没有正文 = 失败

`EMPTY_BODY`。模型只回了沉思内容时不能当成功。

---

## 画布与卡片

### 5. 删卡前先留档，撤销才不会回来一个空壳

`removedCardArchive`（上限 30 张，超出丢最老的）存的是**卡片完整内容**。
撤销删除时优先用它，取不到才退回布局快照。

只用快照重建的话，删除前那段对话整段丢失，卡片回来是空的。

### 6. 删卡还要同时做两件事

- `abortDocumentTasksFor(id)`：取消那张卡的文档解析，否则卡没了后台还在分块上传、云端轮询
- `multiSelectedCardIds.delete(id)`：退出多选集合，否则合并工具条一直悬着点不动

### 7. 切会话必须清空删除留档

`applySnapshot` 里 `clearRemovedCardArchive()`。

理由同第 3 条：卡片 id 会复用，留着旧留档会把上个会话的内容塞进本会话的同 id 卡片。

### 8. 撤销布局不回滚内容

快照只回填几何与结构字段：`x / y / width / height / isCollapsed / zIndex / parentId / parentIds`，
消息正文、文档内容、附件以**现存卡片**为准。布局撤销不该把业务内容一起倒回去。

### 9. 居中要读真实高度

`focusCardInViewport` 先读 `dom-${id}.offsetHeight`，读不到退回 `card.height`，再读不到才用 360。
写死 340 的话，长文档卡（八九百像素高）居中会明显偏上。

### 10. 整理与重置只框可见卡片

折叠的子孙不能参与包围盒计算，否则视野被压得很小、屏幕留一大片白。

### 11. 新建卡片用三列网格

`rootSlotPosition`：`x = 80 + col*400`，`y = 100 + row*440`。
原来是每次只挪 40×60，而卡片本身 340×360，连建几张就叠成一摞。

### 12. 视口缩放硬限 0.4–2.2

超出会被存储契约打回（`INVALID_SESSION_SNAPSHOT`）。不要为了"能缩更小"去放宽。

---

## 界面与输入

### 13. 输入法合成期间不许重建 DOM

`renderCards` 在 `composingInputId` 有值时挂起，`compositionend` 后补一次。
否则正在选词时 DOM 被换掉，候选框消失、拼音变成裸字母。

Enter 发送要同时检查 `isComposing` 和 `keyCode === 229`。

### 14. 卡片内部的滚轮要放行

`.card-body` / `.bridge-preview` / `.card-attachment-body` 内容可滚时（`scrollHeight > clientHeight + 1`），
滚轮不能被画布接管，否则长回答翻不动。

### 15. 搜索防抖的定时器要进 `panelTimers`

面板销毁时得能清掉，否则关掉的画布还会去摸已经没了的 DOM。
清空查询例外：立刻生效，不等那 120 毫秒。

### 16. 搜索跳转前剔除已删卡片

`focusSearchMatch` 先过滤掉不在 `cards` 里的结果，否则会飞到一个不存在的位置，屏幕上啥也没有。

---

## 文档解析

### 17. 非 PDF 一律不上云

自动模式下，本地结果质量不够时也要检查扩展名。少这道闸，TXT/DOCX 的原始字节会被改名成 `.pdf` 传出去。

### 18. 解析失败就是失败

不许生成"看起来能用"的空资料卡。`ok: false` 让调用方原地报错，
而不是把失败持久化成一张内容为空的卡片。

### 19. 大文件走分块，不塞进宿主消息通道

超过 16 MiB 的走分块上传 + 本地 helper 进程流式 PUT。
整包 base64 会撞上宿主 32 MiB 的 RPC 上限。

base64 转换要分块做（块长取 3 的倍数），不要把整份文件先拼成一个二进制字符串。

---

## 桥接

### 20. 凭条（intents）认领不能跟普通请求共用 abort 策略

普通桥接请求随面板 `panelAbort` 一起取消；
但 claim / release 必须能穿透，否则面板一关就读不到迟到的凭条，也就没法释放。

### 21. 自动导入的顺序是「建卡 → 落盘 → ACK」

先 `createBridgeDocCard`，再 `await sessionController.flush(true)`，成功才 ACK。
落盘失败要 `release` 凭条并提示，不能 ACK 之后才失败。

### 22. 去重键用 `contentHash + importKind`

不含 `sessionId`。两张内容完全相同的快照卡没有价值；
来源会话不同时提示"已作为《X》导入过（来源是另一个会话）"，而不是新建。

### 23. `unknown` 状态绝不自动重试

回执丢失时保留原 `actionId` 和冻结正文，只做一次只读状态核对，不重新 prepare。

---

## 测试环境相关

### 24. 新模块不许在顶层碰 `window` / `document`

集成测试在 VM 里加载 `panel.js`，但拆出去的模块是通过原生 import 注入的，
**拿不到 VM 里的 `window`**。顶层访问会让功能静默失效而不报错。

需要 DOM 就从 deps 注入。真踩过一次：`window.__forkChatLastStage` 让文档卡全部建不出来，
而且只返回失败、不抛错。

### 25. 会被整体替换的状态必须用 getter

`cards`、`currentAgent`、`selectedCardId` 都会被整体换掉（撤销、删除、切会话、切助手）。
传值捕获的是旧数组/旧对象，之后所有写入都落在已经不在画布上的东西里。

```js
getCards: () => cards,
setCards: next => { cards = next; },
```

容器身份不变的（`view`、`activeRequests`、`multiSelectedCardIds`）可以直接传引用。

### 26. 不许反向导入 `panel.js`

跨模块调用用小范围回调注入，不要传一个包着全部状态的 `ctx`。

### 27. `runChat` 必须注入

测试靠替换 `./chat-client.js` 的导出来模拟模型。
一旦在引擎里写死 import，那批测试全变假绿。

---

## 怎么用这份清单

改完跑 `node --experimental-vm-modules --test tests/*.test.mjs`。
全绿只说明装配没断，**说明不了上面这些行为还对**——每一条背后都有一个测试当时没拦住的 bug。

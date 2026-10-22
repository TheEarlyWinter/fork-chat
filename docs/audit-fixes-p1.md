# 审阅报告修复记录（全量 19 项）

审阅对象：`5bb935d`（1.8.6）。修复后版本 **1.8.7**。

离线测试：**360 项通过 / 0 失败**（原 357；F06 拆出正反两条，F09、F10 各加一条新契约）。

---

## P1

| 项 | 问题 | 修复 |
|---|---|---|
| F01 | 撤销布局吞掉已完成的问答 | `onRestore` 不再整卡替换。快照只回填 `x/y/width/height/isCollapsed/zIndex/parentId/parentIds`，消息与正文以现存卡为准 |
| F02 | 转义漏引号，可注入事件属性 | `panel.js` 补 `"`→`&quot;`、`'`→`&#39;`；`panel-cards.js` 的默认转义器从不转义改为真转义 |
| F03 | DOCX 同步无界解压 | `inflateRawBounded()` 用 `maxOutputLength`，上限 50 MiB；实测 200 MB 炸弹被拒 |
| F04 | 没落盘就 ACK 消费凭条 | 先 `sessionController.flush(true)`，失败则 `release` 并提示可重试 |
| F05 | 静默截断文档与附件 | 正文上限 50 万→200 万字符、附件 30 万→100 万、附件数 10→20；越界写 `docContentTruncated` / `stagedAttachmentsDropped`，卡上显示「只保留了 X / Y」 |

## P2

| 项 | 问题 | 修复 |
|---|---|---|
| F06 | 通用 Provider 错误改判成功 | 只认错误消息含 `signature/thinking/reasoning` 的窄场景。其余保持 `failed` 终态，正文留卡上并标 `partial` |
| F07 | 消息映射失败静默升级为整段历史 | 带 `messageId` 但找不到 → 释放凭条、提示「不在能读到的范围里」，绝不扩大范围 |
| F08 | 盖戳/折叠/预览不能往返 | `normalize` 白名单加 `statusStamp`、`isCollapsed`、消息的 `docPreview`/`docMeta`、`partial` |
| F09 | Outbox 满 64 条不回收 | 新增 `collectExpired()`：`prepare` 满了先回收，`sweep` 复用同一规则。只回收 `prepared/accepted/delivered/failed`，`dispatching/unknown` 永不自动删 |
| F10 | Claim 无租约，崩溃后永久占用 | 加 `claimedAt` + 10 分钟租约；过期可被别的窗口接管，原窗口迟到的 ACK 被拒 |
| F11 | 外部会话切换绕过取消 | 新增 `adoptExternal()`，被动接受快照时同样 `generation++` + `cancelPending` |
| F12 | 导出漏正文、混入未完成 | 导出含 `docContent`、附件正文、消息附件正文；失败/中断/部分/本地提示逐条加标签 |
| F13 | Data Descriptor 格式 DOCX 解析失败 | 本地头 `compressedSize` 为 0 且 bit 3 置位时，让 deflate 自行跑到结束标记。实测能解出正文 |
| F14 | MinerU ZIP 总量只信声明值 | 预算改按实际 `data.length` 累计；声明值仅作提前否决 |
| F15 | 搜索搜不到文档正文 | 匹配范围加入 `docContent`、附件正文、消息 `docPreview` |
| F16 | 设置落盘失败仍报「已保存」 | `set/setMany` 改异步等落盘，失败回滚内存并 reject；路由改批量 `setMany`，写失败返回错误 |
| F18 | Outbox 首载并发覆盖旧记录 | `load()` 改 single-flight Promise，读盘未完成前不开闸 |
| F19 | 同名模型跨 Provider 错配 | 先按 `provider+model` 精确命中，再退 `ref`，最后只在结果唯一时按 id 兼容 |

## P3

| 项 | 问题 | 修复 |
|---|---|---|
| F17 | 搜索框未保护 IME 合成态 | Enter 处理加 `isComposing` / `keyCode === 229` 守卫 |

---

## 未处理

报告末尾四条架构约束未动，它们不是缺陷计数内的条目：

1. 分叉是否冻结历史（`buildChainContext` 每次读父卡现存全部消息，无 fork cutoff）
2. 「轻量历史」实为全文快照，30 步 × 全量字节，无字节预算
3. `panel.js` 仍约 2900 行，职责未隔离；`renderCards` 对每张卡重建后代索引
4. 多窗口归属、300 卡上限预检、解析缓存 GC 仍欠契约

## 验证

```bash
node --experimental-vm-modules --test tests/*.test.mjs   # 360 pass / 0 fail
```

一次性实测（未入库）：
- 带 Data Descriptor 的 docx → 正确解析出正文
- 解压后 200 MB 的 docx 炸弹 → 拒绝
- F09：过期 prepared 被回收、`unknown` 不被回收
- F10：租约过期可接管、迟到 ACK 被拒

## 未验证

真实 Hana 宿主、真实 Provider、真实 MinerU、中文输入法实机、跨平台、规模性能。以上都只有代码层与离线桩证据。

/**
 * 凭条认领与生命周期管理模块 (Bridge Intents Controller)
 *
 * 负责本体导入凭条 (intents) 的轮询、认领抢占 (claim)、释放 (release) 与生命周期调度。
 *
 * 硬约束：
 * 1. 顶层严禁出现 window / document / localStorage，一律通过 deps 注入。
 * 2. 严禁反向 import panel.js。
 * 3. 晚于接线处定义的依赖必须包成箭头。
 * 4. claim 与 release 绝不挂载 panelAbort.signal，保证即使面板关闭也能穿透并安全释放凭条。
 * 5. release 必须幂等 (ownedBridgeClaims.delete)。
 * 6. release 使用 keepalive: true。
 * 7. 每次 await 之后均校验 canMutateCanvas(generation)，失效时释放并 break。
 */

import { requestHost as defaultRequestHost } from './host-api.js';
import { assertFunction } from './panel-contracts.js';

export function createBridgeIntents(deps = {}) {
  const {
    hana,
    requestHost = defaultRequestHost,
    bridgeRequest,
  } = deps;

  // 这几个依赖缺了就是接线错了，不能给默认值。
  // 默认「门禁永远放行」「代际为 0」「身份是空串」会把错误悄悄变成行为异常：
  // 凭条被一个不存在的身份认领，然后永远释放不掉。
  const canMutateCanvas = assertFunction(deps.canMutateCanvas, 'canMutateCanvas', 'createBridgeIntents');
  const getGeneration = assertFunction(deps.getGeneration, 'getGeneration', 'createBridgeIntents');
  const getCanvasId = assertFunction(deps.getCanvasId, 'getCanvasId', 'createBridgeIntents');
  const deliverIntent = assertFunction(deps.deliverIntent, 'deliverIntent', 'createBridgeIntents');

  const resolveCanvasId = () => getCanvasId();
  const resolveHana = () => (typeof hana === 'function' ? hana() : hana);

  const ownedBridgeClaims = new Set();
  let pollBridgeIntentsBusy = false;

  function releaseBridgeClaim(intentId) {
    if (!ownedBridgeClaims.delete(intentId)) return Promise.resolve();
    const claimer = resolveCanvasId();
    return requestHost(resolveHana(), `/api/bridge/intents/${encodeURIComponent(intentId)}/release`, {
      method: 'POST',
      body: JSON.stringify({ claimer }),
      keepalive: true,
    }).catch(() => {});
  }

  /** 本体那边点的导入请求（右键 / 消息图标）：自动认领并直接铸造成卡片置入画布 */
  async function pollBridgeIntents() {
    if (!canMutateCanvas() || pollBridgeIntentsBusy) return;
    const generation = typeof getGeneration === 'function' ? getGeneration() : getGeneration;
    pollBridgeIntentsBusy = true;
    try {
      const data = await bridgeRequest('/api/bridge/intents');
      const list = Array.isArray(data?.intents) ? data.intents : [];
      if (!canMutateCanvas(generation) || !list.length) return;

      for (const intent of list) {
        if (!canMutateCanvas(generation)) break;
        if (!intent?.intentId || intent.consumed) continue;
        // 抢占凭条：使用当前窗口全局唯一的 canvasId 作为 claimer，实现真正的多窗口并发抢占与隔离
        try {
          // Observe late claim receipts even after disposal, then release our ownership.
          const claimed = await requestHost(resolveHana(), `/api/bridge/intents/${encodeURIComponent(intent.intentId)}/claim`, {
            method: 'POST',
            body: JSON.stringify({ claimer: resolveCanvasId() }),
          });
          await claimed.json();
          ownedBridgeClaims.add(intent.intentId);
          if (!canMutateCanvas(generation)) { await releaseBridgeClaim(intent.intentId); break; }
        } catch {
          continue;
        }

        try {
          const previewData = await bridgeRequest('/api/bridge/preview', {
            method: 'POST',
            body: JSON.stringify({ sessionId: intent.sessionId, kind: 'history', limit: 100 }),
          });
          if (!canMutateCanvas(generation)) { await releaseBridgeClaim(intent.intentId); break; }
          const preview = previewData?.preview;
          const messages = Array.isArray(preview?.messages) ? preview.messages : [];
          if (!messages.length) {
            await releaseBridgeClaim(intent.intentId);
            continue;
          }

          await deliverIntent(intent, {
            preview,
            messages,
            generation,
            release: () => releaseBridgeClaim(intent.intentId),
          });
          if (!canMutateCanvas(generation)) { await releaseBridgeClaim(intent.intentId); break; }
        } catch (err) {
          await releaseBridgeClaim(intent.intentId);
        }
      }
    } catch {
      // 没权限或宿主不支持都不影响画布
    } finally {
      pollBridgeIntentsBusy = false;
    }
  }

  return {
    getOwnedClaims: () => ownedBridgeClaims,
    releaseBridgeClaim,
    pollBridgeIntents,
    isBusy: () => pollBridgeIntentsBusy,
  };
}

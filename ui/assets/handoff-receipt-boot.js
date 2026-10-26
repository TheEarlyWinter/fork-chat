// 交接卡的极小启动脚本：只加载宿主 SDK、已鉴权请求与只读卡本身，不加载画布/模型池。
import { hana } from './sdk.js';
import { requestHost } from './host-api.js';
import { createHandoffReceiptCard } from './handoff-receipt.js';

const card = createHandoffReceiptCard({ hana, documentRef: document, requestHost });

// 页面被宿主卸载时解绑 surface 监听，不再持有任何 pending 请求的写入权
window.addEventListener('pagehide', () => card.dispose(), { once: true });

hana.ready();

/**
 * 分支交接的宿主适配层。
 *
 * 只走官方命名 SDK（capabilities.get / sessions.* / agents.list），不读会话文件、
 * 不走宿主内部 HTTP，也不把 SDK 方法摘下来裸调用——宿主用 receiver 绑定会话上下文，
 * 丢了 this 会静默走错入口。
 *
 * 这一层只做三件事：能力与授权体检、官方回执的形状校验、把宿主错误收敛成稳定错误码。
 * 正文与产物字节不在这里落盘，也不记录到日志。
 */
import {
  HANDOFF_ERROR_CODES,
  handoffError,
} from '../ui/assets/fork-handoff-contract.js';

/** 本流程准入需要的四条授权；startTurn 只展示，不作为门槛 */
export const HANDOFF_REQUIRED_PERMISSIONS = Object.freeze([
  'app/sessions.home',
  'app/sessions.read',
  'app/sessions.manage',
  'app/session.stage-file',
]);

/** 命名 SDK 缺一不可；缺了就明确 unsupported，不用总线或私有通道兜底 */
const REQUIRED_METHODS = Object.freeze([
  ['capabilities', 'get'],
  ['sessions', 'create'],
  ['sessions', 'context'],
  ['sessions', 'stageFile'],
  ['sessions', 'sendCustom'],
  ['agents', 'list'],
]);

export const HANDOFF_HOST_ERROR_CODES = Object.freeze({
  UNSUPPORTED: 'HANDOFF_UNSUPPORTED',
  PERMISSION_MISSING: 'HANDOFF_PERMISSION_MISSING',
  INVALID_SESSION: 'HANDOFF_INVALID_SESSION',
  HOST_ERROR: 'HANDOFF_HOST_ERROR',
});

const GRANTED_STATES = new Set(['always', 'session']);
const CUSTOM_TYPE = 'branch-handoff';
/** 创建回执允许的 owner：本 App 固定 ID，或宿主旧回执里的 null/缺省 */
const OWNER_APP_ID = 'timeline-reverser';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hostError(code, message, details) {
  return handoffError(code, message, details);
}

/**
 * 宿主原始错误不可直接透传：原文可能夹带正文、私有路径或凭据。
 * 只把原文用于内存内分类，对外永远是固定短文案与稳定错误码。
 */
function classifyError(error, fallbackCode = HANDOFF_HOST_ERROR_CODES.HOST_ERROR) {
  if (error && typeof error.code === 'string' && error.code.startsWith('HANDOFF_')) return error;
  const raw = typeof error?.message === 'string' ? error.message : String(error ?? '');
  if (/permission|denied|forbidden|not permitted|unauthori[sz]ed|EACCES|EPERM|403|权限|未授权/i.test(raw)) {
    return hostError(HANDOFF_HOST_ERROR_CODES.PERMISSION_MISSING, '宿主拒绝了这项操作');
  }
  return hostError(fallbackCode, '宿主调用失败');
}

export function createHandoffHost({ sdk } = {}) {
  if (!sdk || typeof sdk !== 'object') {
    throw new TypeError('createHandoffHost 需要宿主 sdk');
  }

  function missingMethods() {
    const missing = [];
    for (const [domain, method] of REQUIRED_METHODS) {
      if (typeof sdk[domain]?.[method] !== 'function') missing.push(`${domain}.${method}`);
    }
    return missing;
  }

  function unsupported(missing = missingMethods()) {
    return hostError(
      HANDOFF_HOST_ERROR_CODES.UNSUPPORTED,
      '当前宿主没有提供分支交接所需的命名 SDK',
      { missingMethods: missing },
    );
  }

  /** 读能力账本；读不到就按"未确认授予"处理，绝不猜成已授权 */
  async function readGrants() {
    let result;
    try {
      result = await sdk.capabilities.get();
    } catch {
      return null;
    }
    const rows = Array.isArray(result?.capabilities) ? result.capabilities : [];
    const grants = {};
    for (const row of rows) {
      if (row && typeof row.capability === 'string') {
        grants[row.capability] = typeof row.status === 'string' ? row.status : 'not_asked';
      }
    }
    return grants;
  }

  function granted(grants, capability) {
    return GRANTED_STATES.has(grants?.[capability]);
  }

  async function requireGrants(required) {
    const missing = missingMethods();
    if (missing.length) throw unsupported(missing);
    const grants = await readGrants();
    if (!grants) {
      throw hostError(
        HANDOFF_HOST_ERROR_CODES.PERMISSION_MISSING,
        '无法确认分支交接所需授权',
        { missing: [...required] },
      );
    }
    const missingGrants = required.filter(capability => !granted(grants, capability));
    if (missingGrants.length) {
      throw hostError(
        HANDOFF_HOST_ERROR_CODES.PERMISSION_MISSING,
        `缺少授权：${missingGrants.join('、')}`,
        { missing: missingGrants },
      );
    }
  }

  async function capabilities() {
    const missing = missingMethods();
    if (missing.length) {
      return {
        supported: false,
        available: false,
        home: false,
        read: false,
        manage: false,
        stageFile: false,
        missing: [],
        reason: HANDOFF_HOST_ERROR_CODES.UNSUPPORTED,
      };
    }

    const grants = await readGrants();
    const available = capability => Boolean(grants) && granted(grants, capability);
    const home = available('app/sessions.home');
    const read = available('app/sessions.read');
    const manage = available('app/sessions.manage');
    const stageFile = available('app/session.stage-file');
    const missingGrants = HANDOFF_REQUIRED_PERMISSIONS.filter(capability => !available(capability));

    return {
      supported: true,
      available: missingGrants.length === 0,
      home,
      read,
      manage,
      stageFile,
      missing: grants ? missingGrants : [...HANDOFF_REQUIRED_PERMISSIONS],
      reason: missingGrants.length === 0
        ? null
        : HANDOFF_HOST_ERROR_CODES.PERMISSION_MISSING,
    };
  }

  function receiptSessionId(receipt) {
    if (nonEmptyString(receipt?.sessionId)) return receipt.sessionId;
    if (nonEmptyString(receipt?.sessionRef?.sessionId)) return receipt.sessionRef.sessionId;
    return null;
  }

  function invalidCreate(receipt, sessionId) {
    const error = hostError(
      HANDOFF_HOST_ERROR_CODES.INVALID_SESSION,
      sessionId
        ? '宿主创建回执不是主页公开会话，已保留已知会话 ID'
        : '宿主创建回执不完整，没有可信会话 ID',
      sessionId ? { sessionId } : undefined,
    );
    // service 需要凭这个 ID 保存半成品，而不是把已知现场丢掉
    if (sessionId) error.sessionId = sessionId;
    return error;
  }

  async function create({ agentId } = {}) {
    if (!nonEmptyString(agentId)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_AGENT, '缺少有效的助手 ID');
    }
    await requireGrants(['app/sessions.home']);

    let receipt;
    try {
      receipt = await sdk.sessions.create({ namespace: 'home', memoryEnabled: false, agentId });
    } catch (error) {
      throw classifyError(error);
    }

    const sessionId = receiptSessionId(receipt);
    const owner = receipt?.ownerPluginId;
    // home 主页会话靠 namespace+visibility 认定；owner 是创建者 App 的盖章，不是私有标记
    const homeAndPublic = receipt?.ok === true
      && receipt?.namespace === 'home'
      && receipt?.visibility === 'public'
      && (owner === null || owner === undefined || owner === OWNER_APP_ID);
    if (!homeAndPublic || !sessionId) throw invalidCreate(receipt, sessionId);

    return { sessionId };
  }

  async function isIdle(sessionId) {
    if (!nonEmptyString(sessionId)) {
      throw hostError(HANDOFF_HOST_ERROR_CODES.INVALID_SESSION, '缺少有效的会话 ID');
    }
    await requireGrants(['app/sessions.read']);

    let result;
    try {
      result = await sdk.sessions.context({ sessionId, scope: 'all' });
    } catch (error) {
      throw classifyError(error);
    }

    // 只认目标匹配且三个运行标记明确为空；systemPrompt 等字段不读、不回传
    const matches = typeof result?.sessionId === 'string' && result.sessionId === sessionId;
    return matches
      && result.isStreaming === false
      && result.isCompacting === false
      && result.pendingMessageCount === 0;
  }

  async function stage({ sessionId, path: filePath, name, mime } = {}) {
    if (!nonEmptyString(sessionId) || !nonEmptyString(filePath) || !nonEmptyString(name) || !nonEmptyString(mime)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_FILE, '交付文件缺少参数');
    }
    await requireGrants(['app/session.stage-file']);

    let receipt;
    try {
      receipt = await sdk.sessions.stageFile({
        path: filePath,
        sessionId,
        scope: 'all',
        name,
        mime,
        deliverAs: 'attachment',
      });
    } catch (error) {
      throw classifyError(error);
    }

    const resource = receipt?.resource;
    const fileId = resource?.fileId;
    // 正式回执才是标识来源；不从文件名或路径猜 ID
    if (!isPlainObject(resource)
      || resource.kind !== 'session-file'
      || !nonEmptyString(fileId)
      || resource.sessionId !== sessionId) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_FILE, '宿主没有返回可用的会话文件标识');
    }

    return { fileId, name, mime };
  }

  async function writeContext({ sessionId, content, details } = {}) {
    if (!nonEmptyString(sessionId) || typeof content !== 'string' || content.length === 0) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_CONTEXT, '交接正文缺少参数');
    }
    await requireGrants(['app/sessions.manage']);

    let receipt;
    try {
      receipt = await sdk.sessions.sendCustom({
        sessionId,
        scope: 'all',
        content,
        customType: CUSTOM_TYPE,
        display: true,
        triggerTurn: false,
        details,
      });
    } catch (error) {
      throw classifyError(error);
    }

    // 宿主会把 customType 命名空间化，不能要求回显原值；
    // 但必须明确是 notifyOnly 且带回可信 entryId，ok:true 本身不算成功。
    if (receipt?.ok !== true
      || receipt?.mode !== 'notifyOnly'
      || !nonEmptyString(receipt?.entryId)) {
      throw handoffError(HANDOFF_ERROR_CODES.HANDOFF_INVALID_CONTEXT, '宿主没有返回只通知的会话条目');
    }

    return { entryId: receipt.entryId };
  }

  return { capabilities, create, isIdle, stage, writeContext };
}

/**
 * fork-session-store.js
 * App 自有分叉会话管理模块。
 * 遵循 Hana APPS.md 存储规范：
 * 1. 使用 hana.storage.global（宿主原子落盘，owner-only，不伪造 user 分区，不建自定义 HTTP 后端）；
 * 2. 使用 Web Locks API 串行化读-修订-写事务；无 locks 写入显式抛 STORAGE_LOCK_UNAVAILABLE；
 * 3. 根键 'fork-chat.sessions.v1'，版本 1，上限 100 个会话，单文档 JSON 上限 12MB；
 * 4. 纯函数 normalizeForkSnapshot 白名单深拷贝与断流截断，杜绝污染与未完成状态残留。
 */

import {
  ID_REGEX, createError, parentIdsOf, normalizeForkSnapshot,
  DOC_CONTENT_MAX_CHARS, ATTACHMENT_MAX_CHARS, STATUS_STAMPS,
} from './fork-snapshot.js';

// 归一化搬去 fork-snapshot.js，这里继续对外暴露，既有 import 一行都不用改
export { normalizeForkSnapshot, DOC_CONTENT_MAX_CHARS, ATTACHMENT_MAX_CHARS, STATUS_STAMPS };

export const FORK_SESSION_STORAGE_KEY = "fork-chat.sessions.v1";
export const STORAGE_MAX_SESSIONS = 100;
export const STORAGE_MAX_BYTES = 12 * 1024 * 1024; // 12MB
export const STORE_LOCK_NAME = "fork-chat-session-store-v1";

/** 只有这两种根版本能读；写出去永远是当前版本 */
export const STORE_VERSION = 2;
export const READABLE_STORE_VERSIONS = Object.freeze([1, 2]);

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function unwrapStorageValue(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value;
  }
  return result;
}

/**
 * 校验并清洗会话标题：空白压缩+trim、非空、<=80 UTF16字符、拒绝剩余控制字符
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeSessionTitle(raw) {
  if (typeof raw !== "string") {
    throw createError("INVALID_SESSION_TITLE", "Title must be a string");
  }
  const compressed = raw.trim().replace(/\s+/g, " ");
  if (compressed.length === 0) {
    throw createError("INVALID_SESSION_TITLE", "Title cannot be empty");
  }
  if (compressed.length > 80) {
    throw createError("INVALID_SESSION_TITLE", "Title exceeds maximum length of 80 characters");
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(compressed)) {
    throw createError("INVALID_SESSION_TITLE", "Title contains illegal control characters");
  }
  return compressed;
}

/**
 * 自动提取标题：取卡片树中第一条 user 文本，压缩空白并截取前 40 字符，否则回退 '新会话'
 * @param {object} snapshot
 * @returns {string}
 */
export function generateAutoTitle(snapshot) {
  if (snapshot && Array.isArray(snapshot.cards)) {
    for (const card of snapshot.cards) {
      if (Array.isArray(card.messages)) {
        for (const msg of card.messages) {
          if (msg && msg.role === "user" && typeof msg.text === "string") {
            const compressed = msg.text.trim().replace(/\s+/g, " ");
            if (compressed) {
              return compressed.slice(0, 40);
            }
          }
        }
      }
    }
  }
  return "新会话";
}

/**
 * 校验并深度克隆 Snapshot，不修改传入的活对象。
 * @param {any} input
 * @returns {object} normalizedSnapshot
 */

/**
 * 校验已解析的 Session 存储完整文档
 */
function validateStoreDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw createError("SESSION_STORE_CORRUPT", "Storage document is corrupt or not an object");
  }
  if (!READABLE_STORE_VERSIONS.includes(doc.version)) {
    throw createError("SESSION_STORE_CORRUPT", `Unknown session store version: ${doc.version}`);
  }
  if (!Array.isArray(doc.sessions)) {
    throw createError("SESSION_STORE_CORRUPT", "Storage document sessions must be an array");
  }
  if (doc.sessions.length > STORAGE_MAX_SESSIONS) throw createError('SESSION_STORE_CORRUPT', 'Too many stored sessions');
  const ids = new Set();
  for (const rec of doc.sessions) {
    if (!rec || typeof rec !== 'object' || !ID_REGEX.test(rec.id || '') || ids.has(rec.id)
      || !Number.isSafeInteger(rec.revision) || rec.revision < 1 || typeof rec.title !== 'string'
      || !Number.isFinite(rec.createdAt) || !Number.isFinite(rec.updatedAt)) {
      throw createError('SESSION_STORE_CORRUPT', 'Invalid session record in storage document');
    }
    ids.add(rec.id);
    if (doc.version === 1) {
      const polluted = Array.isArray(rec.snapshot?.cards)
        && rec.snapshot.cards.some(card => card && (card.contextMode !== undefined || card.contextRefs !== undefined));
      if (polluted) {
        throw createError('SESSION_STORE_CORRUPT', 'Version 1 store carries version 2 context fields');
      }
    }
    try { rec.snapshot = normalizeForkSnapshot(rec.snapshot); }
    catch { throw createError('SESSION_STORE_CORRUPT', 'Invalid saved canvas; original storage was not overwritten'); }
  }
  if (doc.activeId !== null && !ids.has(doc.activeId)) throw createError('SESSION_STORE_CORRUPT', 'Invalid active session reference');
}

/**
 * 默认 ID 生成器
 */
function defaultIdFactory() {
  return `sess_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

/**
 * 创建 App 自有分叉会话管理 Store
 * @param {object} hana - 包含 hana.storage.global 的 SDK 或 facade
 * @param {object} [options]
 * @param {object} [options.locks] - Web Locks API（默认 globalThis.navigator?.locks）
 * @param {() => number} [options.now] - 时间源（默认 Date.now）
 * @param {() => string} [options.idFactory] - ID 工厂
 */
export function createForkSessionStore(hana, options = {}) {
  const {
    locks = globalThis.navigator?.locks,
    now = Date.now,
    idFactory = defaultIdFactory,
  } = options;

  if (!hana || !hana.storage || !hana.storage.global) {
    throw new Error("createForkSessionStore requires hana.storage.global");
  }

  const storage = hana.storage.global;

  // 内部：读取文档并严格校验
  async function readDoc() {
    const raw = await storage.get(FORK_SESSION_STORAGE_KEY);
    const val = unwrapStorageValue(raw);
    if (val === undefined || val === null) {
      return {
        version: STORE_VERSION,
        activeId: null,
        sessions: [],
        initialized: false,
      };
    }
    const doc = deepClone(val);
    validateStoreDoc(doc);
    if (doc.initialized === undefined) {
      doc.initialized = true;
    }
    return doc;
  }

  // 内部：写入文档并检查容量限制
  async function writeDoc(doc) {
    // 只写当前版本：旧窗口读不懂 v2，会在读的时候自己停下，而不是把新字段洗掉
    doc.version = STORE_VERSION;
    if (doc.sessions.length > STORAGE_MAX_SESSIONS) {
      throw createError("STORAGE_QUOTA_EXCEEDED", `Session count exceeds maximum quota of ${STORAGE_MAX_SESSIONS}`);
    }
    const serialized = JSON.stringify(doc);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > STORAGE_MAX_BYTES) {
      throw createError("STORAGE_QUOTA_EXCEEDED", `Session document size (${bytes} bytes) exceeds 12MB limit`);
    }
    await storage.set(FORK_SESSION_STORAGE_KEY, doc);
  }

  // 内部：带锁执行事务。无锁直接抛错，绝不降级覆盖写
  async function withLock(operation) {
    if (!locks || typeof locks.request !== "function") {
      throw createError("STORAGE_LOCK_UNAVAILABLE", "Web Locks API (navigator.locks) is unavailable");
    }
    return await locks.request(STORE_LOCK_NAME, async () => {
      return await operation();
    });
  }

  return {
    /**
     * 原子确保存在活动会话：返回当前活动记录或首条；若库为空则原子新建
     */
    async ensure(snapshot) {
      return await withLock(async () => {
        const doc = await readDoc();
        if (doc.sessions.length > 0) {
          if (doc.activeId) {
            const found = doc.sessions.find((s) => s.id === doc.activeId);
            if (found) return deepClone(found);
          }
          doc.activeId = doc.sessions[0].id;
          await writeDoc(doc);
          return deepClone(doc.sessions[0]);
        }

        // 若已被初始化过（即用户此前操作过并删空了所有会话），不自动重生会话，保持空状态
        if (doc.initialized) {
          return null;
        }

        // 仅在首次打开（存储中从未写入过会话库）时，才创建首条默认会话
        const normalized = normalizeForkSnapshot(snapshot);
        const title = generateAutoTitle(normalized);
        const currentTime = now();
        const newRecord = {
          id: idFactory(),
          title,
          revision: 1,
          createdAt: currentTime,
          updatedAt: currentTime,
          manualTitle: false,
          snapshot: normalized,
        };

        doc.sessions.push(newRecord);
        doc.activeId = newRecord.id;
        doc.initialized = true;
        await writeDoc(doc);
        return deepClone(newRecord);
      });
    },

    /**
     * 列出所有会话摘要信息（只读，无需锁）
     */
    async list() {
      const doc = await readDoc();
      return {
        activeId: doc.activeId,
        sessions: doc.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          revision: s.revision,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          cardCount: s.snapshot?.cards ? s.snapshot.cards.length : 0,
        })),
      };
    },

    /**
     * 获取指定 ID 的完整会话记录（只读，无需锁）
     */
    async get(id) {
      const doc = await readDoc();
      const found = doc.sessions.find((s) => s.id === id);
      if (!found) {
        throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
      }
      return deepClone(found);
    },

    /**
     * 新建会话并将 activeId 切换至新会话
     */
    async create(snapshot, { title } = {}) {
      return await withLock(async () => {
        const doc = await readDoc();
        if (doc.sessions.length >= STORAGE_MAX_SESSIONS) {
          throw createError("STORAGE_QUOTA_EXCEEDED", `Cannot create session: maximum ${STORAGE_MAX_SESSIONS} reached`);
        }

        const normalized = normalizeForkSnapshot(snapshot);
        const isManual = Boolean(title && typeof title === "string" && title.trim().length > 0);
        const sessionTitle = isManual ? sanitizeSessionTitle(title) : generateAutoTitle(normalized);
        const currentTime = now();

        const record = {
          id: idFactory(),
          title: sessionTitle,
          revision: 1,
          createdAt: currentTime,
          updatedAt: currentTime,
          manualTitle: isManual,
          snapshot: normalized,
        };

        doc.sessions.push(record);
        doc.activeId = record.id;
        await writeDoc(doc);
        return deepClone(record);
      });
    },

    /**
     * 仅切换 activeId
     */
    async activate(id) {
      return await withLock(async () => {
        const doc = await readDoc();
        const found = doc.sessions.find((s) => s.id === id);
        if (!found) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }
        if (doc.activeId !== id) {
          doc.activeId = id;
          await writeDoc(doc);
        }
        return deepClone(found);
      });
    },

    /**
     * 保存快照：严格比对 expectedRevision，版本冲突抛 SESSION_CONFLICT
     */
    async save(id, expectedRevision, snapshot) {
      return await withLock(async () => {
        const doc = await readDoc();
        const record = doc.sessions.find((s) => s.id === id);
        if (!record) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }
        if (record.revision !== expectedRevision) {
          throw createError(
            "SESSION_CONFLICT",
            `Session conflict: expected revision ${expectedRevision} but found ${record.revision}`
          );
        }

        const normalized = normalizeForkSnapshot(snapshot);
        record.revision = expectedRevision + 1;
        record.updatedAt = now();
        record.snapshot = normalized;

        if (!record.manualTitle) {
          record.title = generateAutoTitle(normalized);
        }

        await writeDoc(doc);
        return deepClone(record);
      });
    },

    /**
     * 重命名会话：校验标题合法性，CAS比对 expectedTitle（若传），仅递增 revision 与刷新 updatedAt
     */
    async rename(id, title, expectedTitle) {
      const sanitizedTitle = sanitizeSessionTitle(title);
      return await withLock(async () => {
        const doc = await readDoc();
        const record = doc.sessions.find((s) => s.id === id);
        if (!record) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }

        if (typeof expectedTitle === "string" && record.title !== expectedTitle) {
          throw createError(
            "SESSION_CONFLICT",
            "会话名称已变化，请取消编辑后重新操作。"
          );
        }

        record.title = sanitizedTitle;
        record.manualTitle = true;
        record.revision += 1;
        record.updatedAt = now();

        await writeDoc(doc);
        return deepClone(record);
      });
    },

    /**
     * 删除会话：比对 expectedRevision，若删最后一个则会话清空（activeId 为 null），若删全局 active 选剩余最近 updatedAt 记录
     */
    async remove(id, expectedRevision, fallbackSnapshot) {
      return await withLock(async () => {
        const doc = await readDoc();
        const index = doc.sessions.findIndex((s) => s.id === id);
        if (index === -1) {
          throw createError("SESSION_NOT_FOUND", `Session not found: ${id}`);
        }

        const record = doc.sessions[index];
        if (record.revision !== expectedRevision) {
          throw createError(
            "SESSION_CONFLICT",
            `Session conflict: expected revision ${expectedRevision} but found ${record.revision}`
          );
        }

        // 删除目标记录
        doc.sessions.splice(index, 1);
        doc.initialized = true;

        // 若会话已被全部删空：activeId 置 null，返回 null session
        if (doc.sessions.length === 0) {
          doc.activeId = null;
          await writeDoc(doc);
          return {
            deletedId: id,
            activeId: null,
            session: null,
          };
        }

        // 存在剩余会话时：若删的是全局 active，则选择剩余中最近 updatedAt 记录
        if (doc.activeId === id) {
          let latest = doc.sessions[0];
          for (let i = 1; i < doc.sessions.length; i++) {
            if (doc.sessions[i].updatedAt > latest.updatedAt) {
              latest = doc.sessions[i];
            }
          }
          doc.activeId = latest.id;
        }

        await writeDoc(doc);
        const activeRecord = doc.sessions.find((s) => s.id === doc.activeId);
        return {
          deletedId: id,
          activeId: doc.activeId,
          session: deepClone(activeRecord),
        };
      });
    },

    /**
     * 监听当前 App 根键变更
     */
    watch(callback) {
      if (typeof storage.onChanged !== "function") {
        return () => {};
      }
      return storage.onChanged((keys) => {
        if (Array.isArray(keys) && keys.includes(FORK_SESSION_STORAGE_KEY)) {
          try {
            callback();
          } catch {
            // 回调异常安全隔离
          }
        }
      });
    },
  };
}

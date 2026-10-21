import { normalizeForkSnapshot } from './fork-session-store.js';

// Owns one canvas, not Hana's native chat sessions. All durable writes go
// through the host-backed store; broadcasts are commands/status only.
export function createForkSessionController({ store, capture, apply, cancelPending, onChange = () => {}, delayMs = 600 }) {
  let active = null, sessions = [], ready = false, busy = false, error = '';
  let generation = 0, changed = 0, saved = 0, timer = null, saving = false;
  let tail = Promise.resolve(), refreshing = 0, closed = false;
  const detail = err => `${err?.code || 'SESSION_STORAGE_ERROR'}: ${err?.message || '会话保存失败'}`;
  const state = () => ({ activeId: active?.id || null, activeRevision: active?.revision || null, title: active?.title || '', ready, busy, saving, dirty: changed > saved, error, sessions, generation });
  const notify = () => onChange(state());
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };

  async function refresh() {
    const sequence = ++refreshing;
    const list = await store.list();
    if (sequence === refreshing) { sessions = list.sessions; notify(); }
    return list;
  }
  function scheduleSave() {
    if (!ready || busy || closed) return;
    const alreadyDirty = changed > saved;
    changed++;
    if (timer === null && !error) timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => {});
    }, delayMs);
    if (!alreadyDirty) notify();
  }
  function flush(force = false) {
    clearTimer();
    if ((!ready || busy || closed) && !force) return tail;
    const job = tail.catch(() => {}).then(async () => {
      if (!active) return;
      const id = active.id;
      saving = true; error = ''; notify();
      try {
        const snapshot = normalizeForkSnapshot(capture());
        if (JSON.stringify(snapshot) === JSON.stringify(active.snapshot)) {
          saved = changed; return;
        }
        if (changed <= saved) changed = saved + 1;
        const version = changed;
        const record = await store.save(id, active.revision, snapshot);
        active = record;
        saved = version;
        // A successful durable write stays successful even if a later list read fails.
        sessions = sessions.map(item => item.id === record.id ? {
          ...item, title: record.title, revision: record.revision, updatedAt: record.updatedAt,
          cardCount: record.snapshot.cards.length,
        } : item);
      } catch (err) { error = detail(err); throw err; }
      finally {
        saving = false; notify();
        if (changed > saved && !busy && !closed && !error && timer === null) {
          timer = setTimeout(() => { timer = null; void flush().catch(() => {}); }, delayMs);
        }
      }
    });
    tail = job;
    return job;
  }
  async function install(record) {
    active = record;
    changed = saved = 0;
    // The live canvas must not mutate the durable comparison baseline.
    await apply(JSON.parse(JSON.stringify(record.snapshot)));
  }
  async function init() {
    if (busy || closed) return;
    busy = true; error = ''; notify();
    try {
      const record = await store.ensure(capture());
      if (closed) return;
      await install(record);
      ready = true;
      await refresh();
    } catch (err) { error = detail(err); }
    finally { busy = false; notify(); }
  }
  async function transition(id) {
    if (!ready || busy || closed || !id || id === active?.id) return;
    busy = true; error = ''; clearTimer(); generation++;
    cancelPending('会话已切换');
    changed++; // Commit interrupted messages and last input drafts before leaving.
    notify();
    try {
      await flush(true);
      if (closed) return;
      const record = await store.activate(id);
      if (closed) return;
      await install(record);
      await refresh();
    } catch (err) { error = detail(err); }
    finally { busy = false; notify(); }
  }
  async function newSession(snapshot) {
    // Creation snapshot is supplied separately to avoid reusing the old canvas.
    if (!ready || busy || closed) return;
    busy = true; error = ''; clearTimer(); generation++;
    cancelPending('会话已切换'); changed++; notify();
    try {
      await flush(true);
      if (closed) return;
      const record = await store.create(snapshot);
      if (closed) return;
      await install(record);
      await refresh();
    } catch (err) { error = detail(err); }
    finally { busy = false; notify(); }
  }
  async function saveCopy() {
    if (!ready || busy || closed) return;
    busy = true; error = ''; clearTimer(); generation++;
    cancelPending('正在保存会话副本'); changed++; notify();
    try {
      await tail.catch(() => {});
      const record = await store.create(capture(), { title: `${active?.title || '会话'}（副本）` });
      if (closed) return;
      await install(record);
      await refresh();
    } catch (err) { error = detail(err); }
    finally { busy = false; notify(); }
  }
  function resumeDirty() {
    if (!ready || closed || !active) return;
    try {
      if (JSON.stringify(normalizeForkSnapshot(capture())) !== JSON.stringify(active.snapshot)) scheduleSave();
    } catch (err) { if (!error) error = detail(err); }
  }
  async function rename(id, title, expectedTitle) {
    if (!ready || busy || closed) return { ok: false, error: '会话正忙，请稍后重试。' };
    busy = true; error = ''; clearTimer(); notify();
    try {
      await flush(true);
      if (closed) return { ok: false, error: '画布已关闭。' };
      const record = await store.rename(id, title, expectedTitle);
      if (active?.id === id) active = record; // Never apply/reset the live canvas during rename.
      sessions = sessions.map(item => item.id === id ? { ...item, title: record.title, revision: record.revision, updatedAt: record.updatedAt } : item);
      await refresh().catch(() => {});
      return { ok: true };
    } catch (err) {
      // Metadata errors belong to the inline editor, not the autosave breaker.
      // A failed flush already set `error`; preserve that true storage failure.
      return { ok: false, error: detail(err) };
    }
    finally { busy = false; resumeDirty(); notify(); }
  }
  async function remove(id, expectedRevision, fallbackSnapshot) {
    if (!ready || busy || closed) return { ok: false, error: '会话正忙，请稍后重试。' };
    const isCurrent = id === active?.id;
    busy = true; error = ''; clearTimer();
    if (isCurrent) { generation++; cancelPending('会话正在删除'); changed++; }
    notify();
    try {
      // Await already-started saves, but do not require another save of data
      // the user explicitly confirmed deleting (including a full-quota store).
      await tail.catch(() => {});
      if (closed) return { ok: false, error: '画布已关闭。' };
      // Confirmation supplies the authoritative revision read when it opened.
      // Local saves accepted after that read may advance it; foreign writes
      // after either accepted boundary still fail the store's atomic CAS.
      const revision = isCurrent ? Math.max(active.revision, expectedRevision) : expectedRevision;
      const result = await store.remove(id, revision, fallbackSnapshot);
      if (isCurrent && !closed) await install(result.session);
      sessions = sessions.filter(item => item.id !== id);
      await refresh().catch(() => {});
      return { ok: true };
    } catch (err) { return { ok: false, error: detail(err) }; }
    finally { busy = false; resumeDirty(); notify(); }
  }
  function close() {
    clearTimer(); closed = true; generation++;
    cancelPending('页面已关闭');
    changed++;
    // Best effort only: the last acknowledged autosave is the recovery boundary.
    return flush(true);
  }
  return { get state() { return state(); }, get generation() { return generation; }, init, refresh, scheduleSave, flush, switchTo: transition, newSession, saveCopy, rename, remove, close };
}

import { normalizeForkSnapshot } from './fork-session-store.js';

// Owns one canvas, not Hana's native chat sessions. All durable writes go
// through the host-backed store; broadcasts are commands/status only.
export function createForkSessionController({ store, capture, apply, cancelPending, onChange = () => {}, delayMs = 600 }) {
  let active = null, sessions = [], ready = false, busy = false, error = '';
  let generation = 0, changed = 0, saved = 0, timer = null, saving = false;
  let tail = Promise.resolve(), refreshing = 0, closed = false;
  let notice = '';
  let conflict = null;
  let refreshQueued = false;
  let installing = false;
  let saveOwner = null, saveOwnerSeq = 0;

  const detail = err => `${err?.code || 'SESSION_STORAGE_ERROR'}: ${err?.message || '会话保存失败'}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  const sameSnapshot = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const state = () => ({
    activeId: active?.id || null,
    activeRevision: active?.revision || null,
    title: active?.title || '',
    ready,
    busy,
    saving,
    dirty: changed > saved,
    error,
    notice,
    conflict,
    sessions,
    generation,
  });
  const notify = () => onChange(state());
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };

  function makeError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function conflictError(kind = conflict) {
    if (kind === 'deleted') {
      return makeError('SESSION_DELETED', '会话已在别处删除，本地修改未保存，请另存副本。');
    }
    if (kind === 'active-changed') {
      return makeError('SESSION_ACTIVE_CHANGED', '其他窗口已切换当前会话，本地修改未保存。');
    }
    return makeError('SESSION_CONFLICT', '另一窗口已修改本会话，本地修改未覆盖。');
  }

  function updateSessionSummary(record) {
    if (!record) return;
    sessions = sessions.map(item => item.id === record.id ? {
      ...item,
      title: record.title,
      revision: record.revision,
      updatedAt: record.updatedAt,
      cardCount: record.snapshot?.cards?.length || 0,
    } : item);
  }

  function markConflict(kind, latest = null) {
    conflict = kind;
    clearTimer();
    if (latest && active?.id === latest.id) {
      // Keep the local snapshot as the comparison baseline. Only the remote
      // revision is advanced so an explicit retry can perform a fresh CAS.
      active = { ...active, revision: latest.revision, title: latest.title };
      updateSessionSummary(latest);
    }
    const conflictErr = conflictError(kind);
    error = detail(conflictErr);
    notice = kind === 'deleted'
      ? '会话已在别处删除，请另存副本保留本地修改'
      : kind === 'active-changed'
      ? '其他窗口已切换当前会话，请确认保存或另存副本'
      : '另一窗口已修改本会话，点击“覆盖远端并保存”才会覆盖它的修改';
    notify();
  }

  function clearConflict() {
    conflict = null;
    error = '';
    notice = '';
  }

  function isSaveScopeCurrent(scope) {
    return generation === scope.generation
      && active?.id === scope.id
      && (!closed || scope.allowClosed);
  }

  function isRefreshIdentityCurrent(scope) {
    return !closed
      && scope.sequence === refreshing
      && generation === scope.generation
      && (active?.id || null) === scope.activeId;
  }

  function isRefreshScopeCurrent(scope) {
    return isRefreshIdentityCurrent(scope)
      && changed === scope.changed
      && saved === scope.saved;
  }

  function claimSaving() {
    const owner = ++saveOwnerSeq;
    saveOwner = owner;
    saving = true;
    notify();
    return owner;
  }

  function drainQueuedRefresh() {
    if (refreshQueued && !closed && !saving && !busy) {
      refreshQueued = false;
      void refresh().catch(() => {});
    }
  }

  function releaseSaving(owner) {
    if (saveOwner !== owner) return;
    saveOwner = null;
    saving = false;
    notify();
    drainQueuedRefresh();
  }

  async function adoptExternal(record, guard = null) {
    if (closed || (guard && !isRefreshScopeCurrent(guard))) return false;
    clearTimer();
    generation++;
    cancelPending('会话已在别处切换');
    const installGeneration = generation;
    const installId = record?.id || null;
    notify();
    await install(record);
    if (closed || generation !== installGeneration || (active?.id || null) !== installId) return false;
    notify();
    return true;
  }

  async function refresh() {
    if (saving || busy) {
      refreshQueued = true;
      return { activeId: active?.id || null, sessions };
    }

    const sequence = ++refreshing;
    const scope = {
      sequence,
      generation,
      activeId: active?.id || null,
      changed,
      saved,
    };
    const list = await store.list();
    if (!isRefreshIdentityCurrent(scope)) return list;
    if (saving) {
      refreshQueued = true;
      return list;
    }

    sessions = list.sessions;
    const currentSummary = scope.activeId
      ? sessions.find(item => item.id === scope.activeId) || null
      : null;
    const currentMissing = Boolean(scope.activeId && !currentSummary);
    const activeChanged = list.activeId !== scope.activeId;
    const revisionChanged = Boolean(currentSummary && active && currentSummary.revision !== active.revision);
    const needsRemoteRead = currentMissing || activeChanged || revisionChanged;

    if (!needsRemoteRead) {
      notify();
      return list;
    }

    if (list.activeId) {
      let replacement = null;
      try {
        replacement = await store.get(list.activeId);
      } catch {}

      if (!isRefreshIdentityCurrent(scope)) return list;
      if (saving) {
        refreshQueued = true;
        return list;
      }

      if (!isRefreshScopeCurrent(scope)) {
        if (changed > saved && active?.id === scope.activeId && (currentMissing || revisionChanged || !replacement)) {
          markConflict(currentMissing || !replacement ? 'deleted' : 'modified', replacement);
        }
        notify();
        return list;
      }

      if (changed > saved) {
        if (currentMissing || !replacement) markConflict('deleted', replacement);
        else if (revisionChanged) markConflict('modified', replacement);
        else if (activeChanged) markConflict('active-changed', replacement);
      } else if (replacement) {
        await adoptExternal(replacement, scope);
      }
    } else {
      if (!isRefreshIdentityCurrent(scope)) return list;
      if (changed > saved) {
        if (currentMissing) markConflict('deleted');
        else if (activeChanged) markConflict('active-changed');
      } else if (currentMissing || activeChanged) {
        await adoptExternal(null, scope);
      }
    }

    notify();
    return list;
  }

  function scheduleSave() {
    if (!ready || busy || closed || installing) return;
    const alreadyDirty = changed > saved;
    changed++;
    // A sticky conflict records later input but never schedules an implicit
    // overwrite. The explicit retry button owns that authorization.
    if (timer === null && !conflict) timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => {});
    }, delayMs);
    if (!alreadyDirty || conflict) notify();
  }

  async function readLatest(id) {
    try {
      return await store.get(id);
    } catch (err) {
      if (err?.code === 'SESSION_NOT_FOUND') return null;
      throw err;
    }
  }

  async function handleSaveFailure(err, scope) {
    if (!isSaveScopeCurrent(scope)) return;
    if (err?.code !== 'SESSION_CONFLICT' && err?.code !== 'SESSION_NOT_FOUND') {
      error = detail(err);
      return;
    }

    let latest = null;
    try { latest = await readLatest(scope.id); } catch {}
    if (!isSaveScopeCurrent(scope)) return;
    markConflict(latest ? 'modified' : 'deleted', latest);
  }

  function commitSaved(record, scope, version) {
    if (!isSaveScopeCurrent(scope)) return false;
    active = record;
    saved = version;
    clearConflict();
    updateSessionSummary(record);
    return true;
  }

  async function runFlush({ force, allowOverwrite, allowClosed }) {
    if (!active) return;
    const conflictAtStart = conflict;
    if (conflictAtStart && !allowOverwrite) throw conflictError(conflictAtStart);
    if (conflictAtStart === 'deleted' && allowOverwrite) throw conflictError('deleted');

    const scope = {
      generation,
      id: active.id,
      changed,
      allowClosed,
    };
    const owner = claimSaving();
    error = '';
    notify();

    try {
      let snapshot;
      let expectedRevision = active.revision;

      if (conflictAtStart && allowOverwrite) {
        const latest = await readLatest(scope.id);
        if (!isSaveScopeCurrent(scope)) return;
        if (!latest) {
          markConflict('deleted');
          throw makeError('SESSION_NOT_FOUND', 'Session not found');
        }
        snapshot = normalizeForkSnapshot(capture());
        if (!isSaveScopeCurrent(scope)) return;
        expectedRevision = latest.revision;
        if (sameSnapshot(snapshot, latest.snapshot)) {
          commitSaved(latest, scope, changed);
          return;
        }
      } else {
        snapshot = normalizeForkSnapshot(capture());
        if (!isSaveScopeCurrent(scope)) return;
        if (sameSnapshot(snapshot, active.snapshot)) {
          const latest = await readLatest(scope.id);
          if (!isSaveScopeCurrent(scope) || changed !== scope.changed) return;
          if (!latest) {
            if (!closed) await adoptExternal(null);
            return;
          }
          if (latest.revision !== active.revision || !sameSnapshot(latest.snapshot, active.snapshot)) {
            if (!closed) await adoptExternal(latest);
            return;
          }
          saved = changed;
          error = '';
          return;
        }
      }

      if (changed <= saved) changed = saved + 1;
      const version = changed;
      let record;
      try {
        record = await store.save(scope.id, expectedRevision, snapshot);
      } catch (err) {
        await handleSaveFailure(err, scope);
        throw err;
      }
      commitSaved(record, scope, version);
      return record;
    } catch (err) {
      if (isSaveScopeCurrent(scope) && !conflict && !error) error = detail(err);
      throw err;
    } finally {
      releaseSaving(owner);
      if (saveOwner !== owner && !closed && changed > saved && !busy && !error && !conflict && timer === null) {
        timer = setTimeout(() => { timer = null; void flush().catch(() => {}); }, delayMs);
      }
    }
  }

  function enqueueFlush({ force = false, allowOverwrite = false, allowClosed = false }) {
    clearTimer();
    if ((!ready || busy || closed) && !force) return tail;
    const job = tail.catch(() => {}).then(() => runFlush({ force, allowOverwrite, allowClosed }));
    tail = job;
    return job;
  }

  function flush(force = false) {
    // `force` is deliberately only the lifecycle gate. It never authorizes
    // a write against a sticky conflict.
    return enqueueFlush({ force: Boolean(force), allowOverwrite: false, allowClosed: Boolean(force) });
  }

  function retrySave() {
    return enqueueFlush({ force: false, allowOverwrite: true, allowClosed: false });
  }

  async function install(record) {
    active = record || null;
    changed = saved = 0;
    clearConflict();
    const previousInstalling = installing;
    installing = true;
    try {
      await apply(record ? clone(record.snapshot) : null);
    } finally {
      installing = previousInstalling;
      changed = saved = 0;
    }
  }

  async function init() {
    if (busy || closed) return;
    busy = true; error = ''; conflict = null; notify();
    const owner = claimSaving();
    try {
      const record = await store.ensure(capture());
      if (closed) return;
      await install(record);
      ready = true;
    } catch (err) {
      error = detail(err);
    } finally {
      releaseSaving(owner);
      busy = false;
      notify();
    }
    if (ready && !closed) {
      refreshQueued = false;
      await refresh();
    } else {
      drainQueuedRefresh();
    }
  }

  async function transition(id) {
    if (!ready || busy || closed || !id || id === active?.id) return;
    busy = true; error = ''; clearTimer(); generation++;
    cancelPending('会话已切换'); changed++;
    notify();
    try {
      await flush(true);
      if (closed) return;
      const owner = claimSaving();
      try {
        const record = await store.activate(id);
        if (closed) return;
        await install(record);
      } finally { releaseSaving(owner); }
      await refresh();
    } catch (err) { error = detail(err); }
    finally { busy = false; notify(); drainQueuedRefresh(); }
  }

  async function newSession(snapshot) {
    // Creation snapshot is supplied separately to avoid reusing the old canvas.
    if (!ready || busy || closed) return;
    busy = true; error = ''; clearTimer(); generation++;
    cancelPending('会话已切换'); changed++; notify();
    try {
      await flush(true);
      if (closed) return;
      const owner = claimSaving();
      try {
        const record = await store.create(snapshot);
        if (closed) return;
        await install(record);
      } finally { releaseSaving(owner); }
      await refresh();
    } catch (err) { error = detail(err); }
    finally { busy = false; notify(); drainQueuedRefresh(); }
  }

  async function saveCopy() {
    if (!ready || busy || closed) return;
    busy = true; error = ''; clearTimer(); generation++;
    cancelPending('正在保存会话副本'); changed++; notify();
    try {
      await tail.catch(() => {});
      if (closed || !active) return;
      const scope = { generation, id: active.id, allowClosed: false };
      const owner = claimSaving();
      let record;
      try {
        record = await store.create(capture(), { title: `${active?.title || '会话'}（副本）` });
        if (!isSaveScopeCurrent(scope)) return;
        await install(record);
      } finally { releaseSaving(owner); }
      await refresh();
    } catch (err) { error = detail(err); }
    finally { busy = false; notify(); drainQueuedRefresh(); }
  }

  function resumeDirty() {
    if (!ready || closed || !active) return;
    try {
      if (!sameSnapshot(normalizeForkSnapshot(capture()), active.snapshot)) scheduleSave();
    } catch (err) { if (!error) error = detail(err); }
  }

  async function rename(id, title, expectedTitle) {
    if (!ready || busy || closed) return { ok: false, error: '会话正忙，请稍后重试。' };
    busy = true; error = ''; clearTimer(); notify();
    try {
      await flush(true);
      if (closed) return { ok: false, error: '画布已关闭。' };
      const owner = claimSaving();
      try {
        const record = await store.rename(id, title, expectedTitle);
        if (active?.id === id) active = record; // Metadata must not reset the live canvas.
        updateSessionSummary(record);
      } finally { releaseSaving(owner); }
      await refresh().catch(() => {});
      return { ok: true };
    } catch (err) {
      // Metadata errors belong to the inline editor, not the autosave breaker.
      // A failed flush already set `error`; preserve that true storage failure.
      return { ok: false, error: detail(err) };
    }
    finally { busy = false; resumeDirty(); notify(); drainQueuedRefresh(); }
  }

  async function remove(id, expectedRevision, fallbackSnapshot) {
    if (!ready || busy || closed) return { ok: false, error: '会话正忙，请稍后重试。' };
    const isCurrent = id === active?.id;
    busy = true; error = ''; clearTimer();
    if (isCurrent) { generation++; cancelPending('会话正在删除'); changed++; }
    notify();
    try {
      await tail.catch(() => {});
      if (closed) return { ok: false, error: '画布已关闭。' };
      const revision = expectedRevision;
      const owner = claimSaving();
      try {
        const result = await store.remove(id, revision, fallbackSnapshot);
        if (isCurrent && !closed) await install(result.session);
        sessions = sessions.filter(item => item.id !== id);
      } finally { releaseSaving(owner); }
      await refresh().catch(() => {});
      return { ok: true };
    } catch (err) { return { ok: false, error: detail(err) }; }
    finally { busy = false; resumeDirty(); notify(); drainQueuedRefresh(); }
  }

  function close() {
    if (closed) return tail;
    clearTimer(); closed = true; generation++;
    cancelPending('页面已关闭');
    changed++;
    // Best effort only: the last acknowledged autosave is the recovery boundary.
    return enqueueFlush({ force: true, allowOverwrite: false, allowClosed: true });
  }

  function getSavedSnapshot() {
    if (!ready || busy || closed || saving || (changed > saved) || Boolean(error) || conflict || !active) {
      const err = new Error('当前会话尚未保存或正忙');
      err.code = 'SESSION_NOT_SAVED';
      throw err;
    }
    return {
      id: active.id,
      revision: active.revision,
      snapshot: clone(active.snapshot),
    };
  }

  return {
    get state() { return state(); },
    takeNotice() { const current = notice; notice = ''; return current; },
    get generation() { return generation; },
    init,
    refresh,
    scheduleSave,
    flush,
    retrySave,
    switchTo: transition,
    newSession,
    saveCopy,
    rename,
    remove,
    close,
    getSavedSnapshot,
  };
}

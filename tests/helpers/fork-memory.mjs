export function memoryHost() {
  const values = new Map(), listeners = new Set();
  let tail = Promise.resolve();
  const control = { failWrites: false, writes: 0 };
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const global = {
    async get(key) { return clone(values.get(key) ?? null); },
    async set(key, value) {
      if (control.failWrites) throw Object.assign(new Error('disk unavailable'), { code: 'SAVE_DENIED' });
      values.set(key, clone(value)); control.writes++;
      for (const listener of listeners) queueMicrotask(() => listener([key]));
    },
    async delete(key) {
      if (control.failWrites) throw Object.assign(new Error('disk unavailable'), { code: 'SAVE_DENIED' });
      values.delete(key); control.writes++;
      for (const listener of listeners) queueMicrotask(() => listener([key]));
    },
    onChanged(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const locks = { request(_name, callback) { const next = tail.catch(() => {}).then(callback); tail = next; return next; } };
  return { storage: { global }, locks, control, values };
}
export function snapshot(text = 'question') {
  return {
    cards: [{ id: 'card-1', title: '主线', parentId: null, x: 80, y: 80, width: 340, draft: '', messages: [{ role: 'user', text }] }],
    view: { x: 60, y: 40, scale: 1 },
    agent: { id: 'agent-a', name: 'A', provider: 'p', model: 'm' },
  };
}
export const tick = () => new Promise(resolve => setImmediate(resolve));

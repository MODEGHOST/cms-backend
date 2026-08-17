/**
 * Tiny in-memory TTL cache (Node 16 safe).
 * Map insertion order is used to drop oldest entries when over maxEntries.
 */
export function createTtlCache({ ttlMs = 30_000, maxEntries = 64 } = {}) {
  const store = new Map();
  const inflight = new Map();

  function prune(now = Date.now()) {
    for (const [key, hit] of store) {
      if (hit.expires <= now) store.delete(key);
    }
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest == null) break;
      store.delete(oldest);
    }
  }

  function get(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
      store.delete(key);
      return null;
    }
    return hit.value;
  }

  function set(key, value, customTtlMs = ttlMs) {
    prune();
    store.set(key, { value, expires: Date.now() + customTtlMs });
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest == null) break;
      store.delete(oldest);
    }
    return value;
  }

  function del(key) {
    store.delete(key);
    inflight.delete(key);
  }

  async function getOrSet(key, loader, customTtlMs = ttlMs) {
    const cached = get(key);
    if (cached != null) return cached;
    const pending = inflight.get(key);
    if (pending) return pending;
    const task = Promise.resolve()
      .then(loader)
      .then((value) => set(key, value, customTtlMs))
      .finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  return { get, set, del, getOrSet, prune };
}

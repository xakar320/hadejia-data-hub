// js/studio-store.js — local storage for Creative Studio (IndexedDB, on the customer's own device).
// Projects and downloaded-file records NEVER leave the device: nothing here is uploaded.
const Studio = (function () {
  const DB = 'hdh-studio', VER = 1;
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((ok, no) => {
      if (!window.indexedDB) return no(new Error('This browser cannot save projects on the device.'));
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('downloads')) d.createObjectStore('downloads', { keyPath: 'id' });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error || new Error('Storage error'));
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((ok, no) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => ok(req && req.result);
      t.onerror = () => no(t.error); t.onabort = () => no(t.error || new Error('Storage full?'));
    });
  }
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const put = (store, obj) => tx(store, 'readwrite', s => s.put(obj));
  const get = (store, id) => tx(store, 'readonly', s => s.get(id));
  const del = (store, id) => tx(store, 'readwrite', s => s.delete(id));
  const all = async (store) => { const r = await tx(store, 'readonly', s => s.getAll()); return (r || []).sort((a, b) => b.updated - a.updated); };

  // Admin switches live in the existing admin_settings table (readable by logged-in customers).
  async function flag(key, fallback) {
    try {
      const { data } = await client.from('admin_settings').select('setting_value').eq('setting_key', key).maybeSingle();
      return Object.assign({}, fallback, (data && data.setting_value) || {});
    } catch (e) { return fallback; }
  }
  return { uid, put, get, del, all, flag };
})();

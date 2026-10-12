// IndexedDB wrapper. Three stores:
//  models: lightweight metadata (listed on every start)
//  files:  the original file blobs, kept apart so listing stays fast
//  thumbs: generated preview images
//  handles: the linked disk folder (File System Access API, Chromium desktop only)
const DB_NAME = 'model-library';
const DB_VERSION = 2;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, key] of [['models', 'id'], ['files', 'id'], ['thumbs', 'id'], ['handles', 'key']]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: key });
      }
    };
    req.onsuccess = () => {
      // let a newer version of the app in another tab upgrade the database
      req.result.onversionchange = () => { req.result.close(); dbPromise = undefined; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    const objs = stores.map((s) => tx.objectStore(s));
    Promise.resolve(fn(...objs)).then((r) => { result = r; }, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const getAllModels = () => run(['models'], 'readonly', (m) => wrap(m.getAll()));
export const getFile = (id) => run(['files'], 'readonly', (f) => wrap(f.get(id))).then((r) => r?.blob ?? null);
export const getThumb = (id) => run(['thumbs'], 'readonly', (t) => wrap(t.get(id))).then((r) => r?.blob ?? null);
export const getHandle = (key) => run(['handles'], 'readonly', (h) => wrap(h.get(key))).then((r) => r?.handle ?? null);
export const putHandle = (key, handle) => run(['handles'], 'readwrite', (h) => { h.put({ key, handle }); });
export const deleteHandle = (key) => run(['handles'], 'readwrite', (h) => { h.delete(key); });
export const getAllThumbs = () => run(['thumbs'], 'readonly', (t) => wrap(t.getAll()));

export const addModel = (meta, blob) =>
  run(['models', 'files'], 'readwrite', (m, f) => { m.put(meta); f.put({ id: meta.id, blob }); });

export const updateModel = (meta) => run(['models'], 'readwrite', (m) => { m.put(meta); });
export const putThumb = (id, blob) => run(['thumbs'], 'readwrite', (t) => { t.put({ id, blob }); });

export const deleteModel = (id) =>
  run(['models', 'files', 'thumbs'], 'readwrite', (m, f, t) => { m.delete(id); f.delete(id); t.delete(id); });

export async function storageInfo() {
  const out = { used: 0, quota: 0, persisted: false };
  try {
    const est = await navigator.storage?.estimate?.();
    out.used = est?.usage ?? 0;
    out.quota = est?.quota ?? 0;
    out.persisted = (await navigator.storage?.persisted?.()) ?? false;
  } catch {}
  return out;
}

export async function requestPersist() {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

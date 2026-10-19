/**
 * IndexedDB persistence. Two object stores:
 *  - "sessions": full records (including sensor samples)
 *  - "meta":     lightweight records (no samples/swings) so the history list loads fast
 * Both are written in a single transaction so they stay consistent.
 */
const DB_NAME = 'sports-performance-monitor';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser (private mode?). Sessions cannot be saved.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open browser database'));
    req.onblocked = () => reject(new Error('Database is blocked by another tab; close other tabs and retry'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

const toMeta = (rec) => {
  const { samples, swings, ...rest } = rec;
  return { ...rest, storedSamples: samples.length };
};

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error || new Error('Storage transaction failed'));
  tx.onabort = () => rej(tx.error || new Error('Storage transaction aborted (quota exceeded?)'));
});

export async function saveSession(record) {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'meta'], 'readwrite');
  tx.objectStore('sessions').put(record);
  tx.objectStore('meta').put(toMeta(record));
  await txDone(tx);
  return record.id;
}

export async function listSessions() {
  const db = await openDb();
  const all = await reqP(db.transaction('meta').objectStore('meta').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getSession(id) {
  const db = await openDb();
  return (await reqP(db.transaction('sessions').objectStore('sessions').get(id))) || null;
}

export async function deleteSession(id) {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'meta'], 'readwrite');
  tx.objectStore('sessions').delete(id);
  tx.objectStore('meta').delete(id);
  await txDone(tx);
}

/** Import validated records. Existing IDs are skipped (never overwritten). */
export async function importRecords(records) {
  const db = await openDb();
  const existing = new Set(await reqP(db.transaction('meta').objectStore('meta').getAllKeys()));
  const tx = db.transaction(['sessions', 'meta'], 'readwrite');
  let added = 0;
  let skipped = 0;
  const seen = new Set();
  for (const rec of records) {
    if (existing.has(rec.id) || seen.has(rec.id)) { skipped++; continue; }
    seen.add(rec.id);
    tx.objectStore('sessions').put(rec);
    tx.objectStore('meta').put(toMeta(rec));
    added++;
  }
  await txDone(tx);
  return { added, skipped };
}

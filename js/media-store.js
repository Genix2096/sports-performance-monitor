/**
 * In-memory store for recorded session videos.
 *
 * Lifecycle (deliberate privacy choice): videos are kept ONLY in this browser tab's memory as Blobs with
 * object URLs. They are NOT written to IndexedDB, localStorage, the server or the cloud. They disappear when
 * the tab is refreshed/closed, when the user discards them, when the session is deleted, or when more than
 * `maxItems` recordings exist (oldest released first). Download a video to keep it; it can be re-attached
 * to the session later with "Load video file" (also local-only).
 */
export class MediaStore {
  constructor({ urlApi = globalThis.URL, maxItems = 3, onEvict = () => {} } = {}) {
    this.urlApi = urlApi;
    this.maxItems = maxItems;
    this.onEvict = onEvict;
    this.items = new Map(); // sessionId -> entry (insertion order = age)
  }

  _makeUrl(blob) {
    try { return this.urlApi && this.urlApi.createObjectURL ? this.urlApi.createObjectURL(blob) : ''; } catch { return ''; }
  }

  _revoke(entry) {
    if (entry && entry.url) {
      try { this.urlApi.revokeObjectURL(entry.url); } catch { /* ignore */ }
      entry.url = '';
    }
  }

  /** Store a freshly recorded blob. Replaces (and revokes) an existing entry for the same session. */
  put(sessionId, blob, info = {}, { fromFile = false, fileName = '' } = {}) {
    if (!sessionId || !blob) return null;
    if (this.items.has(sessionId)) this.discard(sessionId);
    const entry = {
      sessionId,
      blob,
      url: this._makeUrl(blob),
      info: { ...info },
      sizeBytes: blob.size || 0,
      downloaded: !!fromFile, // a file loaded from disk already exists on disk
      fromFile: !!fromFile,
      fileName,
      createdAt: Date.now(),
    };
    this.items.set(sessionId, entry);
    while (this.items.size > this.maxItems) {
      const oldestId = this.items.keys().next().value;
      const old = this.items.get(oldestId);
      this.discard(oldestId);
      try { this.onEvict(old); } catch { /* ignore */ }
    }
    return entry;
  }

  get(sessionId) { return this.items.get(sessionId) || null; }

  has(sessionId) { return this.items.has(sessionId); }

  markDownloaded(sessionId) {
    const e = this.items.get(sessionId);
    if (e) e.downloaded = true;
  }

  discard(sessionId) {
    const e = this.items.get(sessionId);
    if (!e) return false;
    this._revoke(e);
    e.blob = null;
    this.items.delete(sessionId);
    return true;
  }

  discardAll() {
    for (const id of [...this.items.keys()]) this.discard(id);
  }

  undownloadedCount() {
    let n = 0;
    for (const e of this.items.values()) if (!e.downloaded) n++;
    return n;
  }

  totalBytes() {
    let n = 0;
    for (const e of this.items.values()) n += e.sizeBytes;
    return n;
  }
}

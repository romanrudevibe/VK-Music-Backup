let opening;
export function database() {
  return opening ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('vk-music-backup', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta');
      db.createObjectStore('tracks', {keyPath: 'key'});
      const chunks = db.createObjectStore('chunks', {keyPath: 'key'});
      chunks.createIndex('track', 'track');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function transaction(names, mode, body) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let result;
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Ошибка локальной базы'));
    try { result = body(tx); } catch (e) { tx.abort(); reject(e); }
  });
}
export const getMeta = () => transaction(['meta'], 'readonly', tx => tx.objectStore('meta').get('state'));
export const putMeta = state => transaction(['meta'], 'readwrite', tx => tx.objectStore('meta').put(state, 'state'));
export const allTracks = () => transaction(['tracks'], 'readonly', tx => tx.objectStore('tracks').getAll());
export const putTrack = track => transaction(['tracks'], 'readwrite', tx => tx.objectStore('tracks').put(track));
export const getChunk = key => transaction(['chunks'], 'readonly', tx => tx.objectStore('chunks').get(key));
export const putChunk = chunk => transaction(['chunks'], 'readwrite', tx => tx.objectStore('chunks').put(chunk));
export function deleteChunks(track) {
  return transaction(['chunks'], 'readwrite', tx => {
    const store = tx.objectStore('chunks');
    const cursor = store.index('track').openCursor(IDBKeyRange.only(track));
    cursor.onsuccess = () => { const c = cursor.result; if (c) { c.delete(); c.continue(); } };
  });
}
// The page and its cursor commit atomically: a crash cannot skip a page.
export function savePage(tracks, state) {
  return transaction(['tracks', 'meta'], 'readwrite', tx => {
    for (const track of tracks) tx.objectStore('tracks').put(track);
    tx.objectStore('meta').put(state, 'state');
  });
}

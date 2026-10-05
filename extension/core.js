export class BackupError extends Error {
  constructor(code, message, fatal = false) { super(message); this.code = code; this.fatal = fatal; }
}
export function safeName(value, limit = 70) {
  return Array.from(String(value).normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^[. ]+|[. ]+$/g, '').trim()).slice(0, limit).join('') || 'Без названия';
}
export function trackListText(tracks) {
  const oneLine=value=>String(value??'').replace(/[\s\u0000-\u001f\u007f]+/gu,' ').trim();
  return [...tracks].sort((a,b)=>a.index-b.index).map(track=>`${oneLine(track.artist)} - ${oneLine(track.title)}`).join('\n')+(tracks.length?'\n':'');
}
export function filename(track, extension) {
  // Limit UTF-8 bytes as well as characters (macOS filename limit is 255 bytes).
  const encoder = new TextEncoder();
  let label = `${safeName(track.artist)} — ${safeName(track.title)}`;
  const suffix = ` [${track.key}].${extension}`;
  while (encoder.encode(label + suffix).length > 240) label = Array.from(label).slice(0, -1).join('');
  return `VK Audio/${track.account}/${label}${suffix}`;
}
export function mediaURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new BackupError('URL', 'VK не вернул адрес аудио.'); }
  const roots = ['vkuseraudio.net', 'vkuseraudio.com', 'vkuseraudio.ru', 'useraudio.net', 'useraudio.com', 'vkuservideo.net', 'vk-cdn.net'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !roots.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) {
    throw new BackupError('CDN', `Неподдерживаемый адрес аудиосервера: ${url.hostname}. Нужна настройка расширения.`, true);
  }
  return url.href;
}
export const delay = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, {once: true});
});
export function parseVKResponse(text) {
  let result;
  try { result = JSON.parse(text.replace(/^\s*<!--/, '')); } catch {
    throw new BackupError('AUTH', 'VK вернул страницу вместо списка. Открой m.vk.ru/audio в Chrome и проверь вход в аккаунт.', true);
  }
  if (!result || typeof result !== 'object') throw new BackupError('FORMAT', 'VK вернул неожиданный тип ответа. Скачай отчёт об ошибках.', true);
  if (result.error || result.errors || (result.payload?.[0] !== undefined && ![0,'0',null,false].includes(result.payload[0]))) {
    throw new BackupError('VK', 'VK отклонил запрос. Проверь вход и возможную проверку на странице VK, затем продолжи.', true);
  }
  return result;
}
export function parsePage(result) {
  // Only explicit response envelopes, never search albums/recommendations recursively.
  const candidates=[result.data?.[0],result.data,result.payload?.[1]?.[0],result.payload?.[1]?.[1],result];
  const pages=candidates.map(value=>{
    if(typeof value==='string' && value.trim().startsWith('{')) { try{return JSON.parse(value);}catch{} }
    return value;
  }).filter(value=>value && !Array.isArray(value) && Array.isArray(value.list));
  if(pages.length!==1) throw new BackupError('FORMAT', 'Не найден однозначный список аудиозаписей в ответе VK. Нажми «Скачать отчёт об ошибках» и пришли полученный файл.', true);
  const page=pages[0],flag=page.hasMore ?? page.has_more;
  if (![true, false, 0, 1, '0', '1'].includes(flag)) {
    throw new BackupError('FORMAT', 'VK не указал, есть ли продолжение списка. Нажми «Скачать отчёт об ошибках» и пришли полученный файл.', true);
  }
  const parsed={rows:page.list,more:flag===true || flag===1 || flag==='1'};
  const next=page.nextOffset ?? page.next_offset;
  if(next!==undefined && next!==null && next!=='') {
    if(!/^\d+$/.test(String(next)) || !Number.isSafeInteger(Number(next))) throw new BackupError('FORMAT','VK вернул некорректную позицию продолжения списка.',true);
    parsed.nextOffset=Number(next);
  }
  return parsed;
}
export function responseShape(value, depth=0) {
  // Keep structure only. Even unknown object keys can contain private values.
  if(value===null)return {type:'null'};
  if(typeof value==='string')return {type:'string',length:value.length};
  if(typeof value!=='object')return {type:typeof value};
  if(Array.isArray(value))return {type:'array',length:value.length,...(depth<5?{items:value.slice(0,2).map(v=>responseShape(v,depth+1))}:{})};
  const known=new Set(['data','payload','list','hasMore','has_more','nextOffset','next_offset','error','errors','code','message','type','response','status','html','playlist','playlists','count','totalCount','owner_id','id','auth','redirect','url']);
  const keys=Object.keys(value),fields={};
  if(depth<5)for(const key of keys.filter(k=>known.has(k)).slice(0,16))fields[key]=responseShape(value[key],depth+1);
  return {type:'object',fieldCount:keys.length,fields};
}
export function trackFromRow(row, account, index) {
  if (!Array.isArray(row) || !/^\d+$/.test(String(row[0])) || !/^-?\d+$/.test(String(row[1]))) {
    throw new BackupError('FORMAT', 'VK изменил формат аудиозаписи.', true);
  }
  const hashes = typeof row[13] === 'string' ? row[13].split('/') : [];
  const reload = hashes[2] && hashes[5] ? [row[1], row[0], hashes[2], hashes[5]].join('_') : null;
  return {key: `${row[1]}_${row[0]}`, account, index, artist: String(row[4] || 'Неизвестный исполнитель'), title: String(row[3] || 'Без названия'), duration: Number(row[5]) || 0, reload, status: 'pending', attempts: 0};
}
export function mergePage(existing, rows, account, offset) {
  const map = new Map(existing.map(t => [t.key, t]));
  let added = 0;
  const records = rows.map((row, index) => {
    const fresh = {...trackFromRow(row, account, offset + index),sourceOffset:offset}, old = map.get(fresh.key);
    if (!old) { added++; map.set(fresh.key, fresh); return fresh; }
    return {...old, artist: fresh.artist, title: fresh.title, reload: fresh.reload, duration: fresh.duration,sourceOffset:offset};
  });
  return {records, added};
}
export function isMP3(bytes) {
  return bytes.length >= 3 && ((bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0));
}
export function mp3Candidate(value) {
  const url = new URL(value);
  const original = url.pathname;
  url.pathname = original.replace(/\/[0-9a-f]+(\/audios)?\/([0-9a-f]+)\/index\.m3u8$/i, '$1/$2.mp3');
  return url.pathname !== original ? url.href : null;
}
export function errorInfo(e) {
  // Never persist request URLs, cookies, or raw VK responses in diagnostics.
  if (e instanceof BackupError) return {code: e.code, message: e.message, fatal: e.fatal,...(e.diagnostics?{diagnostics:e.diagnostics}:{})};
  if (e?.name === 'QuotaExceededError') return {code: 'DISK', message: 'Не хватает места для временных частей аудио.', fatal: true};
  return {code: 'NETWORK', message: 'Не удалось загрузить данные. Проверь интернет и попробуй продолжить.', fatal: false};
}

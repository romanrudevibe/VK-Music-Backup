import {BackupError, mediaURL} from './core.js';
import {getChunk, putChunk, deleteChunks} from './db.js';
import {extractMP3,segmentKind} from './mpeg-audio.js';
export function attributes(text) {
  const result = {};
  for (const match of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[match[1]] = match[2].replace(/^"|"$/g, '');
  return result;
}
export function parsePlaylist(text, url) {
  const lines = text.trim().split(/\r?\n/).map(s => s.trim());
  if (lines[0] !== '#EXTM3U') throw new BackupError('HLS', 'Аудиосервер не вернул HLS-плейлист.');
  const variants = [], renditions = [], segments = [];
  let key = null, map = null, duration = null, sequence = 0, range = null, previousEnd = 0, previousURL = '', stream;
  let ended = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-MEDIA:')) { const a = attributes(line); if (a.TYPE === 'AUDIO' && a.URI) renditions.push(a); }
    else if (line.startsWith('#EXT-X-STREAM-INF:')) stream = attributes(line);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line);
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128' && (!a.KEYFORMAT || a.KEYFORMAT === 'identity') && a.URI) key = {url:mediaURL(a.URI,url), iv:a.IV};
      else throw new BackupError('HLS_ENCRYPTION', 'Этот способ защиты потока не поддерживается.');
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line);
      if (a.BYTERANGE || key) throw new BackupError('HLS_MAP', 'Этот формат начального сегмента HLS пока не поддерживается.');
      map = mediaURL(a.URI,url);
    } else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.split(':')[1];
    else if (line === '#EXT-X-ENDLIST') ended = true;
    else if (line === '#EXT-X-DISCONTINUITY' || line.startsWith('#EXT-X-GAP')) throw new BackupError('HLS_GAP', 'Поток содержит разрыв или пропущенный фрагмент. Автоматическая сборка остановлена.');
    else if (line && !line.startsWith('#')) {
      const segmentURL = mediaURL(line,url);
      if (stream) { variants.push({...stream,url:segmentURL}); stream = null; continue; }
      if (!Number.isFinite(duration) || duration <= 0) throw new BackupError('HLS_FORMAT', 'Некорректная длительность сегмента.');
      let byteRange;
      if (range) {
        const [lengthString, offsetString] = range.split('@');
        const length = Number(lengthString);
        if (offsetString === undefined && previousURL !== segmentURL) throw new BackupError('HLS_RANGE', 'Не указан начальный байт HLS-сегмента.');
        const start = offsetString === undefined ? previousEnd : Number(offsetString);
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0) throw new BackupError('HLS_RANGE', 'Некорректный диапазон HLS-сегмента.');
        byteRange = {start, end:start+length-1}; previousEnd = start + length;
      }
      segments.push({url:segmentURL,duration,sequence:sequence+segments.length,key: key && {...key}, map, byteRange});
      previousURL = segmentURL; duration = null; range = null;
    }
  }
  if (variants.length) {
    const selected = variants.sort((a,b) => Number(b.BANDWIDTH||0)-Number(a.BANDWIDTH||0))[0];
    const audio = renditions.filter(a => a['GROUP-ID'] === selected.AUDIO).sort((a,b) => Number(b.DEFAULT==='YES')-Number(a.DEFAULT==='YES'))[0];
    return {next: audio ? mediaURL(audio.URI,url) : selected.url};
  }
  if (!ended || !segments.length) throw new BackupError('HLS_LIVE', 'Ожидалась полная запись, но сервер вернул пустой или незавершённый поток.');
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new BackupError('HLS_SEQUENCE', 'Некорректная нумерация сегментов.');
  if (new Set(segments.map(s=>s.map)).size > 1) throw new BackupError('HLS_MAP', 'Поток меняет формат во время записи.');
  return {segments};
}
export function sequenceIV(sequence, explicit) {
  if (explicit) {
    if (!/^0x[\da-f]{1,32}$/i.test(explicit)) throw new BackupError('HLS_IV', 'Некорректный параметр шифрования потока.');
    return Uint8Array.from(explicit.slice(2).padStart(32,'0').match(/../g), h=>parseInt(h,16));
  }
  const result = new Uint8Array(16);
  let n = BigInt(sequence);
  for (let i=15;i>=0;i--) { result[i]=Number(n&255n); n>>=8n; }
  return result;
}
export async function fetchMedia(url, signal, byteRange) {
  const headers = byteRange ? {Range:`bytes=${byteRange.start}-${byteRange.end}`} : {};
  const response = await fetch(mediaURL(url), {headers, credentials:'omit',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
  if (!response.ok) throw new BackupError(`HTTP_${response.status}`, `Аудиосервер ответил ошибкой ${response.status}. Ссылка будет обновлена при повторе.`);
  mediaURL(response.url || url);
  if (byteRange) {
    const contentRange = response.headers.get('Content-Range');
    if (response.status !== 206 || !contentRange?.startsWith(`bytes ${byteRange.start}-${byteRange.end}/`)) throw new BackupError('RANGE', 'Аудиосервер не подтвердил нужный диапазон байтов.');
  }
  return response;
}
export async function playlistFromURL(url, signal) {
  for (let level = 0; level < 5; level++) {
    const response = await fetchMedia(url,signal);
    const parsed = parsePlaylist(await response.text(),response.url || url);
    if (parsed.segments) return parsed;
    url = parsed.next;
  }
  throw new BackupError('HLS_DEPTH', 'Слишком много вложенных HLS-плейлистов.');
}
export async function fingerprint(segments) {
  // Query strings expire. Path, byte ranges, sequence and durations identify the data.
  const data = segments.map(s=>[new URL(s.url).pathname,s.duration,s.sequence,s.byteRange,s.map && new URL(s.map).pathname,s.key && new URL(s.key.url).pathname,s.key?.iv]);
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data)));
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function transmuxSegments(buffers, muxjs) {
  const converter = new muxjs.mp4.Transmuxer({keepOriginalTimestamps:false,remux:false});
  const output = [];
  let audioFragments = 0, videoFragments = 0;
  converter.on('data', segment => {
    // remux:false emits audio and video separately. An extra video track must
    // not invalidate a successfully extracted audio track.
    if (segment.type !== 'audio') { videoFragments++; return; }
    if (!audioFragments++) output.push(segment.initSegment);
    output.push(segment.data);
  });
  try { for (const buffer of buffers) { converter.push(new Uint8Array(buffer)); converter.flush(); } }
  finally { converter.dispose(); }
  if (!audioFragments) {
    const error=new BackupError('AUDIO_FORMAT', 'В MPEG-TS не удалось извлечь поддерживаемую аудиодорожку.');
    error.diagnostics={audioFragments,videoFragments};throw error;
  }
  return output;
}
export function mp4BoxTypes(buffer) {
  const bytes=new Uint8Array(buffer),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),types=[];
  let offset=0;
  while(offset<bytes.byteLength) {
    if(offset+8>bytes.byteLength) throw new BackupError('MP4','Оборванный MP4-сегмент.');
    let size=view.getUint32(offset),header=8;
    if(size===1) {
      if(offset+16>bytes.byteLength) throw new BackupError('MP4','Оборванный MP4-заголовок.');
      const big=view.getBigUint64(offset+8);if(big>BigInt(Number.MAX_SAFE_INTEGER)) throw new BackupError('MP4','Слишком большой MP4-блок.');
      size=Number(big);header=16;
    }
    if(size===0)size=bytes.byteLength-offset;
    if(size<header||offset+size>bytes.byteLength)throw new BackupError('MP4','Неполный MP4-сегмент.');
    types.push(new TextDecoder().decode(bytes.subarray(offset+4,offset+8)));offset+=size;
  }
  return types;
}
export async function collectHLS(track, url, signal, progress) {
  const {segments} = await playlistFromURL(url,signal);
  const stamp = await fingerprint(segments);
  const marker = await getChunk(`${track.key}:meta`);
  if (marker?.stamp !== stamp) {
    await deleteChunks(track.key);
    await putChunk({key:`${track.key}:meta`,track:track.key,stamp});
  }
  const keys = new Map(), buffers = new Array(segments.length);
  const controller=new AbortController();
  const downloadSignal=AbortSignal.any([signal,controller.signal]);
  let next=0,completed=0,firstError;
  function getKey(url) {
    // Share the pending request, not just the finished key, across workers.
    if(!keys.has(url))keys.set(url,(async()=>{
      const raw=await (await fetchMedia(url,downloadSignal)).arrayBuffer();
      if(raw.byteLength!==16)throw new BackupError('HLS_KEY','Сервер вернул некорректный ключ потока.');
      return crypto.subtle.importKey('raw',raw,'AES-CBC',false,['decrypt']);
    })());
    return keys.get(url);
  }
  async function worker() {
    try {
      while(next<segments.length) {
        downloadSignal.throwIfAborted();
        const i=next++,segment=segments[i],id=`${track.key}:${i}`;
        let bytes=(await getChunk(id))?.bytes;
        if(!bytes) {
          bytes=await (await fetchMedia(segment.url,downloadSignal,segment.byteRange)).arrayBuffer();
          if(segment.byteRange&&bytes.byteLength!==segment.byteRange.end-segment.byteRange.start+1)throw new BackupError('LENGTH','Неполный сегмент аудио.');
          if(segment.key) {
            const key=await getKey(segment.key.url);
            try {bytes=await crypto.subtle.decrypt({name:'AES-CBC',iv:sequenceIV(segment.sequence,segment.key.iv)},key,bytes);}
            catch {throw new BackupError('HLS_DECRYPT','Не удалось прочитать сегмент потока.');}
          }
          if(!bytes.byteLength)throw new BackupError('EMPTY','Получен пустой сегмент аудио.');
          // Keep completed segments for resume even when another worker fails.
          await putChunk({key:id,track:track.key,bytes});
        }
        downloadSignal.throwIfAborted();
        buffers[i]=bytes;
        await progress({phase:'segments',done:++completed,total:segments.length});
      }
    }catch(error){
      if(!firstError){firstError=error;controller.abort(error);}
      throw error;
    }
  }
  // Drain all workers before returning: no requests or cache writes outlive this run.
  await Promise.allSettled(Array.from({length:Math.min(4,segments.length)},()=>worker()));
  signal.throwIfAborted();
  if(firstError)throw firstError;
  signal.throwIfAborted();
  let parts;
  if (segments[0].map) {
    const init = await (await fetchMedia(segments[0].map,signal)).arrayBuffer();
    // Check the initialization segment really contains an MP4 file header.
    if (!mp4BoxTypes(init).includes('ftyp') || !mp4BoxTypes(init).includes('moov')) throw new BackupError('MP4','Некорректный заголовок M4A.');
    const tracks=globalThis.muxjs.mp4.probe.tracks(new Uint8Array(init));
    if(!tracks.length || tracks.some(t=>t.type!=='audio'))throw new BackupError('MP4','Поток не является аудиозаписью.');
    for(const buffer of buffers) { const types=mp4BoxTypes(buffer); if(!types.includes('moof')||!types.includes('mdat'))throw new BackupError('MP4','Неполный аудиосегмент M4A.'); }
    parts = [init,...buffers];
  } else {
    try {
      const mp3=extractMP3(buffers);
      if(mp3)return new Blob([mp3],{type:'audio/mpeg'});
      parts=transmuxSegments(buffers,globalThis.muxjs);
    }catch(e){
      if(!(e instanceof BackupError))e=new BackupError('AUDIO_FORMAT','Не удалось собрать аудио. Скачай отчёт об ошибках.');
      e.diagnostics={...e.diagnostics,segments:buffers.length,samples:buffers.slice(0,3).map(b=>{let format='unknown';try{format=segmentKind(b);}catch{}return {format,bytes:b.byteLength};})};
      throw e;
    }
  }
  return new Blob(parts,{type:'audio/mp4'});
}

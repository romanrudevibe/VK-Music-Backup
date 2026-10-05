import {allTracks,getMeta,putMeta,putTrack,savePage,deleteChunks,getChunk} from './db.js';
import {diagnosticSample} from './sample.js';
import {BackupError,delay,errorInfo,filename,isMP3,mergePage,mp3Candidate,mediaURL,trackListText} from './core.js';
import {loadPage,resolveTrack} from './vk.js';
import {collectHLS} from './hls.js';

let state, loop, controller, current;
const ready = getMeta().then(saved=>{state=saved || {account:null,domain:'vk.ru',offset:0,scanned:false,running:false,mode:'scan',limit:null,runDone:0,error:null};});
async function rpc(op,args={}) {
  const response=await chrome.runtime.sendMessage({target:'background',op,...args});
  if(!response?.ok) throw new BackupError('CHROME',response?.error || 'Chrome не ответил на запрос загрузки.',true);
  return response.value;
}
const persist = () => putMeta(state);
async function writeTrack(track) { await putTrack(track); }
function textOnly(value) { const doc=new DOMParser().parseFromString(value,'text/html'); return doc.body.textContent || ''; }

async function scan(signal) {
  let failures=0;
  while(!state.scanned && state.running) {
    signal.throwIfAborted();
    try {
      const page=await loadPage(state,signal);
      const existing=await allTracks();
      const merged=mergePage(existing,page.rows,state.account,state.offset);
      const pageID=page.rows.map(a=>`${a[1]}_${a[0]}`).join(',');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pageID));
      const stamp=Array.from(new Uint8Array(digest)).join('-');
      if((page.more && !page.rows.length) || (page.rows.length && state.seenPages?.includes(stamp))) throw new BackupError('PAGINATION','VK повторяет одну и ту же страницу. Сбор остановлен; список ещё неполный.',true);
      (state.seenPages ||= []).push(stamp);
      for(const t of merged.records) { t.artist=textOnly(t.artist); t.title=textOnly(t.title); }
      state.offset=page.nextOffset ?? state.offset+page.rows.length;
      state.scanned=!page.more;
      state.error=null;
      await savePage(merged.records,state);
      failures=0;
      if(page.more) await delay(2200,signal);
    } catch(e) {
      signal.throwIfAborted();
      if(e.fatal || ++failures>=3) throw e;
      state.error={...errorInfo(e),message:'Повтор загрузки списка через несколько секунд…'}; await persist();
      await delay(5000*failures,signal);
    }
  }
}
async function probeMP3(url,signal) {
  try {
    const response=await fetch(mediaURL(url),{headers:{Range:'bytes=0-4095'},credentials:'omit',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    mediaURL(response.url||url);
    if(!response.ok) { await response.body?.cancel(); return false; }
    const reader=response.body.getReader();
    const bytes=[];
    try {
      while(bytes.length<3) { const chunk=await reader.read(); if(chunk.done) break; bytes.push(...chunk.value.subarray(0,3-bytes.length)); }
    } finally { await reader.cancel(); }
    return isMP3(new Uint8Array(bytes));
  } catch(e) { signal.throwIfAborted(); if(e.fatal) throw e; return false; }
}
export async function recoverDownload(track, rpcCall=rpc) {
  if(track.downloadId!==undefined) return (await rpcCall('search',{id:track.downloadId}))[0] || null;
  if(!track.saveIntent) return null;
  const matches=await rpcCall('recover',{since:track.saveIntent.since,filename:track.saveIntent.filename});
  const item=matches.sort((a,b)=>b.id-a.id)[0];
  if(item) { track.downloadId=item.id; }
  return item || null;
}
async function waitDownload(track,signal) {
  while(true) {
    signal.throwIfAborted();
    const item=(await rpc('search',{id:track.downloadId}))[0];
    if(!item) { delete track.downloadId; delete track.saveIntent; throw new BackupError('MISSING','Запись о загрузке удалена из Chrome. Файл будет загружен заново при повторе.'); }
    track.progress={phase:'bytes',done:item.bytesReceived,total:item.totalBytes};
    if(item.state==='complete') {
      if(item.exists===false) { delete track.downloadId; delete track.saveIntent; throw new BackupError('MISSING','Готовый файл удалён. При повторе он будет скачан заново.'); }
      if((item.mime && /text|html|json|mpegurl/i.test(item.mime)) || item.fileSize===0) {
        delete track.downloadId; delete track.saveIntent;
        throw new BackupError('NOT_AUDIO','Сервер сохранил не аудиофайл. Проверь файл в папке загрузок.');
      }
      track.status='done'; track.error=null; track.finishedAt=Date.now();
      await writeTrack(track); await deleteChunks(track.key); return;
    }
    if(item.state==='interrupted') {
      const reason=item.error || 'INTERRUPTED';
      if(reason==='USER_CANCELED') { delete track.downloadId; delete track.saveIntent; throw new BackupError('CANCELED','Загрузка отменена в Chrome. Можно повторить вручную.'); }
      if(reason.startsWith('FILE_') || /BLOCKED|VIRUS|SECURITY/.test(reason)) throw new BackupError(reason,'Chrome остановил запись файла. Проверь место на диске и страницу загрузок Chrome.',true);
      if(!item.canResume || track.resumes>=2) { delete track.downloadId; delete track.saveIntent; }
      throw new BackupError(reason,'Скачивание прервано. Будет выполнена докачка или обновление ссылки.');
    }
    if(item.paused) {
      // A pause made in chrome://downloads is a real user pause, too.
      state.running=false; await persist();
      throw new DOMException('Пауза','AbortError');
    }
    await delay(1500,signal);
  }
}
async function downloadTrack(track,signal) {
  let blobURL;
  try {
    const prior=await recoverDownload(track);
    if(prior) {
      await writeTrack(track);
      if(prior.state==='complete') return await waitDownload(track,signal);
      if(prior.canResume && (prior.state==='in_progress' || (track.resumes||0)<2)) {
        if(prior.state==='interrupted') track.resumes=(track.resumes||0)+1;
        await writeTrack(track);
        let resumed=false;
        try { await rpc('resume',{id:prior.id}); resumed=true; }
        catch(e) { signal.throwIfAborted(); if(e.code!=='CHROME') throw e; }
        if(resumed) return await waitDownload(track,signal);
      } else if(prior.state==='in_progress' && !prior.paused) return await waitDownload(track,signal);
      if(prior.error==='USER_CANCELED') throw new BackupError('CANCELED','Загрузка отменена в Chrome. Можно повторить вручную.');
      delete track.downloadId; delete track.saveIntent; await writeTrack(track);
    }
    signal.throwIfAborted();
    track.progress={phase:'link',done:0,total:0};
    const url=await resolveTrack(state,track,signal);
    let saveURL=url, extension='mp3', kind='direct';
    if(new URL(url).pathname.includes('.m3u8')) {
      const candidate=mp3Candidate(url);
      if(candidate && await probeMP3(candidate,signal)) saveURL=candidate;
      else {
        const blob=await collectHLS(track,url,signal,async progress=>{track.progress=progress;});
        signal.throwIfAborted();
        blobURL=URL.createObjectURL(blob); saveURL=blobURL; extension=blob.type==='audio/mpeg'?'mp3':'m4a'; kind='blob';
      }
    } else if(!await probeMP3(url,signal)) throw new BackupError('NOT_MP3','Сервер не вернул MP3 или HLS. Этот формат требует дополнительной поддержки.');
    signal.throwIfAborted();
    // Persist intent before asking Chrome to save: recover the download across a crash in between.
    track.saveIntent={filename:filename(track,extension),since:new Date(Date.now()-2000).toISOString(),kind};
    delete track.downloadId;
    await writeTrack(track);
    track.downloadId=await rpc('create',{url:saveURL,filename:track.saveIntent.filename});
    track.resumes=0;
    await writeTrack(track);
    await waitDownload(track,signal);
  } finally { if(blobURL) URL.revokeObjectURL(blobURL); }
}
async function run() {
  controller=new AbortController();
  const {signal}=controller;
  let consecutiveVKFailures=0;
  try {
    await scan(signal);
    if(state.mode==='scan') { state.running=false; return; }
    while(state.running) {
      signal.throwIfAborted();
      const tracks=(await allTracks()).sort((a,b)=>a.index-b.index);
      const eligible=tracks.filter(t=>state.limit===null || (state.runKeys||[]).includes(t.key) || (state.runKeys||[]).length<state.limit);
      const track=eligible.find(t=>t.status==='active') || eligible.find(t=>t.status==='pending');
      if(!track) break;
      if(state.limit!==null && !(state.runKeys||[]).includes(track.key)) { (state.runKeys ||= []).push(track.key); await persist(); }
      current=track; track.status='active'; await writeTrack(track);
      try {
        await downloadTrack(track,signal);
        consecutiveVKFailures=0;
        state.runDone++; state.error=null; await persist();
      } catch(e) {
        if(signal.aborted || e?.name==='AbortError') {
          track.status='pending';
          if(track.downloadId!==undefined) { try{await rpc('pause',{id:track.downloadId});}catch{} }
          await writeTrack(track); throw e;
        }
        const error=errorInfo(e);
        track.attempts=(track.attempts||0)+1; track.error=error;
        const permanent=['VK_TRACK','UNAVAILABLE','CANCELED','NOT_AUDIO','NOT_MP3','DECODE','HLS_ENCRYPTION','HLS_MAP','HLS_GAP','AUDIO_FORMAT'].includes(error.code);
        track.status=error.fatal ? 'pending' : (permanent || track.attempts>=3 ? 'error' : 'pending');
        await writeTrack(track);
        if(error.fatal) throw e;
        consecutiveVKFailures=error.code==='VK_TRACK'?consecutiveVKFailures+1:0;
        if(consecutiveVKFailures>=3) {
          const stop=new BackupError('VK_REPEAT','VK отказал для трёх треков подряд. Очередь остановлена; проверь сообщения треков и сохрани отчёт об ошибках.',true);
          stop.diagnostics=error.diagnostics;throw stop;
        }
        if(track.status==='pending') await delay(5000*track.attempts,signal);
      } finally { current=null; }
      await delay(1800,signal);
    }
    state.running=false;
  } catch(e) {
    state.running=false;
    if(!signal.aborted && e?.name!=='AbortError') state.error=errorInfo(e);
  } finally {
    current=null; controller=null; await persist();
  }
}
function launch() {
  if(!loop && state.running) loop=run().finally(()=>{loop=null;});
}
async function snapshot(message) {
  const tracks=(await allTracks()).sort((a,b)=>a.index-b.index);
  const counts={total:tracks.length,done:0,pending:0,active:0,error:0};
  for(const t of tracks) counts[t.status]++;
  let visible=tracks;
  if(message.filter==='error') visible=tracks.filter(t=>t.status==='error');
  const query=String(message.query||'').toLowerCase();
  if(query) visible=visible.filter(t=>`${t.artist} ${t.title}`.toLowerCase().includes(query));
  const page=Math.max(0,Number(message.page)||0);
  return {state,counts,stopping:!!loop&&!state.running,current:current && {artist:current.artist,title:current.title,progress:current.progress},totalVisible:visible.length,tracks:visible.slice(page*50,page*50+50).map(({key,artist,title,status,error})=>({key,artist,title,status,error}))};
}
async function command(message) {
  await ready;
  if(message.command==='status') return snapshot(message);
  if(message.command==='export-tracks') {
    if(!state.scanned)throw new Error('Сначала дождись полного сбора списка аудиозаписей.');
    const tracks=await allTracks();
    if(!tracks.length)throw new Error('Список аудиозаписей пуст.');
    return {text:trackListText(tracks),count:tracks.length,filename:'vk-tracks-for-spotify.txt'};
  }
  if(message.command==='wake') { launch(); return {}; }
  if(message.command==='pause') {
    state.running=false; controller?.abort(new DOMException('Пауза','AbortError')); await persist(); return {};
  }
  if(message.command==='report') {
    const tracks=await allTracks();
    return {version:'0.1.16',transport:state.transport||'not-selected',scanned:state.scanned,offset:state.offset,total:tracks.length,error:state.error,counts:tracks.reduce((r,t)=>(r[t.status]=(r[t.status]||0)+1,r),{}),errors:tracks.filter(t=>t.error).map(t=>({code:t.error.code,message:t.error.message,attempts:t.attempts,diagnostics:t.error.diagnostics}))};
  }
  if(message.command==='sample') {
    if(state.running||loop)throw new Error('Сначала поставь очередь на паузу и дождись её остановки.');
    const sample=await diagnosticSample(await allTracks(),getChunk);
    const url=URL.createObjectURL(sample.blob);
    setTimeout(()=>URL.revokeObjectURL(url),120000);
    return {url,filename:sample.filename};
  }
  if(loop) throw new Error('Сначала дождись завершения операции или поставь очередь на паузу.');
  if(message.command==='connect') {
    if(state.account && state.account!==message.connection.account) throw new Error('Очередь принадлежит другому аккаунту VK. Вернись в исходный аккаунт.');
    Object.assign(state,message.connection); state.error=null; await persist(); return {};
  }
  if(!state.account) throw new Error('Сначала нажми «Подключить VK».');
  if(message.command==='test') {
    const sample=(await allTracks()).filter(t=>t.status!=='done').sort((a,b)=>a.index-b.index).slice(0,3);
    for(const track of sample)if(track.status==='error'){track.status='pending';track.attempts=0;track.error=null;await writeTrack(track);}
  }
  if(message.command==='retry') {
    for(const track of await allTracks()) if(track.status==='error') { if(track.error?.code==='CANCELED'){delete track.downloadId;delete track.saveIntent;} track.status='pending'; track.attempts=0; track.error=null; await writeTrack(track); }
  } else if(message.command==='rescan') { state.offset=0; state.scanned=false; state.seenPages=[]; delete state.transport; }
  else if(!['scan','start','test'].includes(message.command)) throw new Error('Неизвестная команда.');
  state.mode=['scan','rescan'].includes(message.command)?'scan':'download';
  state.limit=message.command==='test'?3:null; state.runDone=0; state.runKeys=[]; state.error=null; state.running=true;
  await persist(); launch(); return {};
}
let commands=Promise.resolve();
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || message.target!=='engine' || sender.url?.startsWith('http')) return;
  const result=['status','wake','report'].includes(message.command)?command(message):(commands=commands.then(()=>command(message),()=>command(message)));
  result.then(value=>reply({ok:true,value}),e=>reply({ok:false,error:e.message}));
  return true;
});
ready.then(launch);

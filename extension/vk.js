import {BackupError, parseVKResponse, parsePage, mediaURL, responseShape,trackFromRow,delay} from './core.js';
import {decodeAudioURL} from './vk-decoder.js';
import {decodeResponseBytes} from './response-text.js';
// Only inspect the textual error slots, never the full response or successful audio rows.
export function vkErrorText(parsed) {
  if(Number(parsed?.payload?.[0])!==8)return '';
  const parts=(Array.isArray(parsed.payload[1])?parsed.payload[1].slice(0,3):[]).filter(v=>typeof v==='string').map(value=>{
    try {const decoded=JSON.parse(value);if(typeof decoded==='string')value=decoded;else return '';}catch{}
    value=value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
    if(globalThis.DOMParser)value=new DOMParser().parseFromString(value,'text/html').body.textContent||'';
    else value=value.replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|quot|amp|lt|gt);/g,' ');
    return value.replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi,'[ссылка]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[адрес]')
      .replace(/\b(?:cookie|token|hash|password|access_token)\s*[:=]\s*\S+/gi,'[данные]')
      .replace(/[a-zA-Z0-9_=-]{24,}|\d{6,}/g,'[идентификатор]')
      .replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,400);
  }).filter(v=>v&&!/^(?:false|true|null|undefined)$/i.test(v));
  return [...new Set(parts)].join(' — ').slice(0,600);
}
export async function vkRequest(domain, params, signal, transport='mobile', diagnostics=[],account) {
  const host=domain==='vk.com'?'vk.com':'vk.ru';
  const endpoint=transport==='desktop'?`https://${host}/al_audio.php`:`https://m.${host}/audio`;
  let response,via='extension';
  if(transport==='desktop'&&globalThis.chrome?.runtime?.sendMessage){
    signal.throwIfAborted();
    const result=await chrome.runtime.sendMessage({target:'background',op:'vk-request',account,params});
    signal.throwIfAborted();
    if(!result?.ok)throw new BackupError('VK_TAB',result?.error||'Не удалось обратиться к открытой вкладке VK.',true);
    const r=result.value;
    response={status:r.status,ok:r.status>=200&&r.status<300,redirected:r.redirected,headers:new Headers({'Content-Type':r.contentType}),arrayBuffer:async()=>Uint8Array.from(r.bytes).buffer};
    via='vk-tab';
  }else response = await fetch(endpoint, {
    method: 'POST', credentials: 'include', cache: 'no-store',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest'},
    body: new URLSearchParams(transport==='desktop'?{...params,al:1}:params), signal: AbortSignal.any([signal, AbortSignal.timeout(25000)])
  });
  const entry={transport,via,action:['load_section','reload_audio'].includes(params.act)?params.act:'other',httpStatus:response.status,redirected:!!response.redirected};diagnostics.push(entry);
  try {
  if (!response.ok) throw new BackupError(`VK_${response.status}`, `VK ответил ошибкой ${response.status}. Проверь вкладку VK и повтори позже.`, [401,403,429].includes(response.status));
  const {text,encoding}=decodeResponseBytes(await response.arrayBuffer(),response.headers.get('Content-Type')||'');
  entry.encoding=encoding;entry.responseLength=text.length;
  try {
    const parsed=JSON.parse(text.replace(/^\s*<!--/,''));
    entry.shape=responseShape(parsed);
    const status=parsed?.payload?.[0];
    if(['number','string'].includes(typeof status)&&/^-?\d{1,6}$/.test(String(status)))entry.vkStatus=Number(status);
    const explanation=vkErrorText(parsed);if(explanation)entry.vkMessage=explanation;
    const errorCode=parsed?.error?.error_code ?? parsed?.error?.code;
    if(['number','string'].includes(typeof errorCode)&&/^-?\d{1,6}$/.test(String(errorCode)))entry.apiErrorCode=Number(errorCode);
  }catch{entry.shape={type:'not-json'};}
  return parseVKResponse(text);
  }catch(e){
    // reload_audio must retain the same diagnostic detail as list loading.
    // Do not store the response itself, request hashes, track IDs or URLs.
    if(e instanceof BackupError){
      e.diagnostics=diagnostics;
      if(e.code==='VK') {
        const code=entry.apiErrorCode ?? entry.vkStatus;
        e.message=`VK отклонил запрос${code!==undefined?` (код ${code})`:''} на этапе «${entry.action==='reload_audio'?'получение ссылки на трек':'получение списка'}». ${entry.vkMessage||'Скачай свежий отчёт об ошибках.'}`;
        // An unknown code 8 may be a session or rate-limit error. Skip only explicit track failures.
        if(entry.vkStatus===8&&entry.action==='reload_audio'&&
          /(?:аудиозапись|аудиозаписи|трек|audio|track).{0,100}(?:удален|удалён|недоступ|deleted|unavailable)|(?:удален|удалён|недоступ|deleted|unavailable).{0,100}(?:аудиозапись|аудиозаписи|трек|audio|track)/i.test(entry.vkMessage||'')&&
          !/captcha|капч|провер|авторизац|вход|слишком|лимит|часто|login|too many/i.test(entry.vkMessage||'')) {e.code='VK_TRACK';e.fatal=false;}
      }
    }
    throw e;
  }
}
export async function loadPage(state, signal) {
  const diagnostics=[];
  const transports=state.transport?[state.transport]:state.offset===0?['mobile','desktop']:['mobile'];
  for(const transport of transports) {
    try {
      const result=await vkRequest(state.domain, {act:'load_section', owner_id:state.account, playlist_id:-1, offset:state.offset, type:'playlist', access_hash:'',is_loading_all:1}, signal,transport,diagnostics,state.account);
      const page=parsePage(result);
      if(page.more && page.nextOffset!==undefined && page.nextOffset<=state.offset)throw new BackupError('PAGINATION','VK не продвинул позицию списка. Скачай отчёт об ошибках.',true);
      state.transport=transport;
      return page;
    }catch(e){
      signal.throwIfAborted();
      if(transport===transports.at(-1)||!['FORMAT','AUTH'].includes(e.code)) {
        e.diagnostics=diagnostics;
        throw e;
      }
    }
  }
}
export async function resolveTrack(state, track, signal) {
  if (!track.reload) throw new BackupError('UNAVAILABLE', 'VK не выдал ссылку для этой записи. Возможно, она недоступна.');
  let response;
  try {
    response=await vkRequest(state.domain,{act:'reload_audio',ids:track.reload},signal,state.transport||'mobile',[],state.account);
  }catch(error){
    if(error.code!=='VK'||!error.diagnostics?.some(d=>d.vkStatus===8&&/\bbad_hash\b/.test(d.vkMessage||'')))throw error;
    // Hashes can expire or belong to an earlier session. Refresh only the saved collection,
    // then retry once; never skip a track or retry indefinitely on bad_hash.
    let offset=Number.isSafeInteger(track.sourceOffset)?track.sourceOffset:0;
    const visited=new Set();let found=false;
    for(let pages=0;pages<100&&!visited.has(offset);pages++) {
      visited.add(offset);
      const page=await loadPage({...state,offset},signal);
      const row=page.rows.find(a=>`${a[1]}_${a[0]}`===track.key);
      if(row){track.reload=trackFromRow(row,state.account,track.index).reload;track.sourceOffset=offset;found=true;break;}
      if(offset!==0&&visited.size===1){offset=0;visited.clear();}
      else if(page.more){offset=page.nextOffset??offset+page.rows.length;}
      else break;
      await delay(2200,signal);
    }
    if(!found||!track.reload)throw new BackupError('VK_HASH','Не удалось обновить параметры доступа к треку. Нажми «Обновить список», затем продолжи.',true);
    await delay(1800,signal);
    try {
      response=await vkRequest(state.domain,{act:'reload_audio',ids:track.reload},signal,state.transport||'mobile',[],state.account);
    }catch(retryError){
      if(retryError.code==='VK'&&retryError.diagnostics?.some(d=>/\bbad_hash\b/.test(d.vkMessage||'')))retryError.message='VK вернул bad_hash даже после обновления параметров трека. Очередь остановлена. Сохрани отчёт об ошибках.';
      throw retryError;
    }
  }
  const candidates=[response.data?.[0],response.data,response.payload?.[1]?.[0],response.payload?.[1]?.[1]];
  const row=candidates.filter(Array.isArray).flat().find(a=>Array.isArray(a)&&`${a[1]}_${a[0]}`===track.key);
  if (!row || !row[2]) throw new BackupError('UNAVAILABLE', 'VK не вернул доступное аудио для этой записи.');
  return mediaURL(decodeAudioURL(row[2], Number(state.account)));
}

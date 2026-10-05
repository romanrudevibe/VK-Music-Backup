// Runs only on an existing VK tab. No cookies or passwords are read/exported.
export async function requestInVKTab(account,params) {
  if(!/^\d+$/.test(String(account)))throw new Error('Подключи VK перед загрузкой.');
  const allowed=params.act==='load_section'
    ? {act:'load_section',owner_id:String(account),playlist_id:-1,offset:Number(params.offset),type:'playlist',access_hash:'',is_loading_all:1,al:1}
    :params.act==='reload_audio'&&/^-?\d+_\d+_[\w-]+_[\w-]+$/.test(params.ids)
      ?{act:'reload_audio',ids:params.ids,al:1}:null;
  if(!allowed||(allowed.act==='load_section'&&(!Number.isSafeInteger(allowed.offset)||allowed.offset<0)))throw new Error('Некорректный запрос к VK.');
  const tabs=await chrome.tabs.query({url:['https://vk.ru/*','https://vk.com/*']});
  tabs.sort((a,b)=>Number(b.active)-Number(a.active));
  for(const tab of tabs){
    let result;
    try{
      [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async(expected,body)=>{
        if(!['vk.ru','vk.com'].includes(location.hostname)||String(globalThis.vk?.id)!==expected)return {mismatch:true};
        try{
          const response=await fetch('/al_audio.php',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:new URLSearchParams(body),signal:AbortSignal.timeout(25000)});
          const bytes=new Uint8Array(await response.arrayBuffer());
          if(bytes.length>8*1024*1024)return {error:'Ответ VK слишком большой.'};
          // Bytes retain Windows-1251; decode centrally using the existing adapter.
          return {status:response.status,redirected:response.redirected,contentType:response.headers.get('Content-Type')||'',bytes:Array.from(bytes)};
        }catch{return {error:'Запрос из вкладки VK не завершился. Проверь соединение и обнови вкладку.'};}
      },args:[String(account),allowed]});
    }catch{continue;}
    if(result?.result?.mismatch)continue;
    if(result?.result?.error)throw new Error(result.result.error);
    if(result?.result?.bytes)return result.result;
  }
  throw new Error('Открой «Мою музыку» на vk.ru или vk.com в том же аккаунте и оставь вкладку открытой.');
}

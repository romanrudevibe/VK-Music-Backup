import {requestInVKTab} from './vk-tab.js';
let creating;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
  if (contexts.length) return;
  if (!creating) creating = chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Сборка аудио из сегментов и создание локального файла с сохранением прогресса.'}).finally(()=>{creating=null;});
  await creating;
}
async function accountFromTab() {
  const tabs = await chrome.tabs.query({url:['https://vk.com/*','https://vk.ru/*','https://m.vk.com/*','https://m.vk.ru/*']});
  tabs.sort((a,b)=>Number(b.active)-Number(a.active));
  for (const tab of tabs) {
    try {
      const results = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>{
        // Read only the logged-in identity, never the owner of a displayed playlist.
        const id = globalThis.vk?.id;
        return Number.isSafeInteger(Number(id)) && Number(id)>0 ? String(id) : null;
      }});
      const account = results[0]?.result;
      if (account && /^\d+$/.test(account)) return {account,domain:new URL(tab.url).hostname.endsWith('vk.com')?'vk.com':'vk.ru'};
    } catch { /* Try the next VK tab. */ }
  }
  throw new Error('Открой свою музыку на vk.ru или vk.com и войди в аккаунт. Расширение не смогло определить пользователя.');
}
async function downloadRPC(message) {
  switch(message.op) {
    case 'vk-request': return requestInVKTab(message.account,message.params);
    case 'create': {
      if (!/^VK Audio\/\d+\/[^/]+\.(mp3|m4a)$/.test(message.filename)) throw new Error('Некорректное имя файла');
      return chrome.downloads.download({url:message.url,filename:message.filename,conflictAction:'uniquify',saveAs:false});
    }
    case 'search': return chrome.downloads.search({id:message.id});
    case 'recover': {
      const escaped=message.filename.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\\\.(mp3|m4a)$/,'(?: \\(\\d+\\))?\\.$1');
      const pattern=new RegExp('/'+escaped+'$');
      return (await chrome.downloads.search({startedAfter:message.since})).filter(d=>d.byExtensionId===chrome.runtime.id && pattern.test(d.filename.replaceAll('\\','/')));
    }
    case 'pause': return chrome.downloads.pause(message.id);
    case 'resume': return chrome.downloads.resume(message.id);
    case 'openFolder': return chrome.downloads.showDefaultFolder();
    default: throw new Error('Неизвестная команда загрузки');
  }
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if (sender.id!==chrome.runtime.id) return;
  if (message.target==='background') {
    const offscreen = sender.url===chrome.runtime.getURL('offscreen.html');
    if (!offscreen) return;
    downloadRPC(message).then(value=>reply({ok:true,value}),e=>reply({ok:false,error:e.message}));
    return true;
  }
  if (message.target==='ui') {
    if (sender.url!==chrome.runtime.getURL('dashboard.html')) return;
    (async()=>{
      if (message.command==='connect') message.connection=await accountFromTab();
      if (message.command==='folder') { chrome.downloads.showDefaultFolder(); return {ok:true}; }
      await ensureOffscreen();
      return chrome.runtime.sendMessage({...message,target:'engine'});
    })().then(reply,e=>reply({ok:false,error:e.message}));
    return true;
  }
});
chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('dashboard.html');
  const existing=await chrome.tabs.query({url});
  if(existing[0]) await chrome.tabs.update(existing[0].id,{active:true});
  else await chrome.tabs.create({url});
});
async function wake() {
  await chrome.alarms.create('queue-wakeup',{periodInMinutes:0.5});
  await ensureOffscreen();
  await chrome.runtime.sendMessage({target:'engine',command:'wake'});
}
chrome.runtime.onStartup.addListener(()=>wake().catch(()=>{}));
chrome.runtime.onInstalled.addListener(()=>wake().catch(()=>{}));
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='queue-wakeup') wake().catch(()=>{});});

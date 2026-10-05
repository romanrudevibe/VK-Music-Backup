import {repositoryURL} from './product-config.js';
import {issueDraft,issueURL} from './feedback.js';
const $=id=>document.getElementById(id);
let page=0,last,requesting=false,busy=false,activeCommand='',feedback='',exporting=false;
let exportedTracks=false,partnerHidden=false;
try{partnerHidden=localStorage.getItem('partner-offer-hidden')==='1';}catch{}
function updatePartnerOffer(){
  $('partnerOffer').hidden=partnerHidden||!(exportedTracks||(last?.counts.done>0));
}
$('hidePartner').addEventListener('click',()=>{
  partnerHidden=true;try{localStorage.setItem('partner-offer-hidden','1');}catch{}
  updatePartnerOffer();
});
async function send(command,extra={}) {
  const response=await chrome.runtime.sendMessage({target:'ui',command,...extra});
  if(!response?.ok) throw new Error(response?.error || 'Расширение не ответило. Обнови эту страницу.');
  return response.value;
}
function showError(message) { $('error').textContent=message; $('error').hidden=!message; }
const labels={pending:'В очереди',active:'Загружается',done:'Сохранено',error:'Ошибка'};
function render(data) {
  last=data;
  updatePartnerOffer();
  const {state,counts}=data,active=state.running||data.stopping;
  $('connection').textContent=state.account?`VK · ${state.account}`:'VK не подключён';
  $('connect').textContent=activeCommand==='connect'?'Подключаю…':state.account?'VK подключён':'Подключить VK';
  $('scan').textContent=activeCommand==='scan'||(state.running&&!state.scanned)?'Получаю список…':'1. Собрать список';
  for(const id of ['total','done']) $(id).textContent=counts[id].toLocaleString('ru');
  $('pending').textContent=(counts.pending+counts.active).toLocaleString('ru'); $('errors').textContent=counts.error.toLocaleString('ru');
  $('overall').max=counts.total||1; $('overall').value=counts.done;
  $('status').textContent=data.stopping?'Сохраняю прогресс и останавливаюсь…':state.running?(!state.scanned?`Собираю список: получено ${counts.total} треков…`:'Сохраняю аудиозаписи. Очередь можно поставить на паузу.'):!state.account?'Открой «Мою музыку» в Chrome и подключи VK.':!state.scanned?`Список ещё не собран полностью. Получено ${counts.total}. Нажми «Собрать список», чтобы продолжить.`:counts.done===counts.total&&counts.total>0?'Все треки из собранного списка сохранены.':`Список собран. ${counts.total} треков. Очередь остановлена.`;
  if(state.error) showError(`[${state.error.code}] ${state.error.message}`);
  else if(!busy) showError('');
  if(feedback&&!state.error&&!state.running)$('status').textContent=feedback;
  $('pause').hidden=!active; $('pause').disabled=!state.running;
  $('start').hidden=active;
  for(const id of ['connect','scan','test','start','retry','rescan']) $(id).disabled=busy||active||(id!=='connect'&&!state.account);
  $('retry').disabled ||= !counts.error;
  $('exportTracks').disabled=exporting||!state.scanned||!counts.total;
  $('current').hidden=!data.current;
  if(data.current) {
    $('currentTitle').textContent=`${data.current.artist} — ${data.current.title}`;
    const p=data.current.progress;
    $('currentProgress').textContent=!p||p.phase==='link'?'Получаю свежую ссылку…':p.phase==='segments'?`Части аудио: ${p.done} / ${p.total}`:`Сохранено ${(p.done/1048576).toFixed(1)} МБ${p.total>0?` из ${(p.total/1048576).toFixed(1)} МБ`:''}`;
  }
  $('empty').hidden=!!data.tracks.length; $('table').hidden=!data.tracks.length;
  $('empty').textContent=counts.total?'По этим условиям нет треков.':'Сначала собери список — количество треков появится здесь.';
  const fragment=document.createDocumentFragment();
  for(const track of data.tracks) {
    const tr=document.createElement('tr'),name=document.createElement('td'),status=document.createElement('td');
    const title=document.createElement('strong'),artist=document.createElement('small');
    title.textContent=track.title; artist.textContent=track.artist; name.append(title,artist);
    status.textContent=labels[track.status]||track.status;
    if(track.status==='done')status.className='done';if(track.status==='error')status.className='failed';
    if(track.error){const small=document.createElement('small');small.textContent=`${track.error.code}: ${track.error.message}`;status.append(small);}
    tr.append(name,status);fragment.append(tr);
  }
  $('tracks').replaceChildren(fragment);
  $('page').textContent=`${page+1} / ${Math.max(1,Math.ceil(data.totalVisible/50))}`;
  $('prev').disabled=page===0; $('next').disabled=(page+1)*50>=data.totalVisible;
}
async function refresh() {
  if(requesting)return;requesting=true;
  try{render(await send('status',{page,query:$('search').value,filter:$('filter').checked?'error':'all'}));}
  catch(e){showError(e.message);}finally{requesting=false;}
}
for(const id of ['connect','scan','test','start','pause','retry','rescan','folder']) $(id).addEventListener('click',async()=>{
  busy=true;activeCommand=id;feedback='';showError('');if(last)render(last);
  try{await send(id);if(id==='connect')feedback='VK подключён. Теперь нажми «1. Собрать список».';busy=false;activeCommand='';await refresh();}
  catch(e){busy=false;activeCommand='';await refresh();showError(e.message);stickyError=e.message;}
});
let stickyError='';
$('exportTracks').addEventListener('click',async()=>{
  exporting=true;$('exportTracks').disabled=true;$('exportStatus').textContent='Готовлю текстовый файл…';
  let url;
  try {
    const result=await send('export-tracks');
    url=URL.createObjectURL(new Blob([result.text],{type:'text/plain;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=result.filename;document.body.append(a);a.click();a.remove();
    $('exportStatus').textContent=`Файл ${result.filename} передан в загрузки Chrome. Треков: ${result.count.toLocaleString('ru')}.`;
    exportedTracks=true;updatePartnerOffer();
  }catch(e){$('exportStatus').textContent=e.message;}
  finally{if(url)setTimeout(()=>URL.revokeObjectURL(url),30000);exporting=false;await refresh();}
});
$('report').addEventListener('click',async()=>{
  try{
    const report=await send('report');
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='vk-music-diagnostic.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch(e){showError(e.message);}
});
$('sample').addEventListener('click',async()=>{
  try {
    const {url,filename}=await send('sample');
    const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
    feedback='Тестовый фрагмент сохранён в загрузки Chrome. Пришли файл vk-audio-sample.ts (или .bin) в чат.';
    await refresh();
  }catch(e){stickyError=e.message;showError(e.message);}
});
for(const id of ['search','filter'])$(id).addEventListener('input',()=>{page=0;refresh();});
$('prev').onclick=()=>{page--;refresh();};$('next').onclick=()=>{page++;refresh();};
document.addEventListener('click',()=>{stickyError='';});
setInterval(async()=>{await refresh();if(stickyError)showError(stickyError);},1500);
refresh();

$('feedbackButton').addEventListener('click',()=>{
  $('feedbackDraft').value=issueDraft(chrome.runtime.getManifest().version,last?.state.error);
  $('feedbackStatus').textContent='';
  $('openIssue').disabled=!issueURL(repositoryURL,'');
  $('feedbackHint').textContent=repositoryURL?'Сообщение откроется на GitHub. Отправку подтверждаешь ты. Вопросы и ответы будут видны всем.':'Ссылка на репозиторий ещё не настроена автором. Пока можно скопировать описание проблемы.';
  $('feedbackDialog').showModal();
});
$('closeFeedback').onclick=()=>$('feedbackDialog').close();
$('openIssue').onclick=()=>{
  const url=issueURL(repositoryURL,$('feedbackDraft').value);
  if(url)window.open(url,'_blank','noopener,noreferrer');
};
$('copyFeedback').onclick=async()=>{
  try{await navigator.clipboard.writeText($('feedbackDraft').value);$('feedbackStatus').textContent='Текст скопирован.';}
  catch{$('feedbackDraft').select();$('feedbackStatus').textContent='Выделенный текст можно скопировать вручную.';}
};

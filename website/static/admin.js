fetch('/api/stats').then(r=>{if(!r.ok)throw Error('Не удалось получить статистику.');return r.json();}).then(data=>{
 let views=0,downloads=0;
 for(const day of data.days){views+=day.views;downloads+=day.downloads;const tr=document.createElement('tr');
  for(const value of [day.day,day.views,day.downloads]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
  document.getElementById('days').append(tr);
 }
 document.getElementById('totals').textContent=`Всего: ${views} открытий · ${downloads} запросов скачивания`;
}).catch(e=>{document.getElementById('totals').textContent=e.message;});

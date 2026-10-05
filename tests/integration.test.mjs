import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import '../node_modules/fake-indexeddb/auto/index.mjs';
import {allTracks,putTrack,deleteChunks,getChunk} from '../extension/db.js';
import {filename} from '../extension/core.js';
import {collectHLS,sequenceIV} from '../extension/hls.js';
await import('../extension/vendor/mux.min.js');
const sleep=ms=>new Promise(r=>originalTimer(r,ms));
const originalTimer=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>originalTimer(fn,Math.min(ms,5),...args);
let listener, mode='complete',downloadCounter=0,requests=[],nextID=1;
const downloads=new Map();
globalThis.DOMParser=class{parseFromString(s){return {body:{textContent:s.replace(/<[^>]+>/g,'')}};}};
globalThis.chrome={runtime:{id:'test',onMessage:{addListener(fn){listener=fn;}},async sendMessage(message){
  try {
    let value;
    switch(message.op){
      case 'create': {
        const id=nextID++;downloadCounter++;
        downloads.set(id,{id,state:mode==='complete'?'complete':'in_progress',paused:false,canResume:true,filename:'/Downloads/'+message.filename,startTime:new Date().toISOString(),byExtensionId:'test',bytesReceived:100,totalBytes:100,fileSize:100,mime:'audio/mpeg',exists:true});value=id;break;
      }
      case 'search':value=downloads.has(message.id)?[downloads.get(message.id)]:[];break;
      case 'recover':value=[...downloads.values()].filter(d=>d.filename.endsWith('/'+message.filename));break;
      case 'pause': {const d=downloads.get(message.id);if(d.state==='in_progress')d.paused=true;break;}
      case 'resume': {const d=downloads.get(message.id);d.paused=false;d.state='complete';break;}
      default:throw new Error('unexpected '+message.op);
    }
    return {ok:true,value};
  }catch(e){return {ok:false,error:e.message};}
}}};
function row(id){const a=[id,42,'https://a.vkuseraudio.net/'+id+'.mp3','Title '+id,'Artist',180];a[13]='a/b/action/d/e/url';return a;}
function vkFetch(url,options={}){
  if(String(url).includes('/audio')&&!String(url).endsWith('.mp3')){
    const params=new URLSearchParams(options.body);requests.push(Object.fromEntries(params));
    if(params.get('act')==='load_section'){
      assert.equal(params.get('playlist_id'),'-1');assert.equal(params.get('owner_id'),'123');
      const offset=Number(params.get('offset'));
      return Promise.resolve(new Response(JSON.stringify({data:[{list:offset===0?Array.from({length:1001},(_,i)=>row(i+1)):[row(1002),row(1003)],hasMore:offset===0}]})));
    }
    const id=Number(params.get('ids').split('_')[1]);return Promise.resolve(new Response(JSON.stringify({data:[[row(id)]]})));
  }
  return Promise.resolve(new Response(new Uint8Array([73,68,51,0,0,0,0,0,0,0])));
}
globalThis.fetch=vkFetch;
await import('../extension/engine.js');
function send(command,extra={}){return new Promise((resolve,reject)=>listener({target:'engine',command,...extra},{id:'test'},r=>r.ok?resolve(r.value):reject(new Error(r.error))));}
async function until(fn){for(let i=0;i<1000;i++){const v=await fn();if(v)return v;await sleep(5);}throw new Error('timeout');}
const idle=()=>until(async()=>{const s=await send('status');return !s.state.running&&!s.stopping?s:false;});

test('Queue integration: pagination, rescan, three-track limit, pause/resume and crash intent recovery',async()=>{
  await send('connect',{connection:{account:'123',domain:'vk.ru'}});
  await send('scan');let snapshot=await idle();
  assert.equal(snapshot.counts.total,1003);assert.equal(snapshot.state.scanned,true);
  assert.deepEqual(requests.map(p=>p.offset),['0','1001']);
  await send('rescan');snapshot=await idle();assert.equal(snapshot.counts.total,1003);assert.equal(snapshot.state.error,null);
  await send('test');snapshot=await idle();assert.equal(snapshot.counts.done,3);assert.equal(downloadCounter,3);
  mode='hold';await send('start');
  const active=await until(async()=>{const t=(await allTracks()).find(t=>t.status==='active'&&t.downloadId);return t;});
  await send('pause');await idle();
  assert.equal(downloads.get(active.downloadId).paused,true);
  const before=downloadCounter;mode='complete';await send('test');snapshot=await idle();
  assert.equal(snapshot.counts.done,6);assert.equal(downloadCounter-before,2,'resumed file must not create another download');
  const next=(await allTracks()).filter(t=>t.status==='pending').sort((a,b)=>a.index-b.index)[0];
  next.saveIntent={filename:filename(next,'mp3'),since:new Date(Date.now()-500).toISOString(),kind:'direct'};
  await putTrack(next);
  const id=nextID++;downloads.set(id,{id,state:'complete',exists:true,fileSize:100,mime:'audio/mpeg',bytesReceived:100,totalBytes:100,filename:'/Downloads/'+next.saveIntent.filename,byExtensionId:'test'});
  const previous=downloadCounter;await send('test');snapshot=await idle();
  assert.equal(snapshot.counts.done,9);assert.equal(downloadCounter-previous,2,'intent recovery must adopt existing Chrome download');
  await assert.rejects(send('connect',{connection:{account:'456',domain:'vk.ru'}}),/другому/);
});

test('Queue skips a clearly unavailable VK track and stops after three consecutive VK failures',async()=>{
  let links=0;
  globalThis.fetch=async(url,options={})=>{
    if(new URLSearchParams(options.body).get('act')==='reload_audio'&&++links===1)return new Response(JSON.stringify({payload:[8,['"Ошибка"','false','"Аудиозапись недоступна"']]}));
    return vkFetch(url,options);
  };
  const before=downloadCounter;
  await send('test');let snapshot=await idle();
  assert.equal(downloadCounter-before,2);assert.equal(links,3);assert.equal(snapshot.counts.error,1);assert.equal(snapshot.state.error,null);
  links=0;
  globalThis.fetch=async(url,options={})=>{
    if(new URLSearchParams(options.body).get('act')==='reload_audio'){links++;return new Response(JSON.stringify({payload:[8,['"Ошибка"','false','"Аудиозапись недоступна"']]}));}
    return vkFetch(url,options);
  };
  await send('start');snapshot=await idle();
  assert.equal(links,3);assert.equal(snapshot.state.error.code,'VK_REPEAT');assert.equal(snapshot.counts.error,4);
  assert.ok(snapshot.counts.pending>0);
  globalThis.fetch=vkFetch;
});

test('HLS caches a completed AES-128 segment across interruption and builds playable M4A',async()=>{
  const fixture=await fs.readFile(new URL('./fixtures/test-aac-segment.aac',import.meta.url));
  const raw=new Uint8Array(16).fill(7),key=await crypto.subtle.importKey('raw',raw,'AES-CBC',false,['encrypt']);
  const cipher=await crypto.subtle.encrypt({name:'AES-CBC',iv:sequenceIV(0)},key,fixture);
  const playlist='#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:10,\nseg.aac\n#EXT-X-ENDLIST';
  let segmentRequests=0;
  globalThis.fetch=async(url)=>{
    if(url.includes('.m3u8'))return new Response(playlist);
    if(url.endsWith('/key'))return new Response(raw);
    if(url.endsWith('/seg.aac')){segmentRequests++;return new Response(cipher);}
    throw new Error('unexpected test URL');
  };
  const track={key:'hls-test'},controller=new AbortController();await deleteChunks(track.key);
  await assert.rejects(collectHLS(track,'https://a.vkuseraudio.net/index.m3u8',controller.signal,async()=>controller.abort()));
  assert.ok((await getChunk('hls-test:0')).bytes);
  const blob=await collectHLS(track,'https://a.vkuseraudio.net/index.m3u8',new AbortController().signal,async()=>{});
  assert.equal(segmentRequests,1,'cached segment must not be downloaded again');
  const output=new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(output.subarray(4,8)),'ftyp');
  assert.ok(output.length>1000);
  await fs.writeFile(new URL('../.test-output/test-output.m4a',import.meta.url),output);
  globalThis.fetch=vkFetch;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTrack} from '../extension/vk.js';
const timer=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>timer(fn,Math.min(ms,2),...args);
const row=(id=1)=>{const r=[id,42,'https://a.vkuseraudio.net/a.mp3','Song','Artist',180];r[13]='a/b/FRESH/d/e/URL';return r;};
const rejection=()=>new Response(JSON.stringify({payload:[8,['"Ошибка"','false','"bad_hash"']]}));
test('Refresh expired hashes from the saved collection and retry once',async()=>{
 const calls=[];
 globalThis.fetch=async(url,options)=>{
  const p=Object.fromEntries(new URLSearchParams(options.body));calls.push(p);
  if(p.act==='load_section')return new Response(JSON.stringify({data:[{list:[row()],hasMore:false}]}));
  return p.ids.includes('STALE')?rejection():new Response(JSON.stringify({data:[[row()]]}));
 };
 const track={key:'42_1',reload:'42_1_STALE_OLD',index:0};
 assert.equal(await resolveTrack({domain:'vk.ru',transport:'mobile',account:'123'},track,new AbortController().signal),'https://a.vkuseraudio.net/a.mp3');
 assert.deepEqual(calls.map(p=>p.act),['reload_audio','load_section','reload_audio']);
 assert.equal(calls[1].playlist_id,'-1');assert.equal(calls[1].owner_id,'123');
 assert.equal(calls[2].ids,'42_1_FRESH_URL');assert.equal(track.sourceOffset,0);
});
test('A repeated bad_hash stops after one retry; other VK errors do not refresh',async()=>{
 let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;const p=new URLSearchParams(options.body);
  return p.get('act')==='load_section'?new Response(JSON.stringify({data:[{list:[row()],hasMore:false}]})):rejection();
 };
 await assert.rejects(resolveTrack({domain:'vk.ru',account:'123'},{key:'42_1',reload:'42_1_STALE_OLD'},new AbortController().signal),e=>e.fatal&&e.message.includes('даже после обновления'));
 assert.equal(calls,3);
 calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({payload:[3,[]]}));};
 await assert.rejects(resolveTrack({domain:'vk.ru',account:'123'},{key:'42_1',reload:'42_1_STALE_OLD'},new AbortController().signal),e=>e.fatal);
 assert.equal(calls,1);
});
test('Refresh follows server pagination to the track and honors abort',async()=>{
 const offsets=[];
 globalThis.fetch=async(url,options)=>{
  const p=new URLSearchParams(options.body);
  if(p.get('act')!=='load_section')return p.get('ids').includes('STALE')?rejection():new Response(JSON.stringify({data:[[row()]]}));
  const offset=Number(p.get('offset'));offsets.push(offset);
  return new Response(JSON.stringify({data:[{list:offset===0?[row(2)]:[row()],hasMore:offset===0,nextOffset:2000}]}));
 };
 await resolveTrack({domain:'vk.ru',account:'123'},{key:'42_1',reload:'42_1_STALE_OLD'},new AbortController().signal);
 assert.deepEqual(offsets,[0,2000]);
 const c=new AbortController();c.abort();
 await assert.rejects(resolveTrack({domain:'vk.ru',account:'123'},{key:'42_1',reload:'42_1_STALE_OLD'},c.signal));
});

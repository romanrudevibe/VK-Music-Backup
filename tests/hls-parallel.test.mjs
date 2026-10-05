import test from 'node:test';
import assert from 'node:assert/strict';
import '../node_modules/fake-indexeddb/auto/index.mjs';
import {collectHLS,sequenceIV} from '../extension/hls.js';
import {getChunk,deleteChunks} from '../extension/db.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const frames=Array.from({length:8},(_,i)=>{const b=new Uint8Array(417).fill(i+1);b.set([255,251,144,0]);return b;});
const playlist=(encrypted=false)=>'#EXTM3U\n'+(encrypted?'#EXT-X-KEY:METHOD=AES-128,URI="key"\n':'')+frames.map((_,i)=>`#EXTINF:1,\n${i}.mp3\n`).join('')+'#EXT-X-ENDLIST';
const expected=new Uint8Array(417*8);frames.forEach((b,i)=>expected.set(b,i*417));
test('Four downloads overlap; out-of-order completion preserves audio order and monotonic progress',async()=>{
 let active=0,max=0;const finishes=[],progress=[];
 globalThis.fetch=async(url)=>{
  if(url.endsWith('.m3u8'))return new Response(playlist());
  const i=Number(new URL(url).pathname.slice(1).split('.')[0]);active++;max=Math.max(max,active);
  await sleep(i===0?50:5);active--;finishes.push(i);return new Response(frames[i]);
 };
 const blob=await collectHLS({key:'parallel-order'},'https://a.vkuseraudio.net/a.m3u8',new AbortController().signal,async p=>progress.push(p.done));
 assert.equal(max,4);assert.notEqual(finishes[0],0);assert.equal(active,0);
 assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),expected);
 assert.deepEqual(progress,[1,2,3,4,5,6,7,8]);
});
test('Concurrent encrypted segments share one key fetch and use each segment IV',async()=>{
 const raw=new Uint8Array(16).fill(5),key=await crypto.subtle.importKey('raw',raw,'AES-CBC',false,['encrypt']);
 const ciphertext=await Promise.all(frames.map((b,i)=>crypto.subtle.encrypt({name:'AES-CBC',iv:sequenceIV(i)},key,b)));
 let keys=0;
 globalThis.fetch=async(url)=>{
  if(url.endsWith('.m3u8'))return new Response(playlist(true));
  if(url.endsWith('/key')){keys++;await sleep(10);return new Response(raw);}
  return new Response(ciphertext[Number(new URL(url).pathname.slice(1).split('.')[0])]);
 };
 const blob=await collectHLS({key:'parallel-encrypted'},'https://a.vkuseraudio.net/a.m3u8',new AbortController().signal,async()=>{});
 assert.equal(keys,1);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),expected);
});
test('Pause drains workers and resume downloads only missing segments',async()=>{
 const track={key:'parallel-resume'},controller=new AbortController(),requested=[];let active=0;
 await deleteChunks(track.key);
 globalThis.fetch=async(url,{signal})=>{
  if(url.endsWith('.m3u8'))return new Response(playlist());
  const i=Number(new URL(url).pathname.slice(1).split('.')[0]);requested.push(i);active++;
  try {await sleep(i===0?3:25);signal.throwIfAborted();return new Response(frames[i]);}finally{active--;}
 };
 await assert.rejects(collectHLS(track,'https://a.vkuseraudio.net/a.m3u8',controller.signal,async()=>controller.abort()));
 assert.equal(active,0);
 const cached=[];for(let i=0;i<8;i++)if(await getChunk(`${track.key}:${i}`))cached.push(i);
 assert.ok(cached.includes(0));requested.length=0;
 const blob=await collectHLS(track,'https://a.vkuseraudio.net/a.m3u8',new AbortController().signal,async()=>{});
 assert.equal(active,0);for(const i of cached)assert.ok(!requested.includes(i));
 assert.equal(requested.length,8-cached.length);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),expected);
});
test('Segment failure stops new work, drains existing workers, retains original error and cached successes',async()=>{
 let active=0;const requested=[],track={key:'parallel-error'};
 globalThis.fetch=async(url,{signal})=>{
  if(url.endsWith('.m3u8'))return new Response(playlist());
  const i=Number(new URL(url).pathname.slice(1).split('.')[0]);requested.push(i);active++;
  try {await sleep(i===0?1:i===1?10:30);signal.throwIfAborted();return new Response(frames[i],{status:i===1?503:200});}finally{active--;}
 };
 await assert.rejects(collectHLS(track,'https://a.vkuseraudio.net/a.m3u8',new AbortController().signal,async()=>{}),e=>e.message.includes('503'));
 assert.equal(active,0);assert.ok(requested.length<8);assert.ok(await getChunk(`${track.key}:0`));
});

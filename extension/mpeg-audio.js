import {BackupError} from './core.js';
const fail=()=>new BackupError('AUDIO_FORMAT','Повреждённый или неподдерживаемый MPEG-аудиопоток.');
export function joinBytes(parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;}
export function skipID3(bytes){
  let offset=0;
  while(bytes[offset]===73&&bytes[offset+1]===68&&bytes[offset+2]===51){
    if(offset+10>bytes.length)throw fail();
    const size=bytes.subarray(offset+6,offset+10);if([...size].some(b=>b&128))throw fail();
    offset+=10+size.reduce((n,b)=>(n<<7)|b,0)+(bytes[offset+3]===4&&(bytes[offset+5]&16)?10:0);
    if(offset>bytes.length)throw fail();
  }
  return bytes.subarray(offset);
}
export function mp3FrameLength(bytes,offset=0){
  if(offset+4>bytes.length||bytes[offset]!==255||(bytes[offset+1]&224)!==224)return 0;
  const version=(bytes[offset+1]>>3)&3,layer=(bytes[offset+1]>>1)&3,index=bytes[offset+2]>>4,rate=(bytes[offset+2]>>2)&3;
  if(version===1||layer!==1||index===0||index===15||rate===3)return 0;
  const kbps=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index];
  const hz=[44100,48000,32000][rate]/(version===3?1:version===2?2:4);
  return Math.floor((version===3?144:72)*kbps*1000/hz)+((bytes[offset+2]>>1)&1);
}
export function validateMP3(bytes){
  let offset=0,frames=0;const parts=[];
  while(offset<bytes.length){
    // Timed ID3 metadata may also occur between frames/segments, not only
    // at the beginning of the elementary stream.
    if(bytes[offset]===73&&bytes[offset+1]===68&&bytes[offset+2]===51){const rest=skipID3(bytes.subarray(offset));offset=bytes.length-rest.length;continue;}
    const length=mp3FrameLength(bytes,offset);if(!length||offset+length>bytes.length)throw fail();
    parts.push(bytes.subarray(offset,offset+length));offset+=length;frames++;
  }
  if(frames<2)throw fail();return joinBytes(parts);
}
export function isTS(bytes){return bytes.length>=188&&bytes[0]===71&&(bytes.length<376||bytes[188]===71);}
// Extract audio PES by its MPEG audio stream_id. Video stream_ids are excluded.
// Used only when the resulting bytes validate as complete Layer III frames.
export function tsAudio(buffers){
  let selected=null,pes=[],parts=[];
  function flush(){
    if(!pes.length)return;
    const bytes=joinBytes(pes);pes=[];
    if(bytes.length<9||bytes[0]||bytes[1]||bytes[2]!==1||(bytes[6]&192)!==128)throw fail();
    const declared=(bytes[4]<<8)|bytes[5],end=declared?6+declared:bytes.length,start=9+bytes[8];
    if(end>bytes.length||start>end)throw fail();parts.push(bytes.subarray(start,end));
  }
  for(const input of buffers){
    const bytes=new Uint8Array(input),counters=new Map();
    if(bytes.length%188)throw fail();
    for(let i=0;i<bytes.length;i+=188){
      const p=bytes.subarray(i,i+188);if(p[0]!==71)throw fail();
      const pid=((p[1]&31)<<8)|p[2],start=!!(p[1]&64),adapt=(p[3]>>4)&3;
      if(!(adapt&1))continue;
      const offset=adapt===3?5+p[4]:4;if(offset>188)throw fail();const data=p.subarray(offset);
      if(start&&data.length>=4&&data[0]===0&&data[1]===0&&data[2]===1&&data[3]>=192&&data[3]<=223){
        if(selected!==null&&selected!==pid)throw fail();selected=pid;
      }
      if(pid!==selected)continue;
      if((p[1]&128)||(p[3]&192))throw fail();
      const count=p[3]&15,last=counters.get(pid);
      if(last!==undefined&&count!==((last+1)&15))throw fail();counters.set(pid,count);
      if(start)flush();
      if(start||pes.length)pes.push(data);
    }
  }
  flush();return joinBytes(parts);
}
export function extractMP3(buffers){
  const first=skipID3(new Uint8Array(buffers[0]));
  if(isTS(first)){
    const audio=skipID3(tsAudio(buffers));if(!mp3FrameLength(audio))return null;
    return validateMP3(audio);
  }
  if(!mp3FrameLength(first))return null;
  return validateMP3(joinBytes(buffers.map(b=>skipID3(new Uint8Array(b)))));
}
export function segmentKind(buffer){
  const b=skipID3(new Uint8Array(buffer));
  if(isTS(b))return 'mpeg-ts';if(mp3FrameLength(b))return 'mp3';
  if(b[0]===255&&(b[1]&246)===240)return 'aac-adts';
  if(b.length>=8&&['ftyp','styp','moof'].includes(new TextDecoder().decode(b.subarray(4,8))))return 'mp4';
  return 'unknown';
}

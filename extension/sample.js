// Export only one cached media segment, never playlist URLs, session data or keys.
export async function diagnosticSample(tracks,readChunk) {
  for(const track of tracks.filter(t=>t.status==='error'||t.error)) {
    const chunk=await readChunk(`${track.key}:0`);
    if(!chunk?.bytes?.byteLength)continue;
    const bytes=new Uint8Array(chunk.bytes);
    const ts=bytes.length>=188&&bytes[0]===71;
    const maximum=ts?188*Math.floor(2*1024*1024/188):2*1024*1024;
    return {blob:new Blob([bytes.subarray(0,maximum)],{type:'application/octet-stream'}),filename:ts?'vk-audio-sample.ts':'vk-audio-sample.bin'};
  }
  throw new Error('В кэше нет фрагмента проблемного трека. Нажми «Проверить 3 трека», дождись результата и повтори экспорт.');
}

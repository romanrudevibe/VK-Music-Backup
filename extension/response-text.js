import {BackupError} from './core.js';

// Response.text() always uses UTF-8, even when VK declares windows-1251.
// Decode the original bytes before JSON parsing; U+FFFD cannot be repaired later.
export function decodeResponseBytes(buffer,contentType='') {
  const declared=/\bcharset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  if(declared) {
    let decoder;
    try{decoder=new TextDecoder(declared,{fatal:true});}
    catch{throw new BackupError('ENCODING','VK указал неподдерживаемую кодировку ответа.',true);}
    try{return {text:decoder.decode(buffer),encoding:decoder.encoding};}
    catch{
      if(decoder.encoding!=='utf-8')throw new BackupError('ENCODING','Не удалось прочитать ответ VK в указанной кодировке.',true);
    }
  }else{
    try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(buffer),encoding:'utf-8'};}catch{}
  }
  // Legacy VK endpoints can omit or mislabel charset. Only fall back if bytes
  // are invalid UTF-8; correctly encoded Unicode must never be reinterpreted.
  try{return {text:new TextDecoder('windows-1251',{fatal:true}).decode(buffer),encoding:'windows-1251'};}
  catch{throw new BackupError('ENCODING','Не удалось определить кодировку ответа VK.',true);}
}

// Adapted from python273/vk_api audio_url_decoder.py.
// Copyright (c) 2019 python273. Apache-2.0; see vendor/vk-api-LICENSE.
// Changes: JavaScript port, validation and explicit unknown-operation errors.
import {BackupError} from './core.js';
const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';
export function vkBase64(value) {
  let output = '', accumulator = 0, count = 0;
  for (const c of value) {
    const index = alphabet.indexOf(c);
    if (index < 0) continue;
    if (count % 4) { count++; accumulator = (accumulator << 6) + index; output += String.fromCharCode((accumulator >> ((-2 * count) & 6)) & 255); }
    else { accumulator = index; count++; }
  }
  return output;
}
function shuffle(value, seed) {
  const length = value.length;
  if (!length) return value;
  const indices = [];
  for (let i = length - 1; i >= 0; i--) { seed = ((length * (i + 1)) ^ (seed + i)) % length; indices[i] = seed; }
  const chars = value.split('');
  for (let i = 1; i < length; i++) { const j = indices[length - 1 - i]; [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
export function decodeAudioURL(url, userId) {
  if (!url.includes('audio_api_unavailable')) return url;
  const parts = url.split('?extra=')[1]?.split('#');
  if (!parts || parts.length !== 2) throw new BackupError('DECODE', 'Не распознан формат ссылки VK.');
  let value = vkBase64(parts[0]);
  for (const op of vkBase64(parts[1]).split('\t').reverse()) {
    const [command, arg] = op.split('\v');
    if (command === 'v') value = value.split('').reverse().join('');
    else if (command === 'r') value = [...value].map(c => { const i = alphabet.indexOf(c); return i < 0 ? c : (alphabet + alphabet)[((i - Number(arg)) % (alphabet.length * 2) + alphabet.length * 2) % (alphabet.length * 2)]; }).join('');
    else if (command === 'x' && arg) value = [...value].map(c => String.fromCharCode(c.charCodeAt(0) ^ arg.charCodeAt(0))).join('');
    else if (command === 's') value = shuffle(value, Number(arg));
    else if (command === 'i') value = shuffle(value, Number(arg) ^ userId);
    else throw new BackupError('DECODE', 'VK изменил формат ссылки. Требуется обновление расширения.');
  }
  return value;
}

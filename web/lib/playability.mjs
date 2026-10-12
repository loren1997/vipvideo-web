import { createDecipheriv } from 'node:crypto';
import { request as networkRequest, readText, validateUrl } from './network.mjs';

const MAX_CACHE = 500;
const TIMEOUT = 8000;
const PLAYLIST_LIMIT = 256 * 1024;
const SAMPLE_LIMIT = 64 * 1024;

function attributes(line) {
  return Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(match => [match[1], match[2] ?? match[3]]));
}

function byteRange(value) {
  if (!value) return { offset: 0, length: 1024 };
  const match = String(value).match(/^(\d+)(?:@(\d+))?$/);
  const length = Number(match?.[1]), offset = Number(match?.[2] ?? 0);
  if (!match || !Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) throw new Error('HLS 字节范围无效');
  return { offset, length: Math.min(length, 1024) };
}

function looksHtml(bytes) {
  return /^\s*(?:<!doctype|<html|<head|<body|<\?xml|\{\s*")/i.test(bytes.subarray(0, 128).toString('utf8'));
}

function mp4Bytes(bytes) {
  return bytes.length >= 8 && ['ftyp', 'styp', 'moof', 'moov', 'mdat', 'sidx'].includes(bytes.toString('ascii', 4, 8));
}

function mediaBytes(bytes) {
  if (bytes.length >= 188 && bytes[0] === 0x47 && (bytes.length <= 188 || bytes[188] === 0x47)) return true;
  if (mp4Bytes(bytes)) return true;
  return bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
}

function mediaType(headers) {
  return /^(?:video\/|audio\/|application\/(?:octet-stream|mp4|mp2t)(?:;|$))/i.test(String(headers?.['content-type'] || ''));
}

function playlist(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('返回内容不是有效 HLS 清单');
  let master = false, key = null, map = null, range, sequence = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) { master = true; continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.slice(line.indexOf(':') + 1));
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('HLS 分片序号无效');
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const next = attributes(line);
      if (next.METHOD === 'NONE') key = null;
      else if (next.METHOD === 'AES-128' && next.URI && (!next.KEYFORMAT || next.KEYFORMAT === 'identity')) key = next;
      else throw new Error('暂不支持此 HLS 加密方式');
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const next = attributes(line);
      if (!next.URI) throw new Error('HLS 初始化分片缺少链接');
      map = { ...next, key };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(line.indexOf(':') + 1);
    else if (line && !line.startsWith('#')) return master ? { child: line } : { segment: line, key, map, range, sequence };
  }
  throw new Error('HLS 清单没有可用分片');
}

export function createPlayability({ request = networkRequest, now = Date.now } = {}) {
  const cache = new Map(), flights = new Map(), queue = [];
  let active = 0;

  function identity(episode) {
    if (!['mp4', 'hls'].includes(episode?.type)) throw new Error('仅检测 MP4 / HLS 媒体');
    return { url: validateUrl(episode.url).href, type: episode.type };
  }
  const keyOf = value => `${value.type}\n${value.url}`;
  const result = (playable, error) => ({ playable, checkedAt: now(), ...(error ? { error: String(error).slice(0, 200) } : {}) });
  function save(key, value) {
    cache.delete(key);
    cache.set(key, { value, expires: now() + (value.playable ? 5 * 60 * 1000 : 60 * 1000) });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  function get(key) {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    if (entry.expires > now()) { cache.set(key, entry); return entry.value; }
  }
  function admit(task) {
    return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
  }
  function drain() {
    while (active < 2 && queue.length) {
      const job = queue.shift(); active++;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }

  async function inspect(episode) {
    const deadline = Date.now() + TIMEOUT, responses = new Set();
    let expired = false, timer;
    const assertTime = () => { if (expired || Date.now() >= deadline) throw new Error('播放探测超时（8 秒）'); };
    async function open(url, options = {}) {
      assertTime();
      const value = validateUrl(url).href;
      const response = await request(value, { ...options, timeout: Math.max(1, deadline - Date.now()) });
      if (expired) { response.destroy(); assertTime(); }
      responses.add(response);
      // 超时销毁的错误由整个探测结果记录；保留监听以避免响应尚未进入读取时的未处理错误。
      response.on('error', () => {});
      response.finalUrl = validateUrl(response.finalUrl || value).href;
      return response;
    }
    function success(response) {
      if (![200, 206].includes(response.statusCode)) throw new Error(`媒体源返回 HTTP ${response.statusCode}`);
    }
    async function sample(url, range, exactKey = false) {
      const spec = byteRange(range);
      const response = await open(url, { headers: exactKey ? {} : { range: `bytes=${spec.offset}-${spec.offset + spec.length - 1}` } });
      success(response);
      const parts = []; let size = 0;
      const wanted = exactKey ? 17 : spec.length;
      for await (const chunk of response) {
        assertTime();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const take = Math.min(bytes.length, wanted - size, SAMPLE_LIMIT - size);
        parts.push(bytes.subarray(0, take)); size += take;
        if (size >= wanted) { response.destroy(); break; }
      }
      const bytes = Buffer.concat(parts);
      if (!bytes.length) throw new Error('媒体源返回空内容');
      if (exactKey && bytes.length !== 16) throw new Error('AES-128 密钥必须为 16 字节');
      if (looksHtml(bytes)) throw new Error('媒体源返回网页或错误内容');
      return { bytes, headers: response.headers };
    }
    async function probe() {
      if (episode.type === 'mp4') {
        const head = await open(episode.url, { method: 'HEAD' });
        if ([405, 501].includes(head.statusCode)) {
          head.destroy();
          const value = await sample(episode.url);
          if (!/^(?:video\/mp4|application\/octet-stream)(?:;|$)/i.test(String(value.headers['content-type'] || '')) || !mp4Bytes(value.bytes)) throw new Error('返回内容不是可用 MP4');
        } else {
          success(head);
          if (!/^(?:video\/mp4|application\/octet-stream)(?:;|$)/i.test(String(head.headers['content-type'] || '')) || head.headers['content-length'] === '0') throw new Error('返回内容不是可用 MP4');
          head.destroy();
        }
        return;
      }
      const visited = new Set(), keys = new Map();
      let url = episode.url;
      for (let depth = 0; depth < 3; depth++) {
        const requested = validateUrl(url).href;
        if (visited.has(requested)) throw new Error('HLS 清单循环引用');
        visited.add(requested);
        const response = await open(requested);
        if (response.statusCode !== 200) throw new Error(`HLS 清单返回 HTTP ${response.statusCode}`);
        const base = response.finalUrl;
        if (base !== requested && visited.has(base)) throw new Error('HLS 清单循环引用');
        visited.add(base);
        const data = playlist(await readText(response, PLAYLIST_LIMIT));
        if (data.child) { url = validateUrl(new URL(data.child, base)).href; continue; }
        async function decode(value, encryption, requireIv = false) {
          if (!encryption) return value;
          const keyUrl = validateUrl(new URL(encryption.URI, base)).href;
          if (!keys.has(keyUrl)) keys.set(keyUrl, (await sample(keyUrl, undefined, true)).bytes);
          let iv;
          if (encryption.IV) {
            if (!/^0x[\da-f]{1,32}$/i.test(encryption.IV)) throw new Error('HLS 加密 IV 无效');
            iv = Buffer.from(encryption.IV.slice(2).padStart(32, '0'), 'hex');
          } else {
            if (requireIv) throw new Error('加密初始化分片缺少 IV');
            iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(data.sequence), 8);
          }
          if (value.length < 16) throw new Error('加密分片内容过短');
          const cipher = createDecipheriv('aes-128-cbc', keys.get(keyUrl), iv).setAutoPadding(false);
          return Buffer.concat([cipher.update(value.subarray(0, value.length - value.length % 16)), cipher.final()]);
        }
        async function checkSample(uri, range, encryption, isMap = false) {
          const value = await sample(validateUrl(new URL(uri, base)).href, range);
          const bytes = await decode(value.bytes, encryption, isMap);
          if (looksHtml(bytes) || !mediaBytes(bytes) || (!mediaType(value.headers) && /^(?:text\/html|application\/(?:json|xml))/i.test(String(value.headers['content-type'] || '')))) throw new Error('分片不是可用音视频内容');
        }
        if (data.map) await checkSample(data.map.URI, data.map.BYTERANGE, data.map.key, true);
        await checkSample(data.segment, data.range, data.key);
        return;
      }
      throw new Error('HLS 清单嵌套超过 3 层');
    }
    try {
      await Promise.race([probe(), new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('播放探测超时（8 秒）')); for (const response of responses) response.destroy(new Error('播放探测超时（8 秒）')); }, TIMEOUT); })]);
      assertTime();
      return result(true);
    } catch (error) { return result(false, error.message); }
    finally { clearTimeout(timer); for (const response of responses) response.destroy(); }
  }

  return {
    check(episode) {
      let value;
      try { value = identity(episode); } catch (error) { return Promise.resolve(result(false, error.message)); }
      const key = keyOf(value), cached = get(key);
      if (cached) return Promise.resolve(cached);
      if (flights.has(key)) return flights.get(key).promise;
      if (flights.size >= MAX_CACHE) return Promise.resolve(result(false, '播放探测队列已满，请稍后重试'));
      const flight = {};
      flight.promise = admit(() => inspect(value)).then(probed => { const state = flight.override || probed; save(key, state); return state; }).finally(() => flights.delete(key));
      flights.set(key, flight);
      return flight.promise;
    },
    report(episode, playable = false) {
      let value;
      try { value = identity(episode); } catch (error) { return result(false, error.message); }
      const state = result(playable === true, playable === true ? undefined : '实际播放器无法解码或加载此媒体');
      const key = keyOf(value);
      if (flights.has(key)) flights.get(key).override = state;
      save(key, state);
      return state;
    },
  };
}

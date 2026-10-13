import { createDecipheriv } from 'node:crypto';
import { request as networkRequest, readText, validateUrl } from './network.mjs';

const MAX_CACHE = 500;
const TIMEOUT = 8000;
const PLAYLIST_LIMIT = 256 * 1024;
const SAMPLE_LIMIT = 64 * 1024;

function attributes(line) {
  return Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(match => [match[1], match[2] ?? match[3]]));
}

function byteRange(value, limit = 1024) {
  if (!value) return { offset: 0, length: limit };
  const match = String(value).match(/^(\d+)(?:@(\d+))?$/);
  const length = Number(match?.[1]), offset = Number(match?.[2] ?? 0);
  if (!match || !Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) throw new Error('HLS 字节范围无效');
  return { offset, length: Math.min(length, limit) };
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

function h264Size(nal) {
  try {
    if (nal.length < 5 || (nal[0] & 31) !== 7) return;
    const rbsp = Buffer.from([...nal.subarray(1)].filter((value, index, data) => !(value === 3 && index >= 2 && data[index - 1] === 0 && data[index - 2] === 0)));
    let offset = 0;
    const bits = count => {
      if (count < 0 || count > 32 || offset + count > rbsp.length * 8) throw new Error('截断的 SPS');
      let value = 0; for (let index = 0; index < count; index++, offset++) value = value * 2 + ((rbsp[offset >> 3] >> (7 - offset % 8)) & 1);
      return value;
    };
    const ue = () => { let zeros = 0; while (!bits(1)) if (++zeros > 24) throw new Error('SPS 指数过大'); return 2 ** zeros - 1 + bits(zeros); };
    const se = () => { const value = ue(); return value & 1 ? (value + 1) / 2 : -value / 2; };
    const profile = bits(8); if (![66, 77, 88, 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) return; bits(16); if (ue() > 31) return;
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue(); if (chroma > 3) return; if (chroma === 3) bits(1);
      if (ue() > 6 || ue() > 6) return; bits(1);
      if (bits(1)) for (let index = 0; index < (chroma === 3 ? 12 : 8); index++) if (bits(1)) {
        let last = 8, next = 8;
        for (let entry = 0; entry < (index < 6 ? 16 : 64); entry++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
      }
    }
    if (ue() > 16) return;
    const poc = ue();
    if (poc === 0) { if (ue() > 16) return; }
    else if (poc === 1) { bits(1); se(); se(); const cycles = ue(); if (cycles > 256) return; for (let index = 0; index < cycles; index++) se(); }
    else if (poc !== 2) return;
    ue(); bits(1); const widthMbs = ue() + 1, heightMbs = ue() + 1, frameOnly = bits(1);
    if (!frameOnly) bits(1); bits(1);
    const crop = bits(1) ? [ue(), ue(), ue(), ue()] : [0, 0, 0, 0];
    const width = widthMbs * 16 - (crop[0] + crop[1]) * (chroma === 0 || chroma === 3 ? 1 : 2);
    const height = heightMbs * 16 * (2 - frameOnly) - (crop[2] + crop[3]) * (chroma === 1 ? 2 : 1) * (2 - frameOnly);
    if (width >= 32 && width <= 8192 && height >= 32 && height <= 4320) return { width, height, source: 'bitstream' };
  } catch { /* 非 H264、未知或截断的头只省略尺寸，不能虚构高清。 */ }
}

function videoSize(bytes) {
  let elementary = bytes;
  if (bytes[0] === 0x47 && bytes.length >= 188) {
    const parts = [], pids = new Set();
    for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
      const packet = bytes.subarray(offset, offset + 188), control = (packet[3] >> 4) & 3;
      if (packet[0] !== 0x47 || !(control & 1)) continue;
      let start = control === 3 ? 5 + packet[4] : 4; if (start >= 188) continue;
      const pid = ((packet[1] & 31) << 8) | packet[2];
      if (packet[1] & 64) {
        if (packet[start] !== 0 || packet[start + 1] !== 0 || packet[start + 2] !== 1 || packet[start + 3] < 0xe0 || packet[start + 3] > 0xef) { pids.delete(pid); continue; }
        pids.add(pid); start += 9 + packet[start + 8];
      }
      if (pids.has(pid) && start < 188) parts.push(packet.subarray(start));
    }
    elementary = Buffer.concat(parts);
  }
  const avcc = elementary.indexOf(Buffer.from('avcC'));
  if (avcc >= 0 && avcc + 12 < elementary.length && elementary[avcc + 4] === 1 && (elementary[avcc + 9] & 31)) {
    const length = elementary.readUInt16BE(avcc + 10);
    if (length > 0 && avcc + 12 + length <= elementary.length) { const size = h264Size(elementary.subarray(avcc + 12, avcc + 12 + length)); if (size) return size; }
  }
  for (let index = 0; index + 4 < elementary.length; index++) if (elementary[index] === 0 && elementary[index + 1] === 0 && elementary[index + 2] === 1 && (elementary[index + 3] & 31) === 7) {
    let end = index + 4;
    while (end + 3 < elementary.length && !(elementary[end] === 0 && elementary[end + 1] === 0 && elementary[end + 2] === 1)) end++;
    const size = h264Size(elementary.subarray(index + 3, end + 3 >= elementary.length ? elementary.length : end)); if (size) return size;
  }
}

function variantQuality(value) {
  const size = /^(\d{1,5})x(\d{1,5})$/.exec(value.RESOLUTION || ''), width = Number(size?.[1]), height = Number(size?.[2]), bandwidth = Number(value['AVERAGE-BANDWIDTH'] || value.BANDWIDTH);
  return size && width >= 32 && width <= 8192 && height >= 32 && height <= 4320 ? { width, height, source: 'manifest', ...(Number.isSafeInteger(bandwidth) && bandwidth > 0 && bandwidth <= 200_000_000 ? { bandwidth } : {}) } : undefined;
}

function playlist(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('返回内容不是有效 HLS 清单');
  let master = false, pending, key = null, map = null, range, sequence = 0; const children = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) { master = true; pending = attributes(line); continue; }
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
    else if (line && !line.startsWith('#')) {
      if (!master) return { segment: line, key, map, range, sequence, live: !lines.includes('#EXT-X-ENDLIST') };
      const declared = (pending?.CODECS || '').split(',').map(value => value.trim()).filter(Boolean);
      const audioOnly = declared.length > 0 && declared.every(value => /^(?:mp4a(?:\.[a-z0-9]+)*|aac(?:\.[a-z0-9]+)*|ac-3|ec-3|ac-4|opus|vorbis|flac|alac|mp3|joc|audio)$/i.test(value));
      if (pending && !audioOnly && children.length < 50) children.push({ uri: line, quality: variantQuality(pending), codecs: pending.CODECS || '', externalAudio: !!pending.AUDIO && lines.some(value => value.startsWith('#EXT-X-MEDIA:') && attributes(value).TYPE === 'AUDIO' && attributes(value)['GROUP-ID'] === pending.AUDIO && attributes(value).URI) });
      pending = undefined;
    }
  }
  if (children.length) {
    const tier = value => /(?:hvc1|hev1|av01|vp09)/i.test(value.codecs) && !/(?:^|,)\s*(?:avc1|avc3)/i.test(value.codecs) ? 0 : 1;
    children.sort((a, b) => tier(b) - tier(a) || (b.quality?.height || 0) - (a.quality?.height || 0) || (b.quality?.bandwidth || 0) - (a.quality?.bandwidth || 0));
    return { children };
  }
  if (master) throw new Error('HLS 主清单没有可用的视频分支');
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
    let expired = false, timer, evidence;
    const assertTime = scope => { if (expired || Date.now() >= deadline) throw new Error('播放探测超时（8 秒）'); if (scope && (scope.expired || Date.now() >= scope.deadline)) throw new Error('此 HLS 清晰度探测超时'); };
    async function open(url, options = {}, scope) {
      assertTime(scope);
      const value = validateUrl(url).href;
      const response = await request(value, { ...options, timeout: Math.max(1, Math.min(deadline, scope?.deadline || deadline) - Date.now()) });
      if (expired || scope?.expired || Date.now() >= (scope?.deadline || deadline)) { response.on('error', () => {}); response.destroy(); assertTime(scope); }
      responses.add(response);
      for (let parent = scope; parent; parent = parent.parent) parent.responses.add(response);
      // 超时销毁的错误由整个探测结果记录；保留监听以避免响应尚未进入读取时的未处理错误。
      response.on('error', () => {});
      response.finalUrl = validateUrl(response.finalUrl || value).href;
      return response;
    }
    function success(response) {
      if (![200, 206].includes(response.statusCode)) throw new Error(`媒体源返回 HTTP ${response.statusCode}`);
    }
    async function sample(url, range, exactKey = false, rich = false, scope) {
      const spec = byteRange(range, rich ? 16 * 1024 : 1024);
      const response = await open(url, { headers: exactKey ? {} : { range: `bytes=${spec.offset}-${spec.offset + spec.length - 1}` } }, scope);
      success(response);
      const parts = []; let size = 0;
      const wanted = exactKey ? 17 : spec.length;
      for await (const chunk of response) {
        assertTime(scope);
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
      const keys = new Map();
      async function hls(url, depth = 0, visited = new Set(), quality, externalAudio = false, scope) {
        if (depth >= 3) throw new Error('HLS 清单嵌套超过 3 层');
        const requested = validateUrl(url).href;
        if (visited.has(requested)) throw new Error('HLS 清单循环引用');
        visited.add(requested);
        const response = await open(requested, {}, scope);
        if (response.statusCode !== 200) throw new Error(`HLS 清单返回 HTTP ${response.statusCode}`);
        const base = response.finalUrl;
        if (base !== requested && visited.has(base)) throw new Error('HLS 清单循环引用');
        visited.add(base);
        const data = playlist(await readText(response, PLAYLIST_LIMIT));
        if (data.children) {
          let lastError;
          const reasonable = data.children.filter(child => !child.quality || (child.quality.width <= 3840 && child.quality.height <= 2160));
          const candidates = (reasonable.length ? reasonable : data.children).slice(0, 3);
          for (let index = 0; index < candidates.length; index++) {
            const child = candidates[index], remaining = Math.min(deadline, scope?.deadline || deadline) - Date.now();
            const branch = { deadline: Date.now() + Math.max(1, Math.floor(remaining / (candidates.length - index))), expired: false, responses: new Set(), parent: scope };
            let branchTimer;
            try {
              return await Promise.race([
                hls(validateUrl(new URL(child.uri, base)).href, depth + 1, new Set(visited), child.quality || quality, externalAudio || child.externalAudio, branch),
                new Promise((_, reject) => { branchTimer = setTimeout(() => { branch.expired = true; for (const value of branch.responses) value.destroy(new Error('此 HLS 清晰度探测超时')); reject(new Error('此 HLS 清晰度探测超时')); }, Math.max(1, branch.deadline - Date.now())); }),
              ]);
            } catch (error) { lastError = error; assertTime(scope); }
            finally { clearTimeout(branchTimer); branch.expired = true; for (const value of branch.responses) value.destroy(); }
          }
          throw lastError || new Error('HLS 主清单没有可用的视频线路');
        }
        async function decode(value, encryption, requireIv = false) {
          if (!encryption) return value;
          const keyUrl = validateUrl(new URL(encryption.URI, base)).href;
          if (!keys.has(keyUrl)) keys.set(keyUrl, (await sample(keyUrl, undefined, true, false, scope)).bytes);
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
          const value = await sample(validateUrl(new URL(uri, base)).href, range, false, true, scope);
          const bytes = await decode(value.bytes, encryption, isMap);
          if (looksHtml(bytes) || !mediaBytes(bytes) || (!mediaType(value.headers) && /^(?:text\/html|application\/(?:json|xml))/i.test(String(value.headers['content-type'] || '')))) throw new Error('分片不是可用音视频内容');
          return videoSize(bytes);
        }
        const mapped = data.map ? await checkSample(data.map.URI, data.map.BYTERANGE, data.map.key, true) : undefined;
        const dimensions = await checkSample(data.segment, data.range, data.key) || mapped;
        assertTime(scope);
        const signedChild = [...new URL(base).searchParams].some(([key, value]) => new URL(episode.url).searchParams.get(key) !== value);
        return { live: data.live, playbackUrl: externalAudio || signedChild ? episode.url : base, ...(dimensions || quality ? { quality: dimensions ? { ...quality, ...dimensions } : quality } : {}) };
      }
      evidence = await hls(episode.url);
    }
    try {
      await Promise.race([probe(), new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('播放探测超时（8 秒）')); for (const response of responses) response.destroy(new Error('播放探测超时（8 秒）')); }, TIMEOUT); })]);
      assertTime();
      return { ...result(true), ...evidence };
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

import { request as networkRequest, readText, validateUrl } from './network.mjs';

const TIMEOUT = 8000, MAX_BYTES = 1024 * 1024, MAX_RANGES = 20;
const LABEL = 'HLS 明确广告标记', SOURCE = 'hls-markers';
const unsupported = reason => ({ ranges: [], supported: false, reason, label: LABEL, source: SOURCE });
const fail = reason => { throw new Error(reason); };
const decimal = value => /^\d+(?:\.\d+)?$/.test(value || '') && Number.isFinite(Number(value)) ? Number(value) : NaN;

function attributes(value) {
  if (value.length > 8192) fail('清单属性过长');
  const result = Object.create(null), pattern = /([A-Za-z0-9-]+)=("[^"\r\n]*"|[^,\r\n]+)(?:,|$)/gy;
  let offset = 0;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    if (!match || Object.hasOwn(result, match[1])) fail('清单属性无效或重复');
    result[match[1]] = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2].trim();
    offset = pattern.lastIndex;
  }
  return result;
}

function timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value || '');
  const result = Date.parse(value);
  if (!match || !Number.isFinite(result) || +match[2] < 1 || +match[2] > 12 || +match[3] < 1 || +match[3] > new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate()) fail('广告日期无效');
  return result;
}

function addRange(ranges, start, end, kind, total = Infinity) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 600 || end > total || ranges.length >= MAX_RANGES) fail('广告时段无效或超过安全范围');
  ranges.push({ start, end, kind });
}

function videoChild(lines) {
  const children = [];
  let pending;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) pending = attributes(line.slice(line.indexOf(':') + 1));
    else if (line && !line.startsWith('#') && pending) {
      const codecs = (pending.CODECS || '').split(',').map(value => value.trim()).filter(Boolean);
      const audioOnly = codecs.length > 0 && codecs.every(value => /^(?:mp4a(?:\.[a-z0-9]+)*|aac(?:\.[a-z0-9]+)*|ac-3|ec-3|ac-4|opus|vorbis|flac|alac|mp3|joc|audio)$/i.test(value));
      if (!audioOnly && children.length < 50) children.push({ uri: line, height: Number(/x(\d+)$/.exec(pending.RESOLUTION || '')?.[1]) || 0, compatible: !/(?:hvc1|hev1|av01|vp09)/i.test(pending.CODECS || '') || /(?:^|,)\s*avc[13]/i.test(pending.CODECS || '') });
      pending = undefined;
    }
  }
  children.sort((a, b) => Number(b.compatible) - Number(a.compatible) || b.height - a.height);
  return children[0]?.uri;
}

function vodRanges(lines) {
  if (!lines.includes('#EXT-X-ENDLIST') || lines.includes('#EXT-X-PLAYLIST-TYPE:EVENT')) return unsupported('仅完整点播清单支持自动识别');
  const ranges = [], dates = new Map();
  let position = 0, duration, cue, baseDate, segments = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      if (duration !== undefined) fail('分片时长缺少对应链接');
      duration = decimal(line.slice(8).split(',')[0]);
      if (!(duration > 0) || duration > 86400) fail('分片时长无效');
    } else if (line && !line.startsWith('#')) {
      if (duration === undefined || ++segments > 50000) fail('清单分片不完整');
      const next = position + duration;
      if (!Number.isFinite(next) || next <= position || next > 86400) fail('影片总时长超过安全范围');
      position = next; duration = undefined;
    } else if (line === '#EXT-X-GAP') fail('有缺失分片，无法可靠定位广告');
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const base = timestamp(line.slice(line.indexOf(':') + 1)) - position * 1000;
      if (baseDate !== undefined && Math.abs(base - baseDate) > 50) fail('日期与影片时间线不连续');
      baseDate ??= base;
    } else if (line === '#EXT-X-CUE-OUT' || line.startsWith('#EXT-X-CUE-OUT:')) {
      if (cue) fail('广告开始标记嵌套');
      let declared;
      if (line.includes(':')) {
        const value = line.slice(line.indexOf(':') + 1);
        declared = decimal(value.includes('=') ? attributes(value).DURATION : value);
        if (!(declared > 0) || declared > 600) fail('广告声明时长无效');
      }
      cue = { start: position, declared };
    } else if (line === '#EXT-X-CUE-IN') {
      if (!cue) fail('广告结束标记缺少开始');
      if (cue.declared !== undefined && Math.abs(position - cue.start - cue.declared) > 0.05) fail('广告闭合时长与声明不一致');
      addRange(ranges, cue.start, position, 'cue'); cue = undefined;
    } else if (line.startsWith('#EXT-X-CUE-OUT-CONT')) {
      if (!cue || !line.startsWith('#EXT-X-CUE-OUT-CONT:')) fail('广告清单缺少完整开始标记');
      const value = line.slice(line.indexOf(':') + 1), next = value.includes('=') ? attributes(value) : null;
      if (!next && !/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(value)) fail('广告继续标记无效');
      const elapsed = decimal(next ? next.ElapsedTime : value.split('/')[0]), length = decimal(next ? next.Duration : value.split('/')[1]);
      if (!(elapsed >= 0) || !(length > 0) || length > 600 || Math.abs(elapsed - (position - cue.start)) > 0.05 || cue.declared !== undefined && Math.abs(length - cue.declared) > 0.05) fail('广告继续标记时长不一致');
      cue.declared ??= length;
    } else if (line.startsWith('#EXT-X-DATERANGE:')) {
      const next = attributes(line.slice(line.indexOf(':') + 1));
      if (!next.ID || next.ID.length > 256 || dates.size >= 128 && !dates.has(next.ID)) fail('日期范围标识无效或过多');
      const record = dates.get(next.ID) || { attributes: Object.create(null) };
      for (const [key, value] of Object.entries(next)) {
        if (Object.hasOwn(record.attributes, key) && record.attributes[key] !== value) fail('同一日期范围属性发生冲突');
        record.attributes[key] = value;
      }
      if (next['SCTE35-IN']) record.closePosition ??= position;
      dates.set(next.ID, record);
    }
  }
  if (duration !== undefined || !segments || cue) fail('清单或广告标记未完整闭合');
  for (const record of dates.values()) {
    const attrs = record.attributes;
    // Apple external interstitial duration is not a range of the primary movie.
    if (attrs.CLASS === 'com.apple.hls.interstitial' || attrs['X-ASSET-URI'] || attrs['X-ASSET-LIST']) continue;
    if (!attrs['SCTE35-OUT'] && !/^(?:ad|ads|advertisement|advertising)$/i.test(attrs.CLASS || '')) continue;
    if (attrs['END-ON-NEXT'] !== undefined) fail('此广告日期范围没有明确闭合结束');
    if (attrs['SCTE35-OUT'] && !/^0x[\da-f]+$/i.test(attrs['SCTE35-OUT']) || attrs['SCTE35-IN'] && !/^0x[\da-f]+$/i.test(attrs['SCTE35-IN'])) fail('广告日期范围声明无效');
    if (baseDate === undefined) fail('广告日期范围缺少可靠影片日期定位');
    const startDate = timestamp(attrs['START-DATE']), start = (startDate - baseDate) / 1000;
    let end;
    if (attrs['END-DATE']) end = (timestamp(attrs['END-DATE']) - baseDate) / 1000;
    if (attrs.DURATION !== undefined) {
      const length = decimal(attrs.DURATION);
      if (!(length > 0) || length > 600) fail('广告日期范围时长无效');
      if (end !== undefined && Math.abs(end - start - length) > 0.05) fail('广告日期范围闭合时长不一致');
      end ??= start + length;
    }
    if (record.closePosition !== undefined) {
      if (end !== undefined && Math.abs(record.closePosition - end) > 0.05) fail('广告日期结束标记位置不一致');
      end = record.closePosition;
    }
    addRange(ranges, start, end, 'daterange', position);
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
      if (previous.end - previous.start > 600) fail('合并后广告时段超过安全范围');
    } else merged.push({ ...range });
  }
  return merged.length ? { ranges: merged, supported: true, label: LABEL, source: SOURCE } : unsupported('未发现可靠广告时段；画面水印或普通切片无法自动识别');
}

export function createAdMarkers({ request = networkRequest, now = Date.now } = {}) {
  const cache = new Map(), flights = new Map(), waiters = [];
  let active = 0;
  const release = () => {
    const next = waiters.shift();
    if (next) next.grant(); else active--;
  };
  async function scan(url) {
    const deadline = Date.now() + TIMEOUT, responses = new Set(), visited = new Set();
    let expired = false, acquired = false, waiter, timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('广告清单检查超过8秒')); }, TIMEOUT); });
    const assertTime = () => { if (expired || Date.now() >= deadline) fail('广告清单检查超过8秒'); };
    const slot = new Promise(resolve => {
      const grant = () => { acquired = true; resolve(); };
      if (active < 2) { active++; grant(); } else { waiter = { grant }; waiters.push(waiter); }
    });
    const inspect = async () => {
      await slot; assertTime();
      for (let depth = 0; depth < 4; depth++) {
        assertTime(); url = validateUrl(url).href;
        if (visited.has(url)) fail('广告清单出现循环');
        visited.add(url);
        const response = await request(url, { timeout: Math.max(1, deadline - Date.now()) });
        response.on('error', () => {});
        if (expired || Date.now() >= deadline) { response.destroy(); assertTime(); }
        responses.add(response);
        if (response.statusCode !== 200) fail('广告清单返回 HTTP ' + response.statusCode + '，无法确认完整清单');
        const base = validateUrl(response.finalUrl || url).href;
        if (base !== url && visited.has(base)) fail('广告清单重定向出现循环');
        visited.add(base);
        const text = await readText(response, MAX_BYTES); assertTime();
        const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim());
        if (lines[0] !== '#EXTM3U') fail('返回内容不是 HLS 清单');
        if (!lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'))) return vodRanges(lines);
        const child = videoChild(lines);
        if (!child) fail('主清单没有可用视频分支');
        url = validateUrl(new URL(child, base).href).href;
      }
      fail('广告清单层级过多');
    };
    try { return await Promise.race([inspect(), timeout]); }
    finally {
      expired = true; clearTimeout(timer);
      const queued = waiters.indexOf(waiter); if (queued >= 0) waiters.splice(queued, 1);
      for (const response of responses) response.destroy();
      if (acquired) release();
    }
  }
  async function inspect(episode) {
    if (episode?.type !== 'hls' || episode.live === true || episode.isLive === true) return unsupported('仅点播 HLS 支持自动广告标记检查');
    let url;
    try { url = validateUrl(episode.url).href; } catch { return unsupported('广告清单链接不符合安全限制'); }
    const saved = cache.get(url);
    if (saved && saved.expires > now()) return structuredClone(saved.result);
    if (flights.has(url)) return structuredClone(await flights.get(url));
    if (flights.size >= 64) return unsupported('广告检查繁忙，请稍后重试');
    const flight = scan(url).catch(error => unsupported(String(error.message || '广告清单读取失败').slice(0, 160))).then(result => {
      cache.delete(url); cache.set(url, { result, expires: now() + (result.supported ? 60000 : 10000) });
      while (cache.size > 64) cache.delete(cache.keys().next().value);
      return result;
    }).finally(() => flights.delete(url));
    flights.set(url, flight);
    return structuredClone(await flight);
  }
  return { inspect };
}

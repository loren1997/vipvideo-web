import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as networkRequest, readText, validateUrl } from './network.mjs';
import { createPlayability } from './playability.mjs';

const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const PLAYLISTS_KEY = 'live-playlists-v1';
const PLAYLIST_AGE = 24 * 60 * 60_000;
const PLAYLIST_LIMIT = 5000;
const PLAYLIST_BYTES = 24 * 1024 * 1024;
const HEALTH_LIMIT = 40_000;
const HEALTH_AGE = 6 * 60 * 60_000;
const PROBE_INTERVAL = 5000;
const BUILTIN_URL = 'https://raw.githubusercontent.com/loren1997/vipvideo-web/main/web/live-presets.m3u';
const adultChannel = /成人|情色|伦理|三级|限制级|\badult\b|\bxxx\b/i;

function channelCategory(channel) {
  const name = channel.name || '', group = channel.group || '';
  if (/卫视|satellite/i.test(name + ' ' + group)) return '卫视';
  if (/CCTV[\s-]*14(?:\D|$)|少儿|卡通|kids|children/i.test(name + ' ' + group)) return '少儿';
  if (/CCTV[\s-]*5(?:\D|$)|体育|sports?/i.test(name + ' ' + group)) return '体育';
  if (/地方/.test(group) && !/^CCTV|^CGTN|^CETV/i.test(name)) return '地方';
  if (/CGTN|CETV|CCTV[\s-]*13(?:\D|$)|新闻|教育|news|education/i.test(name + ' ' + group)) return '新闻·教育';
  if (/^CCTV|央视|央视频道/i.test(name + ' ' + group)) return '央视';
  return /地方|local|省|市|县/i.test(group) ? '地方' : '其他';
}

function trustedEvidence(record) {
  const output = {}, value = record?.quality;
  if (value && ['manifest', 'bitstream'].includes(value.source) && Number.isSafeInteger(value.width) && value.width >= 32 && value.width <= 8192 && Number.isSafeInteger(value.height) && value.height >= 32 && value.height <= 4320) {
    output.quality = { width: value.width, height: value.height, source: value.source, ...(Number.isSafeInteger(value.bandwidth) && value.bandwidth > 0 && value.bandwidth <= 200_000_000 ? { bandwidth: value.bandwidth } : {}) };
  }
  if (typeof record?.playbackUrl === 'string' && record.playbackUrl.length <= 8192) try { output.playbackUrl = validateUrl(record.playbackUrl).href; } catch { /* 存储中的派生地址不能绕过公网限制。 */ }
  return output;
}

function fairChannels(channels) {
  const buckets = new Map(['卫视', '地方', '新闻·教育', '体育', '少儿', '央视', '其他'].map(category => [category, []]));
  for (const channel of channels) buckets.get(channelCategory(channel)).push(channel);
  const ordered = [], groups = [...buckets.values()];
  for (let row = 0; row < Math.max(0, ...groups.map(group => group.length)); row++) for (const group of groups) if (group[row]) ordered.push(group[row]);
  return ordered;
}

function safeCachedChannels(rows, source) {
  if (!Array.isArray(rows)) return [];
  const channels = [];
  for (const row of rows.slice(0, PLAYLIST_LIMIT)) {
    if (!row || typeof row !== 'object' || !/^[a-f0-9]{24}$/.test(row.id) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 ||
      typeof row.group !== 'string' || row.group.length > 100 || /[\u0000-\u001f]/.test(row.name + row.group) ||
      adultChannel.test(row.name + ' ' + row.group) || !Array.isArray(row.streams) || row.streams.length !== 1) continue;
    const stream = row.streams[0];
    if (!stream || stream.source !== source.id || typeof stream.url !== 'string' || stream.url.length > 8192) continue;
    try {
      const url = validateUrl(stream.url);
      let logo = '';
      try { if (typeof row.logo === 'string' && row.logo.length <= 2048 && row.logo) logo = validateUrl(row.logo).href; } catch { /* 不安全的标志不影响有效频道。 */ }
      channels.push({ id: row.id, name: row.name, group: row.group, logo,
        streams: [{ url: url.href, type: /\.mp4$/i.test(url.pathname) ? 'mp4' : 'hls', name: source.name, source: source.id }] });
    } catch { /* 持久化列表必须重新经过公网链接校验，不能作为任意 URL 代理。 */ }
  }
  return channels;
}

export function parsePlaylist(body, source) {
  if (!body.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) throw failure('直播源不是有效的 M3U 播放列表');
  const channels = [];
  let info;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const attributes = Object.fromEntries([...line.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
      let quoted = false, comma = -1;
      for (let i = 0; i < line.length; i++) { if (line[i] === '"') quoted = !quoted; else if (line[i] === ',' && !quoted) { comma = i; break; } }
      info = { attributes, name: (comma < 0 ? '' : line.slice(comma + 1)).trim() || attributes['tvg-name'] || '' };
      continue;
    }
    if (!line || line.startsWith('#') || !info) continue;
    const { attributes, name } = info; info = undefined;
    if (!name || name.length > 200 || adultChannel.test(`${name} ${attributes['group-title'] || ''}`)) continue;
    try {
      const url = validateUrl(new URL(line, source.url).href);
      const tvg = (attributes['tvg-id'] || '').replace(/@[^@]+$/, '');
      const cleanName = name.replace(/\s*(?:\((?:\d+p|\d+i|HD|SD)\)|\[(?:Geo-blocked|Not 24\/7)\])\s*$/gi, '').trim();
      if (!cleanName) continue;
      const group = String(attributes['group-title'] || (/^CCTV|^央视/i.test(tvg || name) ? '央视' : /CGTN|CETV/i.test(tvg || name) ? '新闻·教育' : /卫视|SatelliteTV/i.test(tvg || name) ? '卫视' : '地方及其他')).slice(0, 100);
      const cctv = /^CCTV[\s_-]*(\d{1,2})(\+|plus)?(?:[\s_-]*(?:综合|财经|综艺|中文国际|体育(?:赛事)?|电影|国防军事|军事|电视剧|纪录|科教|戏曲|社会与法|新闻|少儿|音乐|奥林匹克|农业农村|农业|高清|HD|FHD|UHD))*$/i.exec(cleanName);
      const identity = cctv && Number(cctv[1]) >= 1 && Number(cctv[1]) <= 17 ? `CCTV${Number(cctv[1])}${cctv[2] ? 'Plus' : ''}.cn` : tvg && !/^\d+$/.test(tvg) ? tvg : `${normalize(cleanName)}:${normalize(group)}`;
      const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
      let logo = '';
      try { if (attributes['tvg-logo']) logo = validateUrl(attributes['tvg-logo']).href; } catch { /* 无效标志不影响频道。 */ }
      channels.push({ id, name: cleanName, group, logo, streams: [{ url: url.href, type: /\.mp4$/i.test(url.pathname) ? 'mp4' : 'hls', name: source.name, source: source.id }] });
      if (channels.length >= 2000) break;
    } catch { /* 不支持 UDP/RTSP、内网和带认证信息的地址。 */ }
  }
  return channels;
}

export function createLive({ store, request = networkRequest, now = Date.now, logger = console,
  playability = createPlayability({ request, now }) } = {}) {
  let cache, probeJob, timer, started = false, stopping = false;
  let loading = 0; const loadWaiting = [];
  let health = { sources: {}, streams: {}, cursor: 0, lastProbe: 0 };
  const playlists = new Map();
  const localSeeds = new Map(); let seedText;
  let latestSources = new Map(), playlistsChanged = false;
  try {
    const text = store?.meta('live-health');
    if (text) {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024 * 1024) throw failure('直播探测记录过大');
      const saved = JSON.parse(text); health = { ...health, ...saved };
      health.cursor = Number.isSafeInteger(saved.cursor) && saved.cursor >= 0 ? saved.cursor : 0;
      health.lastProbe = Number.isFinite(saved.lastProbe) && saved.lastProbe >= 0 && saved.lastProbe <= now() ? saved.lastProbe : 0;
      health.streams = Object.fromEntries(Object.entries(saved.streams || {}).slice(0, HEALTH_LIMIT).flatMap(([url, record]) => {
        try {
          if (url.length > 8192 || !['ok', 'error'].includes(record?.status) || !Number.isFinite(record.checkedAt) || record.checkedAt < 0 || record.checkedAt > now()) return [];
          validateUrl(url);
          return [[url, { status: record.status, checkedAt: record.checkedAt, ...(record.error ? { error: String(record.error).slice(0, 300) } : {}), ...trustedEvidence(record) }]];
        } catch { return []; }
      }));
      if (!health.sources || typeof health.sources !== 'object' || Array.isArray(health.sources)) health.sources = {};
    }
  } catch (error) { logger.error('直播探测记录无法读取', error); }
  try {
    const saved = store?.meta(PLAYLISTS_KEY);
    if (saved) {
      if (typeof saved !== 'string' || Buffer.byteLength(saved) > 32 * 1024 * 1024) throw failure('保存的直播列表过大');
      const records = JSON.parse(saved);
      if (!records || typeof records !== 'object' || Array.isArray(records)) throw failure('保存的直播列表格式不正确');
      let remaining = PLAYLIST_LIMIT;
      for (const [id, record] of Object.entries(records).sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0))) {
        if (!remaining) { playlistsChanged = true; continue; }
        if (!record || typeof record.url !== 'string' || record.url.length > 8192 || !Number.isFinite(record.checkedAt) ||
          record.checkedAt > now() || now() - record.checkedAt > PLAYLIST_AGE) { playlistsChanged = true; continue; }
        try { validateUrl(record.url); } catch { playlistsChanged = true; continue; }
        const rows = Array.isArray(record.channels) ? record.channels.slice(0, remaining) : [];
        const channels = safeCachedChannels(rows, { id, name: '' });
        if (channels.length) playlists.set(id, { url: record.url, checkedAt: record.checkedAt, channels });
        remaining -= channels.length;
        if (!channels.length || channels.length !== record.channels?.length) playlistsChanged = true;
      }
    }
  } catch (error) { playlistsChanged = true; logger.error('最近可用直播列表无法读取', error); }
  function persistPlaylists() {
    let remaining = PLAYLIST_LIMIT, bytes = PLAYLIST_BYTES;
    for (const [id, record] of [...playlists].sort((a, b) => b[1].checkedAt - a[1].checkedAt)) {
      if (!remaining) { playlists.delete(id); continue; }
      const kept = [];
      bytes -= Buffer.byteLength(JSON.stringify({ id, url: record.url, checkedAt: record.checkedAt })) + 32;
      for (const channel of record.channels.slice(0, remaining)) {
        const size = Buffer.byteLength(JSON.stringify(channel)) + 2;
        if (size > bytes) continue;
        kept.push(channel); bytes -= size;
      }
      record.channels = kept;
      if (!kept.length) { playlists.delete(id); continue; }
      remaining -= record.channels.length;
    }
    store?.setMeta(PLAYLISTS_KEY, JSON.stringify(Object.fromEntries(playlists)));
    playlistsChanged = false;
  }
  function prunePlaylists(sources) {
    latestSources = new Map(sources.map(source => [source.id, source]));
    for (const [id, record] of playlists) {
      if (latestSources.get(id)?.url !== record.url || record.checkedAt > now() || now() - record.checkedAt > PLAYLIST_AGE) {
        playlists.delete(id); playlistsChanged = true; cache = undefined;
      }
    }
    for (const [id, record] of localSeeds) if (latestSources.get(id)?.url !== record.url) localSeeds.delete(id);
    if (playlistsChanged) persistPlaylists();
  }
  function currentSource(source) {
    const configured = store?.config ? store.config().liveSources?.find(item => item.id === source.id && item.enabled !== false) : latestSources.get(source.id);
    return configured?.url === source.url && latestSources.get(source.id)?.url === source.url;
  }
  const persist = () => store?.setMeta('live-health', JSON.stringify(health));
  function merge(results) {
    const channels = new Map(), failedSources = [];
    for (const result of results) {
      if (!result) continue;
      if (result.error) failedSources.push(result.error);
      for (const channel of result.channels) {
        if (!channels.has(channel.id)) channels.set(channel.id, { ...channel, streams: [] });
        const target = channels.get(channel.id);
        for (const stream of channel.streams) if (!target.streams.some(existing => existing.url === stream.url)) target.streams.push(stream);
        if (!target.logo && channel.logo) target.logo = channel.logo;
      }
    }
    return { channels: [...channels.values()], failedSources };
  }
  const view = result => {
    const copy = structuredClone(result);
    for (const channel of copy.channels) {
      channel.category = channelCategory(channel);
      for (const stream of channel.streams) {
        const record = health.streams[stream.url];
        stream.status = record && record.checkedAt <= now() && now() - record.checkedAt < HEALTH_AGE ? record.status : 'unknown';
        if (stream.status === 'ok') Object.assign(stream, trustedEvidence(record));
      }
      const candidates = channel.streams.map((stream, line) => ({ stream, line })).filter(({ stream }) => stream.status === 'ok');
      candidates.sort((a, b) => (b.stream.quality?.height || 0) - (a.stream.quality?.height || 0) || (b.stream.quality?.width || 0) - (a.stream.quality?.width || 0) || (b.stream.quality?.bandwidth || 0) - (a.stream.quality?.bandwidth || 0));
      if (candidates.length) channel.preferredLine = candidates[0].line;
    }
    const urls = [...new Set(copy.channels.flatMap(channel => channel.streams.map(stream => stream.url)))];
    Object.assign(copy, { probing: !!probeJob || !!cache?.promise, checkedStreams: urls.filter(url => health.streams[url]?.checkedAt <= now() && now() - health.streams[url].checkedAt < HEALTH_AGE).length, totalStreams: urls.length, lastProbe: health.lastProbe });
    copy.channels.sort((a, b) => Number(b.streams.some(stream => stream.status === 'ok')) - Number(a.streams.some(stream => stream.status === 'ok')));
    copy.channels = copy.channels.slice(0, PLAYLIST_LIMIT);
    return copy;
  };
  async function load(source) {
    await takeSlot();
    let response, timer, expired = false;
    try {
      if (stopping) throw failure('直播源刷新已停止');
      return await Promise.race([
        (async () => {
          response = await request(source.url, { timeout: 8000 });
          if (expired) { response.destroy(); throw failure('直播源请求超时'); }
          if (response.statusCode !== 200) throw failure(`直播源返回 HTTP ${response.statusCode}`);
          return parsePlaylist(await readText(response, 2 * 1024 * 1024), { ...source, url: response.finalUrl || source.url });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { expired = true; response?.destroy(); reject(failure('直播源请求超时')); }, 8000); }),
      ]);
    } finally { clearTimeout(timer); response?.destroy(); releaseSlot(); }
  }
  async function takeSlot() { if (loading >= 2) await new Promise(done => loadWaiting.push(done)); else loading++; }
  function releaseSlot() { const next = loadWaiting.shift(); if (next) next(); else loading--; }
  function schedule(delay = PROBE_INTERVAL) {
    if (!started || stopping) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await service.probe(store.config()); }
      catch (error) { logger.error('直播源自动探测失败', error); }
      finally {
        const pending = cache?.result?.channels.some(channel => channel.streams.some(stream => {
          const record = health.streams[stream.url];
          return !record || record.checkedAt > now() || now() - record.checkedAt >= (record.status === 'ok' ? 30 * 60_000 : 10 * 60_000);
        }));
        schedule(pending ? PROBE_INTERVAL : 60_000);
      }
    }, delay);
    timer.unref?.();
  }
  const service = {
    status(config) {
      return (config.liveSources || []).map(source => {
        const record = health.sources[source.id];
        return { ...source, ...(record?.url === source.url ? record : {}), status: source.enabled === false ? 'disabled' : record?.url === source.url ? record.status : 'unknown' };
      });
    },
    async list(config, { refresh = false } = {}) {
      const sources = (config.liveSources || []).filter(source => source.enabled !== false);
      prunePlaylists(sources);
      for (const source of sources) if (source.id === 'live-presets' && source.url === BUILTIN_URL && !localSeeds.has(source.id)) {
        try {
          seedText ??= readFile(new URL('../live-presets.m3u', import.meta.url), 'utf8');
          const channels = parsePlaylist(await seedText, source);
          if (currentSource(source)) localSeeds.set(source.id, { url: source.url, checkedAt: now(), channels, local: true });
        } catch (error) { logger.error('内置直播列表无法读取', error); }
      }
      const signature = JSON.stringify(sources);
      if (cache?.signature === signature && cache.result && !refresh) {
        if (cache.expires <= now() && !cache.promise) service.list(config, { refresh: true }).catch(error => logger.error('直播列表后台更新失败', error));
        if (started && !probeJob) schedule(0);
        return view(cache.result);
      }
      if (cache?.signature === signature && cache.promise) return view(await cache.promise);
      const previousResult = cache?.signature === signature ? cache.result : undefined;
      const saved = merge(sources.map(source => {
        const seed = localSeeds.get(source.id), record = playlists.get(source.id) || seed, state = health.sources[source.id];
        if (record?.url !== source.url) return { channels: [] };
        const stale = state?.url === source.url && state.status === 'error';
        const fallback = stale ? { stale: true, cachedAt: record.checkedAt } : {};
        return { channels: merge([{ channels: safeCachedChannels(record.channels, source) }, { channels: safeCachedChannels(seed?.channels || [], source) }]).channels.map(channel => ({ ...channel, streams: channel.streams.map(stream => ({ ...stream, ...fallback })) })), ...(stale ? { error: { source: source.id, name: source.name, error: state.error, ...fallback } } : {}) };
      }));
      const entry = { signature, expires: now() + 10 * 60_000 };
      if (previousResult || saved.channels.length) entry.result = previousResult || saved;
      cache = entry;
      entry.promise = (async () => {
        const results = new Array(sources.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(2, sources.length) }, async () => {
          while (!stopping && next < sources.length) {
            const index = next++, source = sources[index];
            const began = now();
            try {
              if (!currentSource(source)) continue;
              const channels = merge([{ channels: await load(source) }, { channels: localSeeds.get(source.id)?.channels || [] }]).channels;
              if (!currentSource(source)) continue;
              if (!channels.length) throw failure('直播列表没有可播放的公网 HTTP 频道');
              results[index] = { channels };
              health.sources[source.id] = { url: source.url, status: 'ok', checkedAt: now(), latencyMs: Math.max(0, now() - began), error: '' };
              if (currentSource(source)) {
                const saved = safeCachedChannels(channels.flatMap(channel => channel.streams.map(stream => ({ ...channel, streams: [stream] }))), source);
                if (saved.length) { playlists.set(source.id, { url: source.url, checkedAt: now(), channels: saved }); playlistsChanged = true; }
              }
            }
            catch (error) {
              if (!currentSource(source)) continue;
              const saved = playlists.get(source.id) || localSeeds.get(source.id);
              const stale = currentSource(source) && saved?.url === source.url && saved.checkedAt <= now() && now() - saved.checkedAt <= PLAYLIST_AGE;
              const message = error.message + (stale ? saved.local ? '；使用内置频道列表' : '；使用最近可用列表' : '');
              const fallback = stale ? { stale: true, cachedAt: saved.checkedAt } : {};
              results[index] = { channels: stale ? merge([{ channels: safeCachedChannels(saved.channels, source) }, { channels: safeCachedChannels(localSeeds.get(source.id)?.channels || [], source) }]).channels.map(channel => ({ ...channel,
                streams: channel.streams.map(stream => ({ ...stream, ...fallback })) })) : [],
                error: { source: source.id, name: source.name, error: message, ...fallback } };
              health.sources[source.id] = { url: source.url, status: 'error', checkedAt: now(), latencyMs: Math.max(0, now() - began), error: message, ...fallback };
              if (stale) entry.expires = Math.min(entry.expires, saved.checkedAt + PLAYLIST_AGE);
            }
          }
        }));
        if (playlistsChanged) persistPlaylists();
        persist();
        return merge(results);
      })().then(result => { entry.result = result; return result; }).finally(() => { delete entry.promise; });
      if (entry.result && !refresh) { entry.promise.catch(error => logger.error('直播列表后台更新失败', error)); return view(entry.result); }
      return view(await entry.promise);
    },
    async probe(config) {
      if (stopping) return;
      if (probeJob) return probeJob;
      probeJob = (async () => {
        const visible = await service.list(config), signature = JSON.stringify((config.liveSources || []).filter(source => source.enabled !== false));
        const result = cache?.signature === signature && cache.result ? cache.result : visible;
        const channels = fairChannels(result.channels), urls = [...new Set(channels.flatMap(channel => channel.streams.map(stream => stream.url)))];
        const unchanged = () => !stopping && (!store?.config || signature === JSON.stringify((store.config().liveSources || []).filter(source => source.enabled !== false)));
        const sample = [], selected = new Set(), pools = { normal: [], rescue: [], upgrade: [] };
        for (let walked = 0; walked < channels.length; walked++) {
          const index = (health.cursor + walked) % channels.length, channel = channels[index];
          const fresh = stream => { const record = health.streams[stream.url]; return record && record.checkedAt <= now() && now() - record.checkedAt < HEALTH_AGE; };
          const healthy = channel.streams.some(stream => fresh(stream) && health.streams[stream.url].status === 'ok');
          const unknown = channel.streams.find(stream => !health.streams[stream.url]) || channel.streams.find(stream => !fresh(stream));
          const due = channel.streams.find(stream => { const record = health.streams[stream.url]; return !record || record.checkedAt > now() || now() - record.checkedAt >= (record.status === 'ok' ? 30 * 60_000 : 10 * 60_000); });
          const candidate = unknown || due;
          if (!candidate) continue;
          const attempted = channel.streams.some(stream => !!health.streams[stream.url]);
          const pool = !healthy && unknown && attempted ? 'rescue' : healthy && unknown ? 'upgrade' : 'normal';
          pools[pool].push({ url: candidate.url, index });
        }
        let nextCursor = health.cursor;
        const take = (pool, quota) => { while (pools[pool].length && quota-- > 0 && sample.length < 20) { const candidate = pools[pool].shift(); if (selected.has(candidate.url)) { quota++; continue; } selected.add(candidate.url); sample.push(candidate.url); if (pool === 'normal' || !pools.normal.length) nextCursor = candidate.index + 1; } };
        take('rescue', 6); take('normal', 12); take('upgrade', 4);
        take('normal', 20); take('rescue', 20); take('upgrade', 20);
        if (!sample.length) return service.status(config);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(2, sample.length) }, async () => {
          while (unchanged() && next < sample.length) {
            const url = sample[next++], began = now(), before = health.streams[url];
            await takeSlot();
            try {
              if (!unchanged() || health.streams[url] !== before) continue;
              const result = await playability.check({ url, type: /\.mp4$/i.test(new URL(url).pathname) ? 'mp4' : 'hls' });
              if (!unchanged() || health.streams[url] !== before) continue;
              const playable = result.playable && result.live !== false;
              health.streams[url] = { status: playable ? 'ok' : 'error', checkedAt: result.checkedAt ?? now(), latencyMs: Math.max(0, now() - began),
                ...(playable ? trustedEvidence(result) : { error: result.live === false ? '这是结束的点播清单，不能作为实时频道' : result.error || '线路暂不可播放' }) };
            } catch (error) { if (unchanged() && health.streams[url] === before) health.streams[url] = { status: 'error', checkedAt: now(), error: error.message }; }
            finally { releaseSlot(); }
          }
        }));
        if (!unchanged()) return service.status(store?.config?.() || config);
        health.cursor = channels.length ? nextCursor % channels.length : 0;
        health.lastProbe = now();
        const currentUrls = new Set(urls);
        health.streams = Object.fromEntries(Object.entries(health.streams).filter(([url]) => currentUrls.has(url)).sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, HEALTH_LIMIT));
        health.sources = Object.fromEntries(Object.entries(health.sources).filter(([id]) => (config.liveSources || []).some(source => source.id === id)));
        persist();
        return service.status(config);
      })().finally(() => { probeJob = null; });
      return probeJob;
    },
    report(url, status) {
      playability.report?.({ url, type: /\.mp4$/i.test(new URL(url).pathname) ? 'mp4' : 'hls' }, status === 'ok');
      health.streams[url] = { status, checkedAt: now(), ...(status === 'ok' ? trustedEvidence(health.streams[url]) : {}) };
      health.streams = Object.fromEntries(Object.entries(health.streams).sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, HEALTH_LIMIT));
      persist();
    },
    start() {
      if (started || !store) return;
      started = true; stopping = false;
      schedule(0);
    },
    async stop() { started = false; stopping = true; clearTimeout(timer); await Promise.allSettled([probeJob, cache?.promise].filter(Boolean)); },
  };
  return service;
}

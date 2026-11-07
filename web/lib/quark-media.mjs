import { randomBytes, createHash } from 'node:crypto';
import { createMedia } from './media.mjs';
import { createTranscoder, supportsDolbyMapping } from './transcode.mjs';
import { request as networkRequest, validateUrl } from './network.mjs';

const failure = (message, status = 403) => Object.assign(new Error(message), { status });
const official = host => ['quark.cn', 'uc.cn'].some(domain => host === domain || host.endsWith(`.${domain}`));
const colors = new Set(['sdr', 'pq', 'hlg', 'dolby-vision', 'hdr', 'unknown', 'browser-default']);

export function createQuarkMedia({ quark, request = networkRequest, now = Date.now, visible = () => {}, probeColor } = {}) {
  const leases = new Map(), colorCache = new Map(), inspector = probeColor ? undefined : createTranscoder();
  probeColor ||= input => inspector.inspectColor(input);
  let generation = 0, queued = 0, colorTail = Promise.resolve();
  function valid(lease) { return lease.generation === generation && lease.expires > now() && leases.get(lease.id) === lease && lease.authorized(); }
  function close(lease) { lease.controller.abort(); for (const stream of lease.streams) stream.destroy(); }
  const colorKey = (lease, row, version) => createHash('sha256').update(JSON.stringify([generation, lease.assetId, version, lease.sourceColorSpace, row.type, row.url])).digest('hex');
  function cachedColor(lease, row, version) { const result = colorCache.get(colorKey(lease, row, version)); return result?.expires > now() ? result.proof : undefined; }
  function colorProof(value, unknown = false) {
    if (!value || !['sdr', 'pq', 'hlg', 'dolby-vision', 'browser-default', ...(unknown ? ['unknown'] : [])].includes(value.colorSpace)) throw failure('未能确认官方流的色彩信息', 409);
    const proof = { colorSpace: value.colorSpace };
    for (const key of ['codec', 'transfer', 'primaries', 'matrix', 'pixFmt']) if (value[key] !== undefined) proof[key] = typeof value[key] === 'string' && /^[a-z0-9_.-]{0,40}$/i.test(value[key]) ? value[key] : '';
    if (Number.isSafeInteger(value.dolbyVisionProfile) && value.dolbyVisionProfile >= 0 && value.dolbyVisionProfile <= 255) proof.dolbyVisionProfile = value.dolbyVisionProfile;
    if (Number.isSafeInteger(value.dolbyVisionCompatibilityId) && value.dolbyVisionCompatibilityId >= 0 && value.dolbyVisionCompatibilityId <= 15) proof.dolbyVisionCompatibilityId = value.dolbyVisionCompatibilityId;
    if (Number.isSafeInteger(value.bitDepth) && value.bitDepth > 0 && value.bitDepth <= 32) proof.bitDepth = value.bitDepth;
    for (const key of ['rpuPresent', 'blPresent', 'elPresent', 'rpuSeen']) if (typeof value[key] === 'boolean') proof[key] = value[key];
    return proof;
  }
  async function selectColor(lease, candidates, version) {
    if (!lease.dolbyRisk) return { episode: candidates[0] };
    const sdr = !lease.originalDolby && candidates.find(row => row.colorSpace === 'sdr');
    if (sdr) return { episode: sdr };
    if (queued >= 8) throw failure('官方流色彩检查繁忙，请稍后重试', 429);
    const timeout = lease.originalDolby ? 35000 : 15000, deadline = now() + timeout, controller = new AbortController();
    const abort = () => controller.abort();
    lease.controller.signal.addEventListener('abort', abort, { once: true });
    queued++; let timer, fallback, lastError;
    const timeoutError = () => lastError || Object.assign(failure(lease.originalDolby ? '杜比原片色彩检查超时，请重试兼容播放或选择其他版本' : '官方流色彩检查超时，已停止播放以避免偏色，请稍后重试', 504), { code: 'QUARK_COLOR_PROBE_TIMEOUT', colorProbe: { colorSpace: 'unknown' } });
    const job = colorTail.then(async () => {
      let lastProbe, dolby = lease.dolbyRisk, probes = 0;
      for (const row of candidates) {
        if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409);
        if (controller.signal.aborted) break;
        const originalDolby = lease.originalDolby && row.url === lease.episode.url;
        if (!originalDolby && (row.colorSpace === 'pq' || row.colorSpace === 'hlg')) { fallback ||= { episode: row }; continue; }
        if (row.colorSpace === 'dolby-vision' && !originalDolby) { dolby = true; continue; }
        let proof = cachedColor(lease, row, version);
        if (!proof && probes < 3 && now() < deadline) {
          probes++;
          try {
            // Raw 4K decoding on a limited CPU needs its own budget plus process cleanup time.
            const budget = originalDolby ? 30000 : 6000;
            proof = colorProof(await probeColor({ episode: row, sourceColorSpace: 'dolby-vision', owner: lease.owner || lease.id, valid: () => valid(lease), signal: controller.signal, mediaOverride: lease.media, proxyPath: lease.proxyPath, timeout: Math.min(budget, deadline - now()) }));
            if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409);
            if (controller.signal.aborted) break;
            const key = colorKey(lease, row, version); colorCache.delete(key); colorCache.set(key, { proof, expires: now() + 10 * 60_000 });
            while (colorCache.size > 64) colorCache.delete(colorCache.keys().next().value);
          } catch (error) {
            if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409);
            if (controller.signal.aborted) break;
            if (originalDolby && ['QUARK_COLOR_PROBE_TIMEOUT', 'QUARK_COLOR_PROBE_READ_FAILED', 'QUARK_COLOR_SOURCE_TIMEOUT', 'QUARK_COLOR_SOURCE_FAILED'].includes(error.code)) throw error;
            if (['QUARK_COLOR_PROBE_TIMEOUT', 'QUARK_COLOR_PROBE_READ_FAILED', 'QUARK_COLOR_SOURCE_TIMEOUT', 'QUARK_COLOR_SOURCE_FAILED'].includes(error.code)) lastError = error;
            lastProbe = colorProof(error.colorProbe || { colorSpace: 'unknown' }, true); continue;
          }
        }
        if (proof) lastProbe = proof;
        if (originalDolby) {
          if (proof?.colorSpace === 'dolby-vision' && supportsDolbyMapping(proof)) fallback ||= { episode: { ...row, colorSpace: 'dolby-vision' }, proof };
          continue;
        }
        if (proof?.colorSpace === 'sdr') return { episode: { ...row, colorSpace: 'sdr' }, proof };
        if (proof?.colorSpace === 'pq' || proof?.colorSpace === 'hlg') fallback ||= { episode: { ...row, colorSpace: proof.colorSpace }, proof };
        if (proof?.colorSpace === 'dolby-vision') dolby = true;
      }
      if (fallback) return fallback;
      if (lastError || controller.signal.aborted) throw timeoutError();
      throw Object.assign(failure(dolby ? lease.originalDolby ? '此杜比视界原片未确认可支持的单层 RPU 信息，请选择其他 SDR 版本' : '官方候选均未提供可确认的 SDR 线路，此杜比视界视频暂不能保证正确转换，请选择其他 SDR 版本' : '无法确认官方流的色彩信息，已停止播放以避免偏色，请稍后重试或选择其他 SDR 版本', 409), { code: dolby ? 'QUARK_DOLBY_UNSUPPORTED' : 'QUARK_COLOR_UNCONFIRMED', colorProbe: lastProbe || { colorSpace: dolby ? 'dolby-vision' : 'unknown' } });
    }).finally(() => { queued--; lease.controller.signal.removeEventListener('abort', abort); });
    colorTail = job.catch(() => {});
    try { return await Promise.race([job, new Promise((resolve, reject) => { timer = setTimeout(() => {
      controller.abort();
      if (!valid(lease)) reject(failure('夸克账号或播放会话已变更', 409));
      else if (fallback) resolve(fallback);
      else reject(timeoutError());
    }, timeout); })]); }
    finally { clearTimeout(timer); }
  }
  return {
    async playback(assetId, { valid: authorized = () => true, owner, quality, deferOriginalColor = false, signal } = {}) {
      if (quality !== undefined && ![720, 1080, 2160].includes(quality)) throw failure('兼容播放清晰度不正确', 400);
      if (!authorized()) throw failure('登录会话已结束，请重新登录', 401);
      const before = generation;
      if (signal?.aborted) throw failure('播放准备已取消', 499);
      const descriptor = await quark.playback(assetId, { valid: () => authorized() && !signal?.aborted });
      if (signal?.aborted) throw failure('播放准备已取消', 499);
      if (!authorized()) throw failure('登录会话已结束，请重新登录', 401);
      if (before !== generation) throw failure('夸克账号已变更，请重新播放', 409);
      let episode = descriptor.episode;
      if (!['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'].includes(episode?.type)) throw failure('夸克没有返回可支持的媒体', 502);
      if (episode.colorSpace !== undefined && !colors.has(episode.colorSpace)) throw failure('夸克播放色彩信息无效', 502);
      const originalUrl = validateUrl(episode.url).href;
      if (descriptor.variants !== undefined && (!Array.isArray(descriptor.variants) || descriptor.variants.length > 8)) throw failure('夸克播放清晰度列表无效', 502);
      const variants = new Map();
      for (const variant of descriptor.variants || []) {
        if (variant?.type !== 'hls' || !Number.isSafeInteger(variant.width) || variant.width < 16 || variant.width > 8192 ||
            !Number.isSafeInteger(variant.height) || variant.height < 16 || variant.height > 4320 ||
            !Number.isSafeInteger(variant.bandwidth) || variant.bandwidth < 1 || variant.bandwidth > 1000000000) throw failure('夸克播放清晰度无效', 502);
        const url = validateUrl(variant.url).href;
        if (variant.colorSpace !== undefined && !colors.has(variant.colorSpace)) throw failure('夸克播放色彩信息无效', 502);
        variants.set(url, { ...variant, url });
      }
      if (descriptor.qualityOptions !== undefined && (!Array.isArray(descriptor.qualityOptions) || descriptor.qualityOptions.length > 8)) throw failure('夸克官方清晰度列表无效', 502);
      const qualities = new Map();
      for (const row of descriptor.qualityOptions || []) {
        if (!row || !['hls', 'mp4'].includes(row.type) || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 80 || /[\r\n]/.test(row.label) ||
            row.colorSpace !== undefined && !colors.has(row.colorSpace) ||
            ['videoCodec', 'audioCodec'].some(key => row[key] !== undefined && (typeof row[key] !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(row[key]))) ||
            (row.width !== undefined || row.height !== undefined) && (!Number.isSafeInteger(row.width) || row.width < 16 || row.width > 8192 || !Number.isSafeInteger(row.height) || row.height < 16 || row.height > 4320)) throw failure('夸克官方清晰度无效', 502);
        const url = validateUrl(row.url).href;
        qualities.set(url, { url, type: row.type, label: row.label, colorSpace: row.colorSpace || 'unknown', ...(row.width !== undefined ? { width: row.width, height: row.height } : {}), ...(row.videoCodec ? { videoCodec: row.videoCodec } : {}), ...(row.audioCodec ? { audioCodec: row.audioCodec } : {}) });
      }
      if (descriptor.candidates !== undefined && (!Array.isArray(descriptor.candidates) || descriptor.candidates.length > 8)) throw failure('夸克播放候选列表无效', 502);
      const candidates = new Map([[validateUrl(episode.url).href, { ...episode, url: validateUrl(episode.url).href }]]);
      for (const row of descriptor.candidates || []) {
        if (!row || !['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'].includes(row.type) || row.colorSpace !== undefined && !colors.has(row.colorSpace)) throw failure('夸克播放候选无效', 502);
        const url = validateUrl(row.url).href;
        if (row.width !== undefined && (!Number.isSafeInteger(row.width) || row.width < 16 || row.width > 8192) || row.height !== undefined && (!Number.isSafeInteger(row.height) || row.height < 16 || row.height > 4320)) throw failure('夸克播放候选清晰度无效', 502);
        candidates.set(url, { ...row, url });
      }
      if (candidates.size > 8) throw failure('夸克播放候选列表过长', 502);
      if (descriptor.allowCookieOrigins !== undefined && (!Array.isArray(descriptor.allowCookieOrigins) || descriptor.allowCookieOrigins.length > 25)) throw failure('夸克账号凭证目标列表无效', 502);
      const cookieOrigins = new Set((descriptor.allowCookieOrigins || []).map(value => {
        const url = validateUrl(value);
        if (url.protocol !== 'https:' || !official(url.hostname) || url.href !== `${url.origin}/`) throw failure('夸克账号凭证目标无效', 502);
        return url.origin;
      }));
      const credentials = {};
      for (const [key, value] of Object.entries(descriptor.headers || {})) {
        const name = key.toLowerCase();
        if (!['cookie', 'user-agent', 'referer'].includes(name)) continue;
        if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 16384) throw failure('夸克播放凭证无效', 502);
        credentials[name] = value;
      }
      for (const [id, old] of leases) if (!valid(old)) {
        close(old);
        leases.delete(id);
      }
      if (leases.size >= 64) throw failure('夸克播放会话过多，请稍后重试', 429);
      const id = randomBytes(16).toString('hex'), proxyPath = `/api/quark/media/${id}`;
      const metadata = descriptor.metadata || {}, version = String(metadata.version || assetId).slice(0, 300), sourceColorSpace = metadata.sourceColorSpace ?? 'unknown';
      if (!colors.has(sourceColorSpace) || sourceColorSpace === 'browser-default') throw failure('夸克原文件色彩信息无效', 502);
      const dolbyRisk = sourceColorSpace === 'dolby-vision' || [...candidates.values(), ...variants.values(), ...qualities.values()].some(row => row.colorSpace === 'dolby-vision');
      const lease = { id, assetId, episode, sourceColorSpace, dolbyRisk, originalDolby: metadata.mode === 'download' && sourceColorSpace === 'dolby-vision', proxyPath, category: metadata.category, generation, authorized, owner, expires: now() + 2 * 60 * 60_000, streams: new Set(), controller: new AbortController() };
      lease.media = createMedia({ proxyPath, request: async (target, options = {}) => {
        if (!valid(lease)) throw failure('夸克播放会话已过期，请重新播放');
        const url = validateUrl(target), headers = {};
        for (const [key, value] of Object.entries(options.headers || {})) {
          if (['range', 'accept', 'accept-encoding'].includes(key.toLowerCase())) headers[key.toLowerCase()] = value;
        }
        if (credentials['user-agent']) headers['user-agent'] = credentials['user-agent'];
        if (url.protocol === 'https:' && official(url.hostname) && cookieOrigins.has(url.origin)) {
          if (credentials.cookie) headers.cookie = credentials.cookie;
          if (credentials.referer) headers.referer = credentials.referer;
        }
        let response;
        try {
          // Original-file CDNs may take longer to return their first range; the probe still has its total deadline.
          response = await request(url, { ...options, headers,
            timeout: lease.originalDolby && url.href === originalUrl ? 20000 : options.timeout,
            signal: options.signal ? AbortSignal.any([lease.controller.signal, options.signal]) : lease.controller.signal });
        } catch (error) {
          if (!valid(lease)) throw failure('夸克账号或播放会话已变更');
          throw error;
        }
        try {
          if (!valid(lease)) throw failure('夸克账号或播放会话已变更');
          visible(lease.category);
        } catch (error) { response.destroy(); throw error; }
        lease.streams.add(response);
        const finished = () => lease.streams.delete(response);
        response.once('close', finished); response.once('end', finished);
        return response;
      } });
      visible(lease.category); leases.set(id, lease); lease.valid = () => valid(lease);
      let selected;
      let colorCandidates = [...candidates.values()];
      if (quality !== undefined && !lease.dolbyRisk) {
        const sized = [...qualities.values()].filter(row => Number.isSafeInteger(row.height)).sort((a, b) => a.height - b.height);
        const chosen = sized.filter(row => row.height <= quality).at(-1) || sized[0];
        if (chosen) colorCandidates = [chosen, ...colorCandidates.filter(row => row.url !== chosen.url)];
      }
      const abort = () => close(lease); signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) throw failure('播放准备已取消', 499);
        selected = deferOriginalColor && lease.originalDolby
          ? { episode: { ...episode, colorSpace: 'dolby-vision' } }
          : await selectColor(lease, colorCandidates, version);
        if (signal?.aborted) throw failure('播放准备已取消', 499);
        if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409); visible(lease.category);
      } catch (error) { close(lease); leases.delete(id); throw error; }
      finally { signal?.removeEventListener('abort', abort); }
      episode = lease.episode = { ...selected.episode, sourceColorSpace: lease.dolbyRisk ? 'dolby-vision' : lease.sourceColorSpace }; lease.colorProbe = selected.proof;
      const result = lease.media.playback({ lines: [{ episodes: [episode] }] }, 0, 0);
      const qualityOptions = [], qualityUrls = new Map(); lease.qualityTokens = new Map();
      for (const row of qualities.values()) {
        if (lease.dolbyRisk && row.colorSpace !== 'sdr' && cachedColor(lease, row, version)?.colorSpace !== 'sdr') continue;
        const playback = lease.media.playback({ lines: [{ episodes: [row] }] }, 0, 0), id = `q${qualityOptions.length}`;
        // Keep upstream URLs inside this lease; the browser only receives opaque local selectors.
        lease.qualityTokens.set(id, new URL(playback.proxyUrl, 'http://localhost').searchParams.get('token'));
        const option = { id, label: row.label, type: row.type, url: `${proxyPath}?token=${id}`, colorSpace: lease.dolbyRisk ? 'sdr' : row.colorSpace, ...(row.width !== undefined ? { width: row.width, height: row.height } : {}), ...(row.videoCodec ? { videoCodec: row.videoCodec } : {}), ...(row.audioCodec ? { audioCodec: row.audioCodec } : {}) };
        qualityOptions.push(option); qualityUrls.set(row.url, option.url);
        if (row.url === episode.url && row.type === episode.type) result.proxyUrl = option.url;
      }
      const sdrVariants = episode.colorSpace === 'sdr' ? [...variants.values()].filter(row => row.colorSpace === 'sdr' || cachedColor(lease, row, version)?.colorSpace === 'sdr') : [];
      if (quality === undefined && sdrVariants.length > 1) {
        lease.master = '#EXTM3U\n#EXT-X-VERSION:3\n' + sdrVariants.map(variant => {
          const playback = lease.media.playback({ lines: [{ episodes: [variant] }] }, 0, 0);
          return `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}\n${qualityUrls.get(variant.url) || playback.proxyUrl}\n`;
        }).join('');
        result.proxyUrl = `${proxyPath}?token=master`;
      }
      lease.response = { assetId, url: result.proxyUrl, type: episode.type,
        ...(qualityOptions.length ? { qualityOptions } : {}),
        name: String(metadata.name || '').slice(0, 300), size: Number(metadata.size) || 0,
        version, requiresCompatibility: lease.dolbyRisk && !['sdr', 'browser-default'].includes(episode.colorSpace) || !['hls', 'mp4', 'webm'].includes(episode.type),
        ...(episode.colorSpace ? { colorSpace: episode.colorSpace } : {}),
        ...(lease.master ? { quality: '自动画质' } : Number.isSafeInteger(episode.width) && Number.isSafeInteger(episode.height) ? { quality: `${episode.width}×${episode.height}` } : metadata.quality ? { quality: Number.isSafeInteger(metadata.quality.width) && Number.isSafeInteger(metadata.quality.height)
          ? `${metadata.quality.width}×${metadata.quality.height}` : String(metadata.quality).slice(0, 100) } : {}) };
      return lease;
    },
    async serve(req, res, id, token) {
      const lease = leases.get(id);
      if (!lease || !valid(lease)) throw failure('夸克播放会话已过期，请重新播放');
      visible(lease.category);
      if (lease.originalDolby) throw failure('杜比原片需要兼容播放，不能直接输出', 409);
      if (token === 'master' && lease.master) {
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) throw failure('不支持的媒体请求方法', 400);
        res.statusCode = 200;
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(lease.master));
        res.end(req.method === 'HEAD' ? undefined : lease.master);
        return;
      }
      return lease.media.serve(req, res, lease.qualityTokens?.get(token) || token);
    },
    invalidate() {
      generation++;
      colorCache.clear();
      for (const lease of leases.values()) close(lease);
      leases.clear();
    },
    revoke(owner) {
      for (const [id, lease] of leases) if (lease.owner === owner) {
        close(lease);
        leases.delete(id);
      }
    },
  };
}

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
    const sdr = !lease.originalDolby && candidates.find(row => row.colorSpace === 'sdr');
    if (sdr) return { episode: sdr };
    if (queued >= 8) throw failure('官方流色彩检查繁忙，请稍后重试', 429);
    const deadline = now() + 6000; queued++; let timer;
    const job = colorTail.then(async () => {
      let fallback, lastProbe, dolby = lease.sourceColorSpace === 'dolby-vision', probes = 0;
      for (const row of candidates) {
        if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409);
        const originalDolby = lease.originalDolby && row.url === lease.episode.url;
        if (!originalDolby && (row.colorSpace === 'pq' || row.colorSpace === 'hlg')) { fallback ||= { episode: row }; continue; }
        if (row.colorSpace === 'dolby-vision' && !originalDolby) { dolby = true; continue; }
        let proof = cachedColor(lease, row, version);
        if (!proof && probes < 3 && now() < deadline) {
          probes++;
          try {
            proof = colorProof(await probeColor({ episode: row, sourceColorSpace: lease.sourceColorSpace, owner: lease.owner || lease.id, valid: () => valid(lease), signal: lease.controller.signal, mediaOverride: lease.media, proxyPath: lease.proxyPath, timeout: Math.min(originalDolby ? 5500 : 3000, deadline - now()) }));
            if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409);
            const key = colorKey(lease, row, version); colorCache.delete(key); colorCache.set(key, { proof, expires: now() + 10 * 60_000 });
            while (colorCache.size > 64) colorCache.delete(colorCache.keys().next().value);
          } catch (error) {
            if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409);
            if (originalDolby && ['QUARK_COLOR_PROBE_TIMEOUT', 'QUARK_COLOR_PROBE_READ_FAILED'].includes(error.code)) throw error;
            lastProbe = colorProof(error.colorProbe || { colorSpace: 'unknown' }, true); continue;
          }
        }
        if (proof) lastProbe = proof;
        if (originalDolby) {
          if (proof?.colorSpace === 'dolby-vision' && supportsDolbyMapping(proof)) fallback ||= { episode: { ...row, colorSpace: 'dolby-vision' }, proof };
          continue;
        }
        if (proof?.colorSpace === 'sdr') return { episode: { ...row, colorSpace: 'sdr' }, proof };
        if (proof?.colorSpace === 'browser-default' && ['unknown', 'sdr'].includes(lease.sourceColorSpace)) fallback ||= { episode: { ...row, colorSpace: 'browser-default' }, proof };
        if (proof?.colorSpace === 'pq' || proof?.colorSpace === 'hlg') fallback ||= { episode: { ...row, colorSpace: proof.colorSpace }, proof };
        if (proof?.colorSpace === 'dolby-vision') dolby = true;
      }
      if (fallback) return fallback;
      throw Object.assign(failure(dolby ? lease.originalDolby ? '此杜比视界原片未确认可支持的单层 RPU 信息，请选择其他 SDR 版本' : '官方候选均未提供可确认的 SDR 线路，此杜比视界视频暂不能保证正确转换，请选择其他 SDR 版本' : '无法确认官方流的色彩信息，已停止播放以避免偏色，请稍后重试或选择其他 SDR 版本', 409), { code: dolby ? 'QUARK_DOLBY_UNSUPPORTED' : 'QUARK_COLOR_UNCONFIRMED', colorProbe: lastProbe || { colorSpace: dolby ? 'dolby-vision' : 'unknown' } });
    }).finally(() => { queued--; });
    colorTail = job.catch(() => {});
    try { return await Promise.race([job, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('官方流色彩检查超时，已停止播放以避免偏色，请稍后重试', 504)), 6000); })]); }
    finally { clearTimeout(timer); }
  }
  return {
    async playback(assetId, { valid: authorized = () => true, owner } = {}) {
      if (!authorized()) throw failure('登录会话已结束，请重新登录', 401);
      const before = generation;
      const descriptor = await quark.playback(assetId, { valid: authorized });
      if (!authorized()) throw failure('登录会话已结束，请重新登录', 401);
      if (before !== generation) throw failure('夸克账号已变更，请重新播放', 409);
      let episode = descriptor.episode;
      if (!['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'].includes(episode?.type)) throw failure('夸克没有返回可支持的媒体', 502);
      if (episode.colorSpace !== undefined && !colors.has(episode.colorSpace)) throw failure('夸克播放色彩信息无效', 502);
      validateUrl(episode.url);
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
      if (descriptor.candidates !== undefined && (!Array.isArray(descriptor.candidates) || descriptor.candidates.length > 8)) throw failure('夸克播放候选列表无效', 502);
      const candidates = new Map([[validateUrl(episode.url).href, { ...episode, url: validateUrl(episode.url).href }]]);
      for (const row of descriptor.candidates || []) {
        if (!row || !['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'].includes(row.type) || row.colorSpace !== undefined && !colors.has(row.colorSpace)) throw failure('夸克播放候选无效', 502);
        const url = validateUrl(row.url).href;
        if (row.width !== undefined && (!Number.isSafeInteger(row.width) || row.width < 16 || row.width > 8192) || row.height !== undefined && (!Number.isSafeInteger(row.height) || row.height < 16 || row.height > 4320)) throw failure('夸克播放候选清晰度无效', 502);
        candidates.set(url, { ...row, url });
      }
      if (candidates.size > 8) throw failure('夸克播放候选列表过长', 502);
      const cookieOrigins = new Set((descriptor.allowCookieOrigins || []).slice(0, 10).map(value => {
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
      const lease = { id, assetId, episode, sourceColorSpace, originalDolby: metadata.mode === 'download' && sourceColorSpace === 'dolby-vision', proxyPath, category: metadata.category, generation, authorized, owner, expires: now() + 2 * 60 * 60_000, streams: new Set(), controller: new AbortController() };
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
          response = await request(url, { ...options, headers,
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
      try { selected = await selectColor(lease, [...candidates.values()], version); if (!valid(lease)) throw failure('夸克账号或播放会话已变更', 409); visible(lease.category); }
      catch (error) { close(lease); leases.delete(id); throw error; }
      episode = lease.episode = selected.episode; lease.colorProbe = selected.proof;
      const result = lease.media.playback({ lines: [{ episodes: [episode] }] }, 0, 0);
      const sdrVariants = episode.colorSpace === 'sdr' ? [...variants.values()].filter(row => row.colorSpace === 'sdr' || cachedColor(lease, row, version)?.colorSpace === 'sdr') : [];
      if (sdrVariants.length > 1) {
        lease.master = '#EXTM3U\n#EXT-X-VERSION:3\n' + sdrVariants.map(variant => {
          const playback = lease.media.playback({ lines: [{ episodes: [variant] }] }, 0, 0);
          return `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}\n${playback.proxyUrl}\n`;
        }).join('');
        result.proxyUrl = `${proxyPath}?token=master`;
      }
      lease.response = { assetId, url: result.proxyUrl, type: episode.type,
        name: String(metadata.name || '').slice(0, 300), size: Number(metadata.size) || 0,
        version, requiresCompatibility: !['sdr', 'browser-default'].includes(episode.colorSpace) || !['hls', 'mp4', 'webm'].includes(episode.type),
        ...(episode.colorSpace ? { colorSpace: episode.colorSpace } : {}),
        ...(lease.master ? { quality: '自动画质' } : Number.isSafeInteger(episode.width) && Number.isSafeInteger(episode.height) ? { quality: `${episode.width}×${episode.height}` } : metadata.quality ? { quality: Number.isSafeInteger(metadata.quality.width) && Number.isSafeInteger(metadata.quality.height)
          ? `${metadata.quality.width}×${metadata.quality.height}` : String(metadata.quality).slice(0, 100) } : {}) };
      return lease;
    },
    async serve(req, res, id, token) {
      const lease = leases.get(id);
      if (!lease || !valid(lease)) throw failure('夸克播放会话已过期，请重新播放');
      visible(lease.category);
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
      return lease.media.serve(req, res, token);
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

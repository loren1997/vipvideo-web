import { randomBytes } from 'node:crypto';
import { createMedia } from './media.mjs';
import { request as networkRequest, validateUrl } from './network.mjs';

const failure = (message, status = 403) => Object.assign(new Error(message), { status });
const official = host => ['quark.cn', 'uc.cn'].some(domain => host === domain || host.endsWith(`.${domain}`));

export function createQuarkMedia({ quark, request = networkRequest, now = Date.now, visible = () => {} }) {
  const leases = new Map();
  let generation = 0;
  function valid(lease) { return lease.generation === generation && lease.expires > now() && leases.get(lease.id) === lease && lease.authorized(); }
  return {
    async playback(assetId, { valid: authorized = () => true, owner } = {}) {
      if (!authorized()) throw failure('登录会话已结束，请重新登录', 401);
      const before = generation;
      const descriptor = await quark.playback(assetId);
      if (!authorized()) throw failure('登录会话已结束，请重新登录', 401);
      if (before !== generation) throw failure('夸克账号已变更，请重新播放', 409);
      const episode = descriptor.episode;
      if (!['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'].includes(episode?.type)) throw failure('夸克没有返回可支持的媒体', 502);
      validateUrl(episode.url);
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
        for (const stream of old.streams) stream.destroy();
        leases.delete(id);
      }
      if (leases.size >= 64) throw failure('夸克播放会话过多，请稍后重试', 429);
      const id = randomBytes(16).toString('hex'), proxyPath = `/api/quark/media/${id}`;
      const lease = { id, assetId, episode, proxyPath, generation, authorized, owner, expires: now() + 2 * 60 * 60_000, streams: new Set() };
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
        const response = await request(url, { ...options, headers });
        try {
          if (!valid(lease)) throw failure('夸克账号或播放会话已变更');
          visible(lease.category);
        } catch (error) { response.destroy(); throw error; }
        lease.streams.add(response);
        const finished = () => lease.streams.delete(response);
        response.once('close', finished); response.once('end', finished);
        return response;
      } });
      const result = lease.media.playback({ lines: [{ episodes: [episode] }] }, 0, 0), metadata = descriptor.metadata || {};
      lease.response = { assetId, url: result.proxyUrl, type: episode.type,
        name: String(metadata.name || '').slice(0, 300), size: Number(metadata.size) || 0,
        version: String(metadata.version || assetId).slice(0, 300), requiresCompatibility: metadata.requiresCompatibility === true,
        ...(metadata.quality ? { quality: Number.isSafeInteger(metadata.quality.width) && Number.isSafeInteger(metadata.quality.height)
          ? `${metadata.quality.width}×${metadata.quality.height}` : String(metadata.quality).slice(0, 100) } : {}) };
      lease.category = metadata.category;
      visible(lease.category);
      leases.set(id, lease);
      lease.valid = () => valid(lease);
      return lease;
    },
    async serve(req, res, id, token) {
      const lease = leases.get(id);
      if (!lease || !valid(lease)) throw failure('夸克播放会话已过期，请重新播放');
      visible(lease.category);
      return lease.media.serve(req, res, token);
    },
    invalidate() {
      generation++;
      for (const lease of leases.values()) for (const stream of lease.streams) stream.destroy();
      leases.clear();
    },
    revoke(owner) {
      for (const [id, lease] of leases) if (lease.owner === owner) {
        for (const stream of lease.streams) stream.destroy();
        leases.delete(id);
      }
    },
  };
}

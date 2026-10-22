import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './lib/store.mjs';
import { validateConfig, importConfig, validateRecord, validatePlayerPreferences, text, badRequest } from './lib/config.mjs';
import { createCatalog } from './lib/catalog.mjs';
import { createMedia } from './lib/media.mjs';
import { createSourceMaintenance } from './lib/source-maintenance.mjs';
import { createLive } from './lib/live.mjs';
import { createRatings } from './lib/ratings.mjs';
import { createDanmaku } from './lib/danmaku.mjs';
import { createPlayability } from './lib/playability.mjs';
import { createSourceDiscovery } from './lib/source-discovery.mjs';
import { repairImport } from './lib/import-repair.mjs';
import { createTranscoder } from './lib/transcode.mjs';
import { createAdMarkers } from './lib/ad-markers.mjs';
import { createQuark } from './lib/quark.mjs';
import { createQuarkCatalog } from './lib/quark-catalog.mjs';
import { createQuarkPosters } from './lib/quark-posters.mjs';
import { createQuarkSearchPool } from './lib/quark-search-pool.mjs';
import { createQuarkBrowserSearch } from './lib/quark-browser-client.mjs';
import { createQuarkTelegramSearch } from './lib/quark-telegram-search.mjs';
import { createQuarkChannelCatalog } from './lib/quark-channel-catalog.mjs';
import { createQuarkMedia } from './lib/quark-media.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const defaults = JSON.parse(readFileSync(resolve(root, 'defaults.json'), 'utf8'));
const WEEK = 7 * 24 * 3600;
const gzip = promisify(gzipCallback);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw badRequest('请使用 application/json');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw Object.assign(new Error('请求内容不能超过 1 MB'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw badRequest('JSON 格式不正确'); }
}

function tokenFrom(req) {
  return /(?:^|;\s*)vipvideo_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
}

export function createApp({ password = process.env.APP_PASSWORD, dataDir = process.env.DATA_DIR ?? resolve(root, 'data'),
  catalog = createCatalog(), media = createMedia(), initialConfig = defaults, cookieSecure = process.env.COOKIE_SECURE === 'true',
  logger = console, maintenance, live, ratings, danmaku, playability, discovery, transcoder, adMarkers, quark, quarkMedia, quarkSearchPool, quarkCatalog, quarkPosters } = {}) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('APP_PASSWORD 必须设置，且长度为 8–1024 个字符');
  const initial = validateConfig(initialConfig);
  const store = createStore(dataDir, initial);
  if (!store.meta('builtin-sources-v1')) {
    const current = store.config();
    if (!current.sources.length && initial.sources.length) store.setConfig({ ...current, sources: initial.sources });
    store.setMeta('builtin-sources-v1', '1');
  }
  if (!store.meta('source-services-v1')) {
    const current = store.config();
    store.setConfig(validateConfig({ ...current, subscriptions: current.subscriptions ?? initial.subscriptions, liveSources: current.liveSources ?? initial.liveSources }));
    store.setMeta('source-services-v1', '1');
  }
  const playabilityService = playability ?? createPlayability();
  const sourceService = maintenance ?? createSourceMaintenance({ store, catalog, initialSources: initial.sources, logger, playability: playabilityService });
  const availableConfig = snapshot => sourceService.availableConfig?.(snapshot) ?? snapshot;
  const adService = adMarkers ?? createAdMarkers();
  const discoveryService = discovery ?? createSourceDiscovery({ store, maintenance: sourceService, playability: playabilityService, logger });
  const liveService = live ?? createLive({ store, logger, playability: playabilityService });
  const ratingService = ratings ?? createRatings({ store });
  const danmakuService = danmaku ?? createDanmaku({ store });
  const transcodeService = transcoder ?? createTranscoder({ media, logger });
  const searchPool = quarkSearchPool ?? createQuarkSearchPool({ store, telegramSearch: createQuarkTelegramSearch({ resolveChannels: createQuarkChannelCatalog({ store }).resolve }), ...(process.env.QUARK_BROWSER_URL === 'http://quark-browser:3020' ? { renderSearch: createQuarkBrowserSearch() } : {}) });
  const quarkService = quark ?? createQuark({ store, dataDir, searchRequest: searchPool.request, defaultSearchApi: process.env.QUARK_SEARCH_API || '' });
  const cloudCatalog = quarkCatalog ?? createQuarkCatalog({ store });
  const cloudPosters = quarkPosters ?? createQuarkPosters({ catalog: cloudCatalog });
  const cloudMedia = quarkMedia ?? createQuarkMedia({ quark: quarkService, visible: category => ensureVisible(category), probeColor: input => transcodeService.inspectColor(input) });
  const salt = store.meta('password-salt') ?? randomBytes(16).toString('hex');
  const passwordHash = scryptSync(password, salt, 32);
  if (store.meta('password-hash') !== passwordHash.toString('hex')) store.clearSessions();
  store.setMeta('password-salt', salt);
  store.setMeta('password-hash', passwordHash.toString('hex'));
  const attempts = new Map();
  const publicDir = resolve(root, 'public');
  const staticFiles = new Map();
  const cookie = (value, age) => `vipvideo_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${cookieSecure ? '; Secure' : ''}`;
  const visibleEntries = (kind) => {
    const rows = store.list(kind);
    return store.config().showAdult === true ? rows : rows.filter(row => row.category !== 'adult');
  };
  const ensureVisible = (category) => {
    if (category === 'adult' && store.config().showAdult !== true) {
      throw Object.assign(new Error('三级内容已隐藏，请先在设置中开启显示'), { status: 403 });
    }
  };
  const requireSession = owner => {
    if (!store.authenticated(owner)) throw Object.assign(new Error('登录会话已结束，请重新登录'), { status: 401 });
  };
  const cloudSelection = async (input, owner) => {
    requireSession(owner);
    const snapshot = store.config(), line = Number(input?.line ?? 0), episode = Number(input?.episode ?? 0);
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(episode) || episode < 0) throw badRequest('请选择有效的剧集');
    if (input?.source === 'quark-library') {
      const detail = await cloudCatalog.detail(text(input.id, '豆瓣影片标识', 16));
      const valid = () => { requireSession(owner); ensureVisible(detail.category); return true; };
      valid();
      if (!detail.lines[line]?.episodes[episode]) throw badRequest('请选择有效的影片');
      return { detail, options: { line, episode }, valid };
    }
    const source = snapshot.sources.find(item => item.id === input?.source && item.enabled !== false);
    if (!source) throw badRequest('请选择启用的影视源');
    const detail = await catalog.detail(availableConfig(snapshot), source.id, text(input?.id, '影片标识', 200));
    ensureVisible(detail.category);
    if (!detail.lines[line]?.episodes[episode]) throw badRequest('请选择有效的剧集');
    const valid = () => {
      requireSession(owner);
      ensureVisible(detail.category);
      if (!availableConfig(store.config()).sources.some(item => item.id === source.id && item.api === source.api && item.enabled !== false)) {
        throw Object.assign(new Error('影视源已变更，请刷新后重试'), { status: 409 });
      }
      return true;
    };
    valid(); return { detail, options: { line, episode }, valid };
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: data:; media-src 'self' blob: http: https:; connect-src 'self' http: https:; worker-src 'self' blob:; frame-src http: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      if (path === '/health' && method === 'GET') return json(res, 200, { status: 'ok' });
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        if (['POST', 'PUT', 'DELETE'].includes(method)) {
          const origin = req.headers.origin;
          let originHost;
          try { originHost = origin ? new URL(origin).host : undefined; } catch { throw badRequest('Origin 格式不正确'); }
          if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && originHost !== req.headers.host)) {
            return json(res, 403, { error: '不允许跨站修改数据' });
          }
        }
        const token = tokenFrom(req);
        const authenticated = !!token && store.authenticated(hashToken(token));
        if (path === '/api/auth' && method === 'GET') return json(res, 200, { authenticated });
        if (path === '/api/auth/login' && method === 'POST') {
          const ip = req.socket.remoteAddress;
          const now = Date.now();
          for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
          const attempt = attempts.get(ip) ?? { count: 0, until: now + 60_000 };
          if (attempt.count >= 5) { res.setHeader('Retry-After', '60'); return json(res, 429, { error: '尝试次数过多，请一分钟后重试' }); }
          const body = await readBody(req);
          const candidate = typeof body?.password === 'string' && body.password.length <= 1024 ? body.password : '';
          const provided = scryptSync(candidate, salt, 32);
          if (!timingSafeEqual(passwordHash, provided)) {
            attempt.count += 1; attempts.set(ip, attempt);
            return json(res, 401, { error: '访问密码不正确' });
          }
          attempts.delete(ip);
          const newToken = randomBytes(32).toString('base64url');
          store.session(hashToken(newToken), now + WEEK * 1000);
          res.setHeader('Set-Cookie', cookie(newToken, WEEK));
          return json(res, 200, { authenticated: true });
        }
        if (!authenticated) return json(res, 401, { error: '请先登录' });
        if (path === '/api/auth/logout' && method === 'POST') {
          await readBody(req); store.logout(hashToken(token)); cloudMedia.revoke?.(hashToken(token));
          res.setHeader('Set-Cookie', cookie('', 0));
          return json(res, 200, { authenticated: false });
        }
        if (path === '/api/config' && method === 'GET') return json(res, 200, store.config());
        if (path === '/api/config' && method === 'PUT') return json(res, 200, store.setConfig(validateConfig(await readBody(req))));
        if (path === '/api/config/import' && method === 'POST') {
          const body = await readBody(req);
          const { config, warnings } = repairImport(body?.config);
          const result = store.setConfig(importConfig(store.config(), config));
          return json(res, 200, { ...result, ...(warnings.length ? { importWarnings: warnings } : {}) });
        }
        if (path === '/api/config/presets' && method === 'GET') {
          return json(res, 200, { api_site: Object.fromEntries(initial.sources.map(({ id, name, api }) => [id, { name, api }])) });
        }
        if (path === '/api/quark/settings' && method === 'GET') return json(res, 200, { ...await quarkService.settings(), searchPool: searchPool.status() });
        if (path === '/api/quark/library' && method === 'GET') {
          const result = await cloudCatalog.browse(Object.fromEntries(['category', 'genre', 'year', 'sort', 'page'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])));
          requireSession(hashToken(token));
          return json(res, 200, result);
        }
        if (path === '/api/quark/library/detail' && method === 'GET') {
          const detail = await cloudCatalog.detail(text(url.searchParams.get('id'), '豆瓣影片标识', 16));
          requireSession(hashToken(token)); ensureVisible(detail.category);
          return json(res, 200, detail);
        }
        if (path === '/api/quark/library/poster' && ['GET', 'HEAD'].includes(method)) {
          if ([...url.searchParams.keys()].some(key => key !== 'id')) throw badRequest('海报请求只能使用影片标识');
          const controller = new AbortController(), cancel = () => controller.abort(Object.assign(new Error('海报请求已取消'), { status: 499 }));
          res.once('close', cancel);
          try {
            const poster = await cloudPosters.get(text(url.searchParams.get('id'), '豆瓣影片标识', 16), { signal: controller.signal });
            requireSession(hashToken(token));
            res.setHeader('Cache-Control', 'private, max-age=3600');
            res.setHeader('ETag', poster.etag);
            if (req.headers['if-none-match'] === poster.etag) { res.writeHead(304); return res.end(); }
            res.writeHead(200, { 'Content-Type': poster.type, 'Content-Length': poster.body.length });
            return res.end(method === 'HEAD' ? undefined : poster.body);
          } catch (error) { if (!res.destroyed || error !== controller.signal.reason) throw error; }
          finally { res.removeListener('close', cancel); }
          return;
        }
        if (path === '/api/quark/settings' && method === 'PUT') {
          const result = await quarkService.configure(await readBody(req)); cloudMedia.invalidate();
          return json(res, 200, { ...result, searchPool: searchPool.status() });
        }
        if (path === '/api/quark/account' && method === 'DELETE') {
          await readBody(req); const result = await quarkService.clearAccount(); cloudMedia.invalidate();
          return json(res, 200, { ...result, searchPool: searchPool.status() });
        }
        if (path === '/api/quark/cleanup' && method === 'POST') {
          await readBody(req); return json(res, 200, await quarkService.cleanup());
        }
        if (path === '/api/quark/folder/repair' && method === 'POST') {
          const input = await readBody(req);
          if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw badRequest('恢复目录请求应为空对象');
          const valid = () => { requireSession(hashToken(token)); return true; };
          valid(); const result = await quarkService.repairFolder({ valid }); valid(); cloudMedia.invalidate();
          return json(res, 200, { ...result, searchPool: searchPool.status() });
        }
        if (['/api/quark/resources', '/api/quark/files'].includes(path) && method === 'GET') {
          const input = Object.fromEntries(url.searchParams), selected = await cloudSelection(input, hashToken(token));
          if (input.web !== undefined && input.web !== '1') throw badRequest('公开网页搜索选项无效');
          if (input.poll !== undefined && input.poll !== '1') throw badRequest('搜索状态查询选项无效');
          const result = path.endsWith('/files')
            ? await quarkService.files(selected.detail, { ...selected.options, valid: selected.valid, shareId: text(input.shareId, '夸克分享标识', 200) })
            : await quarkService.resources(selected.detail, { ...selected.options, ...(input.web === '1' ? { webSearch: true } : {}), ...(input.poll === '1' ? { poll: true } : {}) });
          selected.valid(); return json(res, 200, result);
        }
        if (path === '/api/quark/prepare' && method === 'POST') {
          const input = await readBody(req), selected = await cloudSelection(input, hashToken(token));
          if (input.auto !== undefined && typeof input.auto !== 'boolean') throw badRequest('自动转存选项无效');
          if (input.source === 'quark-library' && (input.auto === true || !input.fileId || !input.shareId)) throw badRequest('请选择分享和单个视频文件后手动转存');
          const options = { ...selected.options, valid: selected.valid, ...(input.auto === undefined ? {} : { auto: input.auto }),
            ...(input.shareId === undefined ? {} : { shareId: text(input.shareId, '夸克分享标识', 200) }),
            ...(input.fileId === undefined ? {} : { fileId: text(input.fileId, '夸克文件标识', 200) }) };
          if (input.source === 'quark-library') options.auto = false;
          selected.valid(); const result = await quarkService.prepare(selected.detail, options); selected.valid();
          return json(res, 200, result);
        }
        if (path === '/api/quark/playback' && method === 'POST') {
          const input = await readBody(req), owner = hashToken(token);
          requireSession(owner);
          const lease = await cloudMedia.playback(text(input?.assetId, '夸克影片标识', 200), { owner, valid: () => store.authenticated(owner) });
          requireSession(owner);
          return json(res, 200, lease.response);
        }
        if (['/api/quark/subtitles', '/api/quark/subtitle'].includes(path) && method === 'GET') {
          const keys = path.endsWith('/subtitles') ? ['assetId'] : ['assetId', 'subtitleId'];
          if ([...url.searchParams.keys()].some(key => !keys.includes(key)) || keys.some(key => url.searchParams.getAll(key).length !== 1)) throw badRequest('字幕查询参数无效');
          const assetId = text(url.searchParams.get('assetId'), '夸克影片标识', 200), owner = hashToken(token);
          const valid = () => { requireSession(owner); return true; };
          valid();
          if (path.endsWith('/subtitles')) {
            const subtitles = await quarkService.subtitles(assetId, { valid, visible: ensureVisible });
            valid();
            return json(res, 200, { subtitles: subtitles.map(({ id, name, type }) => ({ id, name, type,
              url: '/api/quark/subtitle?' + new URLSearchParams({ assetId, subtitleId: id }) })) });
          }
          const content = await quarkService.subtitle(assetId, text(url.searchParams.get('subtitleId'), '字幕标识', 200), { valid, visible: ensureVisible });
          valid();
          const body = Buffer.from(content, 'utf8');
          if (body.length > 2 * 1024 * 1024) throw badRequest('字幕文件超过 2 MiB');
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'private, no-store');
          res.setHeader('Content-Length', body.length);
          res.end(body);
          return;
        }
        if (path === '/api/quark/progress' && method === 'POST') {
          const input = await readBody(req);
          return json(res, 200, await quarkService.progress(text(input?.assetId, '夸克影片标识', 200), {
            position: input?.position, duration: input?.duration, ended: input?.ended,
          }));
        }
        const cloudAsset = /^\/api\/quark\/media\/([a-f0-9]{32})$/.exec(path);
        if (cloudAsset && ['GET', 'HEAD'].includes(method)) return await cloudMedia.serve(req, res, cloudAsset[1], url.searchParams.get('token'));
        if (path === '/api/transcode/status' && method === 'GET') return json(res, 200, await transcodeService.status());
        if (path === '/api/transcode/stop' && method === 'POST') {
          const body = await readBody(req);
          return json(res, 200, { stopped: await transcodeService.cancel(text(body?.id, '转码任务标识', 200), hashToken(token)) });
        }
        const transcodeAsset = /^\/api\/transcode\/([^/]+)\/([^/]+)$/.exec(path);
        if (transcodeAsset && ['GET', 'HEAD'].includes(method)) return await transcodeService.serve(req, res, transcodeAsset[1], transcodeAsset[2]);
        if (path === '/api/transcode/start' && method === 'POST') {
          const body = await readBody(req);
          const line = body?.line === undefined ? 0 : body.line, episode = body?.episode === undefined ? 0 : body.episode;
          const position = body?.position === undefined ? 0 : body.position, speed = body?.speed === undefined ? 1 : body.speed;
          if (!Number.isSafeInteger(line) || !Number.isSafeInteger(episode) || line < 0 || episode < 0 ||
              typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 86400 ||
              ![0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(speed)) throw badRequest('转码线路、进度或倍速不正确');
          const snapshot = store.config(), owner = hashToken(token);
          let selected, category, unchanged, mediaOverride, proxyPath;
          if (body?.quarkAsset !== undefined) {
            const lease = await cloudMedia.playback(text(body.quarkAsset, '夸克影片标识', 200), { owner, valid: () => store.authenticated(owner) });
            selected = lease.episode; category = lease.category; ensureVisible(category);
            mediaOverride = lease.media; proxyPath = lease.proxyPath; unchanged = lease.valid;
          } else if (body?.liveId !== undefined) {
            const result = await liveService.list(snapshot);
            const channel = result.channels.find(item => item.id === text(body.liveId, '频道标识', 200));
            selected = channel?.streams[line];
            if (selected?.playbackUrl) selected = { ...selected, url: selected.playbackUrl };
            unchanged = () => JSON.stringify(snapshot.liveSources) === JSON.stringify(store.config().liveSources);
            if (position !== 0 || speed !== 1) throw badRequest('直播兼容播放不支持跳转或倍速');
          } else {
            const source = snapshot.sources.find(item => item.id === body?.source && item.enabled !== false);
            if (!source) throw badRequest('请选择启用的影视源');
            const detail = await catalog.detail(availableConfig(snapshot), source.id, text(body?.id, '影片标识', 200));
            category = detail.category; ensureVisible(category);
            selected = detail.lines[line]?.episodes[episode];
            unchanged = () => store.config().sources.some(item => item.id === source.id && item.api === source.api && item.enabled !== false);
          }
          if (!selected || !['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'].includes(selected.type)) throw badRequest('请选择有效的媒体');
          if (!unchanged()) throw Object.assign(new Error('播放源已修改，请刷新后重试'), { status: 409 });
          const valid = () => store.authenticated(owner) && unchanged() && (category !== 'adult' || store.config().showAdult === true);
          const result = await transcodeService.start({ episode: selected, position, speed, owner, valid, ...(mediaOverride ? { mediaOverride, proxyPath } : {}) });
          if (!valid()) {
            await transcodeService.cancel(result.id, owner);
            ensureVisible(category);
            throw Object.assign(new Error('播放配置或会话已变更，请刷新后重试'), { status: 409 });
          }
          return json(res, 200, result);
        }
        if (path === '/api/sources/status' && method === 'GET') return json(res, 200, { ...sourceService.status(), liveSources: liveService.status?.(store.config()) ?? [], discovery: discoveryService.status() });
        if (path === '/api/sources/discover' && method === 'POST') {
          await readBody(req);
          await discoveryService.discover();
          await liveService.probe?.(store.config());
          return json(res, 200, { ...sourceService.status(), liveSources: liveService.status?.(store.config()) ?? [], discovery: discoveryService.status() });
        }
        if (path === '/api/sources/probe' && method === 'POST') {
          await readBody(req);
          const result = await sourceService.probe();
          await liveService.probe?.(store.config());
          return json(res, 200, { ...result, liveSources: liveService.status?.(store.config()) ?? [], discovery: discoveryService.status() });
        }
        if (path === '/api/sources/update' && method === 'POST') {
          await readBody(req);
          const result = await sourceService.update();
          await liveService.list(store.config(), { refresh: true });
          return json(res, 200, { ...result, liveSources: liveService.status?.(store.config()) ?? [], discovery: discoveryService.status() });
        }
        if (path === '/api/live' && method === 'GET') {
          const result = await liveService.list(store.config(), { refresh: url.searchParams.get('refresh') === '1' });
          return json(res, 200, url.searchParams.get('verified') === '1'
            ? { ...result, channels: result.channels.filter(channel => channel.streams.some(stream => stream.status === 'ok')) } : result);
        }
        if (path === '/api/live/probe' && method === 'POST') {
          await readBody(req);
          await liveService.probe?.(store.config());
          return json(res, 200, await liveService.list(store.config()));
        }
        if (path === '/api/live/playback' && method === 'GET') {
          const snapshot = store.config();
          const result = await liveService.list(snapshot);
          if (JSON.stringify(snapshot.liveSources) !== JSON.stringify(store.config().liveSources)) throw Object.assign(new Error('直播源已修改，请刷新频道列表'), { status: 409 });
          const channel = result.channels.find(item => item.id === url.searchParams.get('id'));
          const line = Number(url.searchParams.get('line') ?? 0);
          if (!channel || !Number.isSafeInteger(line) || line < 0 || !channel.streams[line]) throw badRequest('请选择有效的频道和线路');
          const stream = channel.streams[line];
          return json(res, 200, media.playback({ lines: [{ episodes: [{ ...stream, url: stream.playbackUrl || stream.url }] }] }, 0, 0));
        }
        if (path === '/api/live/report' && method === 'POST') {
          const body = await readBody(req);
          const snapshot = store.config();
          const result = await liveService.list(snapshot);
          if (JSON.stringify(snapshot.liveSources) !== JSON.stringify(store.config().liveSources)) throw Object.assign(new Error('直播源已修改，请刷新频道列表'), { status: 409 });
          const stream = result.channels.find(channel => channel.id === body?.id)?.streams[body?.line];
          if (!stream || !Number.isSafeInteger(body.line) || !['ok', 'error'].includes(body.status)) throw badRequest('频道播放报告格式不正确');
          liveService.report?.(stream.url, body.status);
          return json(res, 200, { ok: true });
        }
        if (path === '/api/ratings' && method === 'GET') {
          if (url.searchParams.get('source') === 'quark-library') {
            const detail = await cloudCatalog.detail(text(url.searchParams.get('id'), '豆瓣影片标识', 16));
            requireSession(hashToken(token)); ensureVisible(detail.category);
            const score = detail.douban?.score;
            return json(res, 200, { douban: Number.isFinite(score) && score > 0 && score <= 10 ? { ...detail.douban, url: `https://movie.douban.com/subject/${detail.id}/`, attribution: detail.douban.attribution || '豆瓣公开条目' } : null,
              tmdb: null, configured: true, errors: [...(Array.isArray(detail.errors) ? detail.errors : []), ...(Number.isFinite(score) && score > 0 && score <= 10 ? [] : ['豆瓣公开条目暂无评分'])] });
          }
          const detail = await catalog.detail(availableConfig(store.config()), url.searchParams.get('source'), url.searchParams.get('id'));
          ensureVisible(detail.category);
          const result = await ratingService.get(detail);
          ensureVisible(detail.category);
          return json(res, 200, result);
        }
        if (path === '/api/player/preferences' && method === 'GET') {
          const key = text(url.searchParams.get('key'), '影片标识', 8192);
          return json(res, 200, { danmakuRows: 1, ...(store.get('player-preferences', key) ?? validatePlayerPreferences({ key })) });
        }
        if (path === '/api/player/preferences' && method === 'PUT') {
          const input = await readBody(req);
          const old = store.get('player-preferences', text(input?.key, '影片标识', 8192));
          return json(res, 200, store.save('player-preferences', validatePlayerPreferences({ ...input,
            danmakuRows: input.danmakuRows === undefined ? old?.danmakuRows : input.danmakuRows,
            skipAds: input.skipAds === undefined ? old?.skipAds : input.skipAds,
            adRanges: input.adRanges === undefined ? old?.adRanges : input.adRanges })));
        }
        if (path === '/api/ads' && method === 'GET') {
          const snapshot = store.config();
          const line = Number(url.searchParams.get('line') ?? 0), episode = Number(url.searchParams.get('episode') ?? 0);
          if (!Number.isSafeInteger(line) || !Number.isSafeInteger(episode) || line < 0 || episode < 0) throw badRequest('播放线路或剧集不正确');
          const source = snapshot.sources.find(item => item.id === url.searchParams.get('source') && item.enabled !== false);
          const detail = await catalog.detail(availableConfig(snapshot), url.searchParams.get('source'), url.searchParams.get('id'));
          ensureVisible(detail.category);
          const selected = detail.lines[line]?.episodes[episode];
          if (!selected || !source) throw badRequest('请选择有效的影片、线路和剧集');
          const result = await adService.inspect(selected);
          ensureVisible(detail.category);
          if (!store.config().sources.some(item => item.id === source.id && item.api === source.api && item.enabled !== false)) throw Object.assign(new Error('影视源已修改，请重新选择'), { status: 409 });
          return json(res, 200, result);
        }
        if (['/api/danmaku', '/api/danmaku/binding'].includes(path) && method === 'GET') {
          const episode = url.searchParams.get('episode') ?? '0';
          const value = { key: url.searchParams.get('key'), episode: /^-?\d+(?:\.\d+)?$/.test(episode) ? Number(episode) : episode,
            ...Object.fromEntries(['title', 'year', 'type', 'episodeName', 'aliases'].filter(name => url.searchParams.has(name)).map(name => [name, url.searchParams.get(name)])) };
          return json(res, 200, path.endsWith('/binding') ? danmakuService.binding(value) : await danmakuService.list(value));
        }
        if (path === '/api/danmaku' && method === 'POST') return json(res, 200, danmakuService.send(await readBody(req)));
        if (path === '/api/danmaku/binding' && method === 'PUT') return json(res, 200, await danmakuService.bind(await readBody(req)));
        if (path === '/api/browse' && method === 'GET') {
          const category = url.searchParams.get('category') ?? 'movie';
          const snapshot = store.config();
          const result = await catalog.browse(availableConfig(snapshot), {
            category,
            page: url.searchParams.get('page') ?? '1',
            source: url.searchParams.get('source') ?? undefined,
            ...Object.fromEntries(['genre', 'year', 'sort'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])),
            ...(url.searchParams.get('progressive') === '1' ? { progressive: true } : {}),
          });
          ensureVisible(category);
          if (JSON.stringify(snapshot.sources) !== JSON.stringify(store.config().sources)) throw Object.assign(new Error('影视源已修改，请刷新列表'), { status: 409 });
          return json(res, 200, result);
        }
        if (path === '/api/search' && method === 'GET') {
          const q = url.searchParams.get('q')?.trim();
          if (!q || q.length > 100) throw badRequest('请输入 1–100 字的搜索内容');
          const snapshot = store.config();
          const result = await catalog.search(availableConfig(snapshot), q, url.searchParams.get('progressive') === '1' ? { progressive: true } : {});
          if (JSON.stringify(snapshot.sources) !== JSON.stringify(store.config().sources)) throw Object.assign(new Error('影视源已修改，请重新搜索'), { status: 409 });
          if (store.config().showAdult !== true) {
            result.groups = result.groups.flatMap(group => {
              const items = group.items.filter(item => item.category !== 'adult');
              if (!items.length) return [];
              const { source, id, ...fields } = items[0];
              return [{ ...group, ...fields, category: fields.category, items }];
            });
          }
          return json(res, 200, result);
        }
        if (path === '/api/detail' && method === 'GET') {
          const detail = await catalog.detail(availableConfig(store.config()), url.searchParams.get('source'), url.searchParams.get('id'));
          ensureVisible(detail.category);
          return json(res, 200, detail);
        }
        if (path === '/api/playback' && method === 'GET') {
          const line = Number(url.searchParams.get('line') ?? 0);
          const episode = Number(url.searchParams.get('episode') ?? 0);
          if (!Number.isSafeInteger(line) || !Number.isSafeInteger(episode) || line < 0 || episode < 0) throw badRequest('播放线路或剧集不正确');
          const detail = await catalog.detail(availableConfig(store.config()), url.searchParams.get('source'), url.searchParams.get('id'));
          ensureVisible(detail.category);
          return json(res, 200, media.playback(detail, line, episode));
        }
        if ((path === '/api/playability' && method === 'GET') || (path === '/api/playability/report' && method === 'POST')) {
          const body = method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
          const line = Number(body?.line ?? 0), episode = Number(body?.episode ?? 0);
          if (!Number.isSafeInteger(line) || !Number.isSafeInteger(episode) || line < 0 || episode < 0) throw badRequest('播放线路或剧集不正确');
          const snapshot = store.config();
          const source = snapshot.sources.find(item => item.id === body?.source && item.enabled !== false);
          if (!source) throw badRequest('请选择启用的影视源');
          const detail = await catalog.detail(availableConfig(snapshot), body?.source, body?.id);
          ensureVisible(detail.category);
          const selected = detail.lines[line]?.episodes[episode];
          if (!selected || method === 'POST' && !['ok', 'error'].includes(body?.status)) throw badRequest('请选择有效的影片、剧集和播放状态');
          if (!store.config().sources.some(item => item.id === source.id && item.api === source.api && item.enabled !== false)) throw Object.assign(new Error('影视源已修改，请刷新影片'), { status: 409 });
          const result = method === 'POST' ? playabilityService.report(selected, body.status === 'ok') : await playabilityService.check(selected);
          ensureVisible(detail.category);
          const currentSource = store.config().sources.find(item => item.id === source.id && item.enabled !== false);
          if (!currentSource || currentSource.api !== source.api) throw Object.assign(new Error('影视源已修改，请刷新影片'), { status: 409 });
          return json(res, 200, result);
        }
        if (path === '/api/media' && ['GET', 'HEAD'].includes(method)) return await media.serve(req, res, url.searchParams.get('token'));
        if (path === '/api/state' && method === 'GET') return json(res, 200, { favorites: visibleEntries('favorites'), history: visibleEntries('history') });
        for (const kind of ['favorites', 'history']) {
          if (path !== `/api/${kind}`) continue;
          if (method === 'GET') return json(res, 200, visibleEntries(kind));
          if (method === 'POST') return json(res, 200, store.save(kind, validateRecord(await readBody(req), kind === 'history')));
          if (method === 'DELETE') {
            const key = url.searchParams.get('key');
            if (kind === 'favorites' && !key) throw badRequest('请指定要删除的收藏');
            store.remove(kind, key); return json(res, 200, { ok: true });
          }
        }
        return json(res, 404, { error: '接口不存在' });
      }
      if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: '请求方法不支持' });
      const decoded = decodeURIComponent(path);
      if (decoded.includes('\0') || decoded.includes('\\')) throw badRequest('路径不正确');
      let file = path === '/vendor/hls.min.js' ? resolve(root, 'node_modules/hls.js/dist/hls.min.js')
        : resolve(publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (path !== '/vendor/hls.min.js' && !file.startsWith(publicDir + sep)) return json(res, 403, { error: '访问被拒绝' });
      let info;
      try { info = await stat(file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (extname(file)) return json(res, 404, { error: '文件不存在' });
        file = resolve(publicDir, 'index.html'); info = await stat(file);
      }
      if (!info.isFile()) return json(res, 404, { error: '文件不存在' });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      if (Object.hasOwn(types, extname(file)) && info.size <= 2 * 1024 * 1024) {
        const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
        let entry = staticFiles.get(file);
        if (entry?.stamp !== stamp) {
          entry = { stamp, promise: readFile(file).then(async body => ({ body, compressed: await gzip(body),
            hash: createHash('sha256').update(body).digest('base64url') })).catch(error => {
            if (staticFiles.get(file) === entry) staticFiles.delete(file); throw error;
          }) };
          if (staticFiles.size >= 32) staticFiles.delete(staticFiles.keys().next().value);
          staticFiles.set(file, entry);
        }
        const asset = await entry.promise;
        const encoding = String(req.headers['accept-encoding'] || '').split(',').find(value => /^\s*gzip(?:\s*;|\s*$)/i.test(value));
        const quality = encoding?.match(/;\s*q\s*=\s*([0-9.]+)/i)?.[1];
        const compressed = !!encoding && (quality === undefined || Number(quality) > 0 && Number(quality) <= 1);
        const body = compressed ? asset.compressed : asset.body;
        const etag = `"${asset.hash}${compressed ? '-gzip' : ''}"`;
        res.setHeader('Content-Type', types[extname(file)]); res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', info.mtime.toUTCString());
        if (compressed) res.setHeader('Content-Encoding', 'gzip');
        const tags = req.headers['if-none-match']?.split(',').map(tag => tag.trim().replace(/^W\//, ''));
        const modifiedSince = Date.parse(req.headers['if-modified-since']);
        if (tags ? tags.includes('*') || tags.includes(etag) : Number.isFinite(modifiedSince) && Math.floor(info.mtimeMs / 1000) <= Math.floor(modifiedSince / 1000)) {
          res.writeHead(304); return res.end();
        }
        res.setHeader('Content-Length', body.length); res.writeHead(200);
        return res.end(method === 'HEAD' ? undefined : body);
      }
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') res.end();
      else createReadStream(file).on('error', (error) => { logger.error(error); res.destroy(); }).pipe(res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) logger.error(error);
      if (!res.headersSent) json(res, status, { error: status === 500 ? '服务发生错误，请查看后台日志' : error.message, ...(status === 401 && error.quarkSafe === true && error.quarkAuth === true ? { quarkAuth: true } : {}), ...(status === 409 && error.code === 'TRANSCODE_INPUT_NOT_SEEKABLE' ? { code: error.code } : {}) });
      else res.destroy(error);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server, store, maintenance: sourceService, live: liveService, discovery: discoveryService, quark: quarkService, quarkSearch: searchPool, quarkCatalog: cloudCatalog,
    async close() { cloudMedia.invalidate(); await Promise.all([sourceService.stop?.(), liveService.stop?.(), discoveryService.stop?.(), transcodeService.close?.(), quarkService.stop?.(), searchPool.stop?.(), cloudCatalog.stop?.(), cloudPosters.stop?.()]); if (server.listening) { const done = new Promise((ok) => server.close(ok)); server.closeIdleConnections(); await done; } store.close(); },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
    const app = createApp();
    app.server.listen(port, '0.0.0.0', () => { app.maintenance.start(); app.live.start?.(); app.discovery.start(); app.quark.start?.(); app.quarkSearch.start?.(); console.log(`VipVideo Web 正在监听端口 ${port}`); });
    app.server.on('error', (error) => { console.error(error); process.exitCode = 1; app.store.close(); });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return; stopping = true;
      const timer = setTimeout(() => { app.server.closeAllConnections(); }, 5000).unref();
      await app.close(); clearTimeout(timer);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

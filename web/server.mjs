import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './lib/store.mjs';
import { validateConfig, importConfig, validateRecord, badRequest } from './lib/config.mjs';
import { createCatalog } from './lib/catalog.mjs';
import { createMedia } from './lib/media.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const defaults = JSON.parse(readFileSync(resolve(root, 'defaults.json'), 'utf8'));
const WEEK = 7 * 24 * 3600;
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
  logger = console } = {}) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('APP_PASSWORD 必须设置，且长度为 8–1024 个字符');
  const store = createStore(dataDir, validateConfig(initialConfig));
  const salt = store.meta('password-salt') ?? randomBytes(16).toString('hex');
  const passwordHash = scryptSync(password, salt, 32);
  if (store.meta('password-hash') !== passwordHash.toString('hex')) store.clearSessions();
  store.setMeta('password-salt', salt);
  store.setMeta('password-hash', passwordHash.toString('hex'));
  const attempts = new Map();
  const publicDir = resolve(root, 'public');
  const cookie = (value, age) => `vipvideo_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${cookieSecure ? '; Secure' : ''}`;

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
          await readBody(req); store.logout(hashToken(token));
          res.setHeader('Set-Cookie', cookie('', 0));
          return json(res, 200, { authenticated: false });
        }
        if (path === '/api/config' && method === 'GET') return json(res, 200, store.config());
        if (path === '/api/config' && method === 'PUT') return json(res, 200, store.setConfig(validateConfig(await readBody(req))));
        if (path === '/api/config/import' && method === 'POST') {
          const body = await readBody(req);
          return json(res, 200, store.setConfig(importConfig(store.config(), body?.config)));
        }
        if (path === '/api/search' && method === 'GET') {
          const q = url.searchParams.get('q')?.trim();
          if (!q || q.length > 100) throw badRequest('请输入 1–100 字的搜索内容');
          return json(res, 200, await catalog.search(store.config(), q));
        }
        if (path === '/api/detail' && method === 'GET') {
          return json(res, 200, await catalog.detail(store.config(), url.searchParams.get('source'), url.searchParams.get('id')));
        }
        if (path === '/api/playback' && method === 'GET') {
          const line = Number(url.searchParams.get('line') ?? 0);
          const episode = Number(url.searchParams.get('episode') ?? 0);
          if (!Number.isSafeInteger(line) || !Number.isSafeInteger(episode) || line < 0 || episode < 0) throw badRequest('播放线路或剧集不正确');
          const detail = await catalog.detail(store.config(), url.searchParams.get('source'), url.searchParams.get('id'));
          return json(res, 200, media.playback(detail, line, episode));
        }
        if (path === '/api/media' && ['GET', 'HEAD'].includes(method)) return await media.serve(req, res, url.searchParams.get('token'));
        if (path === '/api/state' && method === 'GET') return json(res, 200, { favorites: store.list('favorites'), history: store.list('history') });
        for (const kind of ['favorites', 'history']) {
          if (path !== `/api/${kind}`) continue;
          if (method === 'GET') return json(res, 200, store.list(kind));
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
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') res.end();
      else createReadStream(file).on('error', (error) => { logger.error(error); res.destroy(); }).pipe(res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) logger.error(error);
      if (!res.headersSent) json(res, status, { error: status === 500 ? '服务发生错误，请查看后台日志' : error.message });
      else res.destroy(error);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  return {
    server, store,
    async close() { if (server.listening) { const done = new Promise((ok) => server.close(ok)); server.closeIdleConnections(); await done; } store.close(); },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
    const app = createApp();
    app.server.listen(port, '0.0.0.0', () => console.log(`VipVideo Web 正在监听端口 ${port}`));
    app.server.on('error', (error) => { console.error(error); process.exitCode = 1; app.store.close(); });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return; stopping = true;
      const timer = setTimeout(() => { app.server.closeAllConnections(); }, 5000).unref();
      await app.close(); clearTimeout(timer);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

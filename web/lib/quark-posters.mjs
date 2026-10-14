import { createHash } from 'node:crypto';
import { request as networkRequest, validateUrl } from './network.mjs';

const HOSTS = new Set(['img1.doubanio.com', 'img2.doubanio.com', 'img3.doubanio.com', 'img5.doubanio.com', 'img9.doubanio.com']);
const MAX_IMAGE = 2 * 1024 * 1024, MAX_CACHE = 16 * 1024 * 1024, CACHE_TTL = 6 * 60 * 60 * 1000;
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
function posterUrl(value) {
  let url;
  try { url = validateUrl(value); } catch { throw failure('海报地址不可读取', 404); }
  if (url.protocol !== 'https:' || url.port || !HOSTS.has(url.hostname) || url.href.length > 2048) throw failure('海报地址不可读取', 404);
  return url.href;
}
function imageType(body) {
  if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (body.length >= 6 && ['GIF87a', 'GIF89a'].includes(body.toString('ascii', 0, 6))) return 'image/gif';
  if (body.length >= 16 && body.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(body.toString('ascii', 8, 12))) return 'image/avif';
  return '';
}

export function createQuarkPosters({ catalog, request = networkRequest, now = Date.now, timeout = 8000 } = {}) {
  if (!catalog || typeof catalog !== 'object') throw new Error('海报代理需要已登记的豆瓣目录');
  const cache = new Map(), flights = new Map(), waiting = [];
  let bytes = 0, active = 0, stopped = false;
  function discard(key) { const entry = cache.get(key); if (entry) { bytes -= entry.result.body.length; cache.delete(key); } }
  function release() {
    const next = waiting.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else active--;
  }
  async function acquire(signal) {
    signal.throwIfAborted();
    if (active < 2) { active++; return; }
    if (waiting.length >= 32) throw failure('海报读取较多，请稍后重试', 503);
    await new Promise((resolve, reject) => {
      const entry = { signal, resolve, abort: () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); } };
      waiting.push(entry); signal.addEventListener('abort', entry.abort, { once: true });
    });
  }
  async function load(url, signal, deadline) {
    await acquire(signal);
    let response, abort;
    try {
      signal.throwIfAborted();
      response = await request(url, { followRedirects: false, timeout: Math.max(1, deadline - now()), signal,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          referer: 'https://movie.douban.com/', accept: 'image/webp,image/png,image/jpeg;q=0.9,image/*;q=0.8', 'accept-encoding': 'identity' } });
      signal.throwIfAborted();
      if (response.statusCode !== 200) throw failure('豆瓣海报暂不可读取', response.statusCode === 404 ? 404 : 502);
      const type = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type) || !['', 'identity'].includes(String(response.headers?.['content-encoding'] || '').toLowerCase())) throw failure('海报响应不是可用图片');
      const length = response.headers?.['content-length'];
      if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_IMAGE)) throw failure('海报超过大小限制');
      abort = () => response.destroy(signal.reason); signal.addEventListener('abort', abort, { once: true });
      const chunks = []; let size = 0;
      for await (const chunk of response) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > MAX_IMAGE) throw failure('海报超过大小限制'); chunks.push(part); }
      signal.throwIfAborted(); const body = Buffer.concat(chunks);
      if (imageType(body) !== type) throw failure('海报内容不是有效图片');
      return { body, type, etag: '"' + createHash('sha256').update(body).digest('base64url') + '"' };
    } catch (error) { if (signal.aborted) throw signal.reason; throw error.status ? error : failure('豆瓣海报暂不可读取'); }
    finally { if (abort) signal.removeEventListener('abort', abort); response?.destroy(); release(); }
  }
  async function consume(job, signal) {
    job.users++; let abort;
    try {
      if (!signal) return await job.promise;
      signal.throwIfAborted();
      return await Promise.race([job.promise, new Promise((_, reject) => { abort = () => reject(signal.reason || failure('海报读取已取消', 499)); signal.addEventListener('abort', abort, { once: true }); })]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      job.users--; if (!job.users && !job.done) job.controller.abort(failure('海报读取已取消', 499));
    }
  }
  async function restore(id, signal) {
    if (typeof catalog.detail !== 'function') throw failure('此影片暂无已登记海报', 404);
    signal.throwIfAborted(); let abort;
    try {
      // Catalog detail work is shared with other callers; cancel only this wait.
      const detail = await Promise.race([Promise.resolve().then(() => catalog.detail(id)), new Promise((_, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      })]);
      signal.throwIfAborted();
      if (String(detail?.id) !== id) throw failure('此影片暂无已登记海报', 404);
      const registered = typeof catalog.poster === 'function' ? catalog.poster(id) : undefined;
      if (!registered) throw failure('此影片暂无已登记海报', 404);
      return posterUrl(registered);
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  function remembered(url) {
    const cached = cache.get(url);
    if (cached && cached.at + CACHE_TTL > now()) { cache.delete(url); cache.set(url, cached); return cached.result; }
    discard(url);
  }
  return {
    async get(value, { signal } = {}) {
      if (stopped) throw failure('海报服务已停止', 503);
      signal?.throwIfAborted();
      const id = String(value ?? '');
      if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw failure('豆瓣条目标识无效', 400);
      const restoring = flights.get(`id:${id}`);
      if (restoring) return consume(restoring, signal);
      const registered = typeof catalog.poster === 'function' ? catalog.poster(id) : undefined;
      if (!registered && typeof catalog.detail !== 'function') throw failure('此影片暂无已登记海报', 404);
      const url = registered ? posterUrl(registered) : undefined, cached = url && remembered(url);
      if (cached) return cached;
      const key = url || `id:${id}`;
      let job = flights.get(key);
      if (!job) {
        if (flights.size >= 34) throw failure('海报读取较多，请稍后重试', 503);
        const controller = new AbortController(), deadline = now() + timeout;
        job = { controller, users: 0, done: false };
        const timer = setTimeout(() => controller.abort(failure('豆瓣海报读取超时', 504)), timeout);
        job.promise = (async () => {
          const target = url || await restore(id, controller.signal), cached = remembered(target);
          if (cached) return cached;
          const result = await load(target, controller.signal, deadline);
          if (!stopped) {
            discard(target); cache.set(target, { at: now(), result }); bytes += result.body.length;
            while (cache.size > 128 || bytes > MAX_CACHE) discard(cache.keys().next().value);
          }
          return result;
        })().finally(() => { clearTimeout(timer); job.done = true; flights.delete(key); });
        flights.set(key, job);
      }
      return consume(job, signal);
    },
    async stop() { stopped = true; for (const job of flights.values()) job.controller.abort(failure('海报服务已停止', 503)); await Promise.allSettled([...flights.values()].map(job => job.promise)); cache.clear(); bytes = 0; },
  };
}

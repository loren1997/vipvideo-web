import http from 'node:http';
import { Readable } from 'node:stream';
import { readText, validateUrl } from './network.mjs';
import { createQuarkPublicRequest } from './quark-search-network.mjs';

const MAX_BODY = 64 * 1024, MAX_RESPONSE = 2 * 1024 * 1024;
const fields = new Set(['kw', 'cloud_types', 'res', 'src', 'conc', 'channels', 'plugins', 'refresh']);
const failure = (message, status = 502, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { status });
const sensitive = key => /cookie|authorization|password|secret|api.?key|(?:^|_)token(?:$|_)/i.test(key);

function searchBody(body, method) {
  if (body === undefined) return undefined;
  if (method !== 'POST' || !(typeof body === 'string' || Buffer.isBuffer(body)) || Buffer.byteLength(body) > MAX_BODY) throw failure('搜索正文无效或超过 64 KiB', 400);
  let data; try { data = JSON.parse(body.toString()); } catch { throw failure('搜索正文必须是 JSON', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !fields.has(key))) throw failure('搜索正文含不支持的字段', 400);
  if (typeof data.kw !== 'string' || data.kw.length > 1000) throw failure('搜索关键词格式无效', 400);
  for (const key of ['channels', 'plugins', 'cloud_types']) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].length > 20 || data[key].some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item)))) throw failure('搜索列表参数无效', 400);
  if (data.res !== undefined && !['results', 'merge', 'all'].includes(data.res) || data.src !== undefined && !['all', 'tg', 'plugin'].includes(data.src) || data.refresh !== undefined && typeof data.refresh !== 'boolean') throw failure('搜索参数格式无效', 400);
  return JSON.stringify({ ...data, conc: 2 });
}

// This is one optional Compose service, not a general private-network transport.
export function createQuarkSearchRequest({ request = createQuarkPublicRequest(), httpTransport = http.request } = {}) {
  return async function searchRequest(value, options = {}) {
    options.signal?.throwIfAborted();
    const input = value instanceof URL ? value.href : value;
    if (typeof input !== 'string' || input.length > 8192) throw failure('搜索地址无效', 400);
    const url = validateUrl(input), internal = /^http:\/\/pansou:8888\/api\/search(?:\?[^#]*)?$/.test(input);
    if ([...url.searchParams.keys()].some(sensitive)) throw failure('搜索地址不能携带账号凭证', 400);
    if (internal && [...url.searchParams.keys()].some(key => !fields.has(key))) throw failure('内部搜索参数无效', 400);
    const method = options.method || 'GET';
    if (!['GET', 'POST'].includes(method)) throw failure('搜索只支持 GET / POST', 400);
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) throw failure('搜索超时设置无效', 400);
    const timeout = Math.min(8000, options.timeout || 8000), body = searchBody(options.body, method);
    if (internal) url.searchParams.set('conc', '2');
    const headers = { Accept: 'application/json, application/rss+xml, text/plain', 'User-Agent': 'VipVideo-Web-quark-search' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    let upstream, pending, timer, expired = false;
    const work = (async () => {
      if (internal) {
        upstream = await new Promise((resolve, reject) => {
          try {
            pending = httpTransport(url, { method, headers, agent: false, signal: options.signal }, response => {
              if (expired) { response.destroy(); reject(failure('网盘搜索超时（8 秒）')); } else resolve(response);
            });
            pending.once('error', cause => reject(cause?.status ? cause : failure('搜索助手连接失败', 502, cause)));
            pending.end(body);
          } catch (cause) { reject(failure('搜索助手连接失败', 502, cause)); }
        });
      } else {
        upstream = await request(url, { method, headers, timeout, signal: options.signal, ...(body === undefined ? {} : { body }), ...(options.followRedirects === false ? { followRedirects: false } : {}) });
      }
      if (expired) { upstream.destroy(); throw failure('网盘搜索超时（8 秒）'); }
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) { upstream.destroy(); throw failure('搜索助手重定向已拒绝', 403); }
      const text = await readText(upstream, MAX_RESPONSE), bytes = Buffer.from(text);
      if (bytes.length > MAX_RESPONSE) throw failure('搜索结果超过 2 MiB');
      const resultHeaders = { ...upstream.headers, 'content-length': String(bytes.length) };
      delete resultHeaders['content-encoding']; delete resultHeaders['set-cookie'];
      return Object.assign(Readable.from([bytes]), { statusCode: upstream.statusCode, headers: resultHeaders, finalUrl: upstream.finalUrl || url.href });
    })();
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; pending?.destroy(); upstream?.destroy(failure('网盘搜索超时（8 秒）')); reject(failure('网盘搜索超时（8 秒）')); }, timeout);
      })]);
    } finally { clearTimeout(timer); pending?.destroy(); upstream?.destroy(); }
  };
}

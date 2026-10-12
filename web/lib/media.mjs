import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { request as networkRequest, readText, validateUrl } from './network.mjs';

function failure(message, status = 502, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { status });
}

export function createMedia({ request = networkRequest, secret = randomBytes(32) } = {}) {
  // shortcut: 媒体凭证两小时后需重新打开影片，需要连续长时播放时增加自动续签。
  const lifetime = 2 * 60 * 60 * 1000;
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  function proxyUrl(url, type, expires = Date.now() + lifetime) {
    const payload = Buffer.from(JSON.stringify({ url: validateUrl(url).href, type, expires })).toString('base64url');
    return `/api/media?token=${payload}.${sign(payload)}`;
  }
  function verify(token) {
    if (typeof token !== 'string' || token.length > 16384) throw failure('媒体凭证无效', 403);
    const [payload, signature, extra] = token.split('.');
    if (!payload || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signature || '') ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) throw failure('媒体凭证无效', 403);
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (cause) { throw failure('媒体凭证无效', 403, cause); }
    if (!Number.isSafeInteger(data.expires) || data.expires <= Date.now()) throw failure('媒体凭证已过期，请重新打开影片', 403);
    if (!['hls', 'mp4', 'auto'].includes(data.type)) throw failure('媒体凭证无效', 403);
    data.url = validateUrl(data.url).href;
    return data;
  }
  function rewriteManifest(text, baseUrl, expires) {
    if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) throw failure('影视源返回的内容不是有效 HLS 清单');
    let nextIsManifest = false;
    return text.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (trimmed.startsWith('#EXT-X-STREAM-INF:')) nextIsManifest = true;
        const type = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF):/.test(trimmed) ? 'hls' : 'auto';
        return line.replace(/URI="([^"]+)"/g, (_match, value) => `URI="${proxyUrl(new URL(value, baseUrl), type, expires)}"`);
      }
      const type = nextIsManifest || /\.m3u8(?:$|[?#])/i.test(trimmed) ? 'hls' : 'auto';
      nextIsManifest = false;
      return proxyUrl(new URL(trimmed, baseUrl), type, expires);
    }).join('\n');
  }

  return {
    playback(detail, lineIndex, episodeIndex) {
      if (!Number.isInteger(lineIndex) || !Number.isInteger(episodeIndex)) throw failure('请选择有效的线路和剧集', 400);
      const episode = detail?.lines?.[lineIndex]?.episodes?.[episodeIndex];
      if (!episode) throw failure('所选剧集不存在', 400);
      const url = validateUrl(episode.url).href;
      if (episode.type === 'page') return { url, type: 'page' };
      if (!['hls', 'mp4'].includes(episode.type)) throw failure('不支持的媒体类型', 400);
      return { url, type: episode.type, proxyUrl: proxyUrl(url, episode.type) };
    },

    async serve(req, res, token) {
      const data = verify(token);
      const headers = {};
      if (req.headers.range) {
        const range = req.headers.range;
        const ranges = typeof range === 'string' && range.startsWith('bytes=') ? range.slice(6).split(',') : [];
        if (!ranges.length || range.length > 200 || ranges.some(value => {
          if (!/^(?:\d+-\d*|-\d+)$/.test(value)) return true;
          const [start, end] = value.split('-');
          return [start, end].some(bound => bound && !Number.isSafeInteger(Number(bound))) || (start && end && Number(start) > Number(end));
        })) throw failure('Range 请求格式无效', 400);
        if (data.type !== 'hls') headers.range = req.headers.range;
      }
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) throw failure('不支持的媒体请求方法', 400);
      const upstream = await request(data.url, { headers, method: req.method || 'GET', timeout: 8000 });
      if (req.aborted || res.destroyed) { upstream.destroy(); return; }
      let clientDisconnected = false;
      const cancel = () => { if (!res.writableFinished && !upstream.destroyed) clientDisconnected = true; upstream.destroy(); };
      req.once('aborted', cancel);
      res.once('close', cancel);
      try {
        if (![200, 206, 304, 416].includes(upstream.statusCode)) throw failure(`媒体源返回 HTTP ${upstream.statusCode}`);
        const finalUrl = upstream.finalUrl || data.url;
        const manifest = data.type === 'hls' || /mpegurl/i.test(String(upstream.headers['content-type'] || '')) || /\.m3u8$/i.test(new URL(finalUrl).pathname);
        if (manifest && upstream.statusCode === 206) throw failure('HLS 清单必须完整返回，请重新加载', 502);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        if (manifest) res.setHeader('Accept-Ranges', 'none');
        if (manifest && upstream.statusCode === 200 && req.method !== 'HEAD') {
          const text = await readText(upstream, 2 * 1024 * 1024);
          const body = rewriteManifest(text, finalUrl, data.expires);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          res.end(body);
          return;
        }
        res.statusCode = upstream.statusCode;
        // 不把第三方 HTML / JavaScript 当作本域可执行内容返回。
        const contentType = String(upstream.headers['content-type'] || '');
        res.setHeader('Content-Type', manifest ? 'application/vnd.apple.mpegurl' : /^(?:video\/|audio\/|application\/(?:octet-stream|mp4)(?:;|$)|multipart\/byteranges(?:;|$))/i.test(contentType) ? contentType : 'application/octet-stream');
        for (const header of ['content-length', 'content-range', 'accept-ranges', 'content-encoding', 'etag', 'last-modified']) {
          if (manifest && ['content-range', 'accept-ranges'].includes(header)) continue;
          if (upstream.headers[header] !== undefined) res.setHeader(header, upstream.headers[header]);
        }
        if (req.method === 'HEAD' || upstream.statusCode === 304 || upstream.statusCode === 416) { upstream.destroy(); res.end(); return; }
        await pipeline(upstream, res);
      } catch (cause) {
        upstream.destroy();
        if (clientDisconnected || req.aborted) return;
        throw cause.status ? cause : failure('媒体传输中断，请重试或切换线路', 502, cause);
      } finally {
        req.off('aborted', cancel);
        res.off('close', cancel);
      }
    },
  };
}

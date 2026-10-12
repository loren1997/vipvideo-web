import { request as networkRequest, readText, validateUrl } from './network.mjs';

function failure(message, status = 502, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { status });
}

function parseLines(video) {
  const names = String(video.vod_play_from || '').split('$$$');
  return String(video.vod_play_url || '').split('$$$').map((value, index) => ({
    name: names[index]?.trim() || `线路 ${index + 1}`,
    episodes: value.split('#').map((entry, episodeIndex) => {
      const separator = entry.indexOf('$');
      const name = separator >= 0 ? entry.slice(0, separator).trim() : `第 ${episodeIndex + 1} 集`;
      const rawUrl = (separator >= 0 ? entry.slice(separator + 1) : entry).trim().replace(/&amp;/g, '&');
      if (!rawUrl) return null;
      try {
        const url = validateUrl(rawUrl);
        const type = /\.m3u8$/i.test(url.pathname) ? 'hls' : /\.mp4$/i.test(url.pathname) ? 'mp4' : /m3u8|\bhls\b/i.test(names[index] || '') ? 'hls' : /\bmp4\b/i.test(names[index] || '') ? 'mp4' : 'page';
        return { name: name || `第 ${episodeIndex + 1} 集`, url: url.href, type };
      } catch { return null; }
    }).filter(Boolean),
  })).filter(line => line.episodes.length);
}

function metadata(video, source) {
  if (!video || typeof video !== 'object' || !String(video.vod_id ?? '').trim() || !String(video.vod_name || '').trim()) return null;
  const title = String(video.vod_name).trim();
  const year = String(video.vod_year || '').trim();
  const lines = parseLines(video);
  const type = lines.some(line => line.episodes.length > 1) || /电视剧|连续剧|剧集|综艺|动漫|动画剧|短剧/.test(String(video.type_name || '')) ? 'series' : 'movie';
  const normalizedTitle = title.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  let poster = '';
  try { if (video.vod_pic) poster = validateUrl(video.vod_pic).href; } catch { /* 无效海报不妨碍影片搜索。 */ }
  return { key: JSON.stringify([normalizedTitle, year, type]), source: source.id, id: String(video.vod_id), title, year, type, poster, lines };
}

export function createCatalog({ request = networkRequest } = {}) {
  async function query(source, parameters) {
    const url = validateUrl(source.api);
    url.searchParams.set('ac', 'videolist');
    url.searchParams.delete('wd');
    url.searchParams.delete('ids');
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    let response;
    let timer;
    let timedOut = false;
    const operation = (async () => {
      response = await request(url, { timeout: 8000, headers: { accept: 'application/json' } });
      if (timedOut) { response.destroy(); throw failure('影视源请求超时'); }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        throw failure(`影视源返回 HTTP ${response.statusCode}`);
      }
      const text = await readText(response);
      let body;
      try { body = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (cause) { throw failure('影视源返回的内容不是有效 JSON', 502, cause); }
      if (!body || !Array.isArray(body.list)) throw failure('影视源返回的数据格式不兼容');
      return body.list;
    })();
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; response?.destroy(); reject(failure('影视源请求超时')); }, 8000);
      })]);
    } catch (cause) {
      throw cause.status ? cause : failure('影视源请求失败', 502, cause);
    } finally { clearTimeout(timer); }
  }

  return {
    async search(config, value) {
      const q = String(value ?? '').trim();
      if (!q || q.length > 100) throw failure('请输入 1 到 100 个字符的关键词', 400);
      const sources = config.sources.filter(source => source.enabled !== false);
      const results = new Array(sources.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
        while (next < sources.length) {
          const index = next++;
          const source = sources[index];
          try { results[index] = { source, videos: await query(source, { wd: q }) }; }
          catch (error) { results[index] = { source, error }; }
        }
      }));
      const groups = new Map();
      const failedSources = [];
      for (const result of results) {
        if (result.error) { failedSources.push({ source: result.source.id, name: result.source.name, error: result.error.message }); continue; }
        for (const video of result.videos) {
          const item = metadata(video, result.source);
          if (!item) continue;
          const { lines, ...summary } = item;
          if (!groups.has(item.key)) groups.set(item.key, { key: item.key, title: item.title, year: item.year, type: item.type, poster: item.poster, items: [] });
          const group = groups.get(item.key);
          if (!group.items.some(existing => existing.source === item.source && existing.id === item.id)) group.items.push(summary);
          if (!group.poster && item.poster) group.poster = item.poster;
        }
      }
      return { groups: [...groups.values()], failedSources };
    },

    async detail(config, sourceId, id) {
      const source = config.sources.find(item => item.id === sourceId && item.enabled !== false);
      if (!source) throw failure('影视源不存在或已停用', 400);
      const videoId = String(id ?? '').trim();
      if (!videoId || videoId.length > 128 || /[\u0000-\u001f\u007f]/.test(videoId)) throw failure('影片标识无效', 400);
      const videos = await query(source, { ids: videoId });
      const video = videos.find(item => String(item.vod_id) === videoId);
      const item = metadata(video, source);
      if (!item) throw failure('影片不存在或源未返回详情');
      if (!item.lines.length) throw failure('该影片没有可用的 HTTP / HTTPS 播放线路');
      const description = String(video.vod_content || video.vod_blurb || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
      return { ...item, description };
    },
  };
}

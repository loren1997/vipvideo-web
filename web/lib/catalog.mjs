import { request as networkRequest, readText, validateUrl } from './network.mjs';

function failure(message, status = 502, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { status });
}

const ROOT_NAMES = {
  movie: /^(?:全部)?(?:电影|电影片|影片|movies?|films?)(?:频道)?$/i,
  tv: /^(?:全部)?(?:电视剧|连续剧|剧集|电视|tv|series)(?:频道)?$/i,
  anime: /^(?:全部)?(?:动漫|动漫片|动画|动画片|anime|animation)(?:频道)?$/i,
  variety: /^(?:全部)?(?:综艺|综艺片|电视节目|电视栏目|栏目|variety)(?:频道)?$/i,
  adult: /^(?:三级|三級|限制级|限制級|成人|伦理|倫理|情色|福利|R18|18禁)(?:内容|频道)?$/i,
};

const GENRES = {
  喜剧: /喜剧|喜劇|搞笑|\bcomedy\b/i,
  惊悚: /惊悚|驚悚|\bthriller\b/i,
  恐怖: /恐怖|\bhorror\b/i,
  动作: /动作|動作|武打|战斗|戰鬥|热血|熱血|\baction\b/i,
  爱情: /爱情|愛情|恋爱|戀愛|\bromance\b/i,
  科幻: /科幻|\bsci[ -]?fi\b|science fiction/i,
  悬疑: /悬疑|懸疑|推理|\bmystery\b/i,
  犯罪: /犯罪|\bcrime\b/i,
  战争: /战争|戰爭|\bwar\b/i,
  剧情: /剧情|劇情|\bdrama\b/i,
  动画: /动画|動畫|\banimation\b/i,
  冒险: /冒险|冒險|\badventure\b/i,
  奇幻: /奇幻|玄幻|魔幻|魔法|\bfantasy\b/i,
  家庭: /家庭|\bfamily\b/i,
  历史: /历史|歷史|\bhistory\b|\bhistorical\b/i,
  纪录: /纪录|記錄|记录|紀錄|\bdocumentary\b/i,
  武侠: /武侠|武俠|\bwuxia\b/i,
  古装: /古装|古裝|\bcostume\b/i,
  音乐: /音乐|音樂|歌舞|\bmusical?\b/i,
  运动: /运动|運動|体育|體育|\bsports?\b/i,
  青春: /青春|校园|校園|\byouth\b/i,
};

function genres(video) {
  const value = [video?.vod_class, video?.type_name, video?.vod_type_name].map(value => String(value || '').slice(0, 2000)).join(' ').normalize('NFKC');
  return Object.entries(GENRES).filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

function releaseDate(value) {
  const dates = [...String(value || '').slice(0, 2000).matchAll(/\b((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)].map(([, year, month, day]) => {
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
  }).filter(Boolean);
  return dates.sort()[0] || '';
}

function adultCategory(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, '');
  return /伦理|倫理|情色|福利|成人|三级|三級|限制级|限制級|里番|裏番|hentai|18禁|(?:^|[^a-z0-9])r-?18(?:\+|$|[^a-z0-9])/i.test(text);
}

function adultVideo(video) {
  return video?._catalogAdult === true || ['type_name', 'vod_type_name', 'vod_class', 'vod_tag', 'vod_remarks'].some(field => adultCategory(video?.[field]));
}

function inferCategory(value, includeAdult = true) {
  const name = String(value || '').normalize('NFKC').replace(/\s+/g, '');
  if (includeAdult && adultCategory(name)) return 'adult';
  if (ROOT_NAMES.variety.test(name) || /综艺|栏目|晚会|真人秀|脱口秀|variety/i.test(name)) return 'variety';
  if (/动漫|动画|番剧|卡通|anime|animation/i.test(name)) return 'anime';
  if (ROOT_NAMES.tv.test(name) || /电视剧|连续剧|剧集|短剧|微剧|(?:国产|大陆|内地|欧美|海外|日韩|港台|香港|台湾|日本|韩国|泰国|日|韩|泰|港|台|美)剧/i.test(name)) return 'tv';
  if (/电影|影片|(?:动作|喜剧|爱情|科幻|恐怖|惊悚|战争|剧情|犯罪|悬疑|奇幻|冒险|灾难|记录|纪录|伦理|家庭|传记|历史|歌舞|青春|武侠|古装|其他)片/i.test(name) || ROOT_NAMES.movie.test(name)) return 'movie';
  return '';
}

function classifyTypes(entries) {
  if (entries.length > 256) throw failure('影视源分类数量超过安全上限（256），请使用更精简的接口');
  const byId = new Map();
  for (const entry of entries) {
    const id = String(entry?.type_id ?? '');
    const name = String(entry?.type_name || '').trim();
    if (!/^[1-9]\d*$/.test(id) || !name) continue;
    byId.set(id, { id, name, parent: String(entry.type_pid ?? ''), category: inferCategory(name) });
  }
  const categories = new Map();
  for (const type of byId.values()) {
    const seen = new Set();
    let category = '';
    for (let current = type; current && !seen.has(current.id); current = byId.get(current.parent)) {
      seen.add(current.id);
      if (current.category === 'adult') { category = 'adult'; break; }
      if (current.category) category = current.category;
    }
    if (category) categories.set(type.id, category);
  }
  return { byId, categories };
}

function selectTypes(types, category) {
  const matching = [...types.byId.values()].filter(type => types.categories.get(type.id) === category);
  const hasChildren = type => matching.some(child => child.parent === type.id);
  const root = matching.find(type => ROOT_NAMES[category].test(type.name.replace(/\s+/g, ''))) || (category === 'adult' ? undefined : matching.find(hasChildren));
  let leaves = matching.filter(type => type.id !== root?.id && !hasChildren(type));
  if (root) {
    const descendants = leaves.filter(type => {
      const seen = new Set();
      for (let current = type; current && !seen.has(current.id); current = types.byId.get(current.parent)) {
        if (current.parent === root.id) return true;
        seen.add(current.id);
      }
      return false;
    });
    // 部分源不提供 type_pid，此时只使用名称明确属于同类的叶子分类。
    if (descendants.length) leaves = descendants;
  }
  return { root, leaves, matching };
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

function metadata(video, source, categoryHint) {
  if (!video || typeof video !== 'object' || !String(video.vod_id ?? '').trim() || !String(video.vod_name || '').trim()) return null;
  const title = String(video.vod_name).trim();
  const year = String(video.vod_year || '').trim();
  const lines = parseLines(video);
  const typeName = String(video.type_name || video.vod_type_name || '').trim();
  const remarks = String(video.vod_remarks ?? '');
  const inferredCategory = inferCategory(typeName, false);
  const category = adultVideo(video) || categoryHint === 'adult' ? 'adult' : categoryHint || inferredCategory;
  const type = lines.some(line => line.episodes.length > 1) || /电视剧|连续剧|剧集|综艺|动漫|动画剧|短剧/.test(typeName) || inferredCategory === 'tv' || inferredCategory === 'variety' || (inferredCategory === 'anime' && !/电影|动画片/.test(typeName)) ? 'series' : 'movie';
  const normalizedTitle = title.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  let poster = '';
  try { if (video.vod_pic) poster = validateUrl(video.vod_pic).href; } catch { /* 无效海报不妨碍影片搜索。 */ }
  const douban = {};
  if (/^[1-9]\d{0,11}$/.test(String(video.vod_douban_id ?? ''))) douban.id = String(video.vod_douban_id);
  const score = Number(video.vod_douban_score);
  if (String(video.vod_douban_score ?? '').trim() && Number.isFinite(score) && score > 0 && score <= 10) douban.score = score;
  return { key: JSON.stringify([normalizedTitle, year, type]), source: source.id, id: String(video.vod_id), title, year, type, poster, typeName, remarks,
    genres: genres(video), releaseDate: releaseDate(video.vod_pubdate),
    ...(category ? { category } : {}), ...(Object.keys(douban).length ? { douban } : {}), lines };
}

function aggregate(results, category) {
  const groups = new Map();
  const failedSources = [];
  for (const result of results) {
    if (result.error) failedSources.push({ source: result.source.id, name: result.source.name, error: result.error.message });
    for (const video of result.videos || []) {
      const item = metadata(video, result.source, category);
      if (!item) continue;
      const { lines, source, id, ...fields } = item;
      if (!groups.has(item.key)) groups.set(item.key, { ...fields, items: [] });
      const group = groups.get(item.key);
      if (item.category === 'adult') group.category = 'adult';
      if (!group.items.some(existing => existing.source === item.source && existing.id === item.id)) group.items.push({ ...fields, source, id });
      for (const field of ['poster', 'typeName', 'remarks']) if (!group[field] && item[field]) group[field] = item[field];
      if (item.releaseDate && (!group.releaseDate || item.releaseDate < group.releaseDate)) group.releaseDate = item.releaseDate;
      group.genres = [...new Set([...group.genres, ...item.genres])];
      if (!group.douban?.score && item.douban?.score) group.douban = item.douban;
    }
  }
  return { groups: [...groups.values()], failedSources };
}

async function fromSources(sources, load, completed) {
  const results = new Array(sources.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
    while (next < sources.length) {
      const index = next++;
      const source = sources[index];
      try { results[index] = { source, ...await load(source) }; }
      catch (error) { results[index] = { source, error }; }
      completed?.(results[index], index);
    }
  }));
  return results;
}

export function createCatalog({ request = networkRequest } = {}) {
  const typeCache = new Map();
  const browseCache = new Map();
  const searchCache = new Map();
  const detailCache = new Map();
  let configSignature, typeSignature;
  let active = 0;
  const waiting = [];
  const urgent = [];
  function limited(operation, priority = false) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        operation().then(resolve, reject).finally(() => { active--; (urgent.shift() || waiting.shift())?.(); });
      };
      if (active < 3) run(); else (priority ? urgent : waiting).push(run);
    });
  }
  async function cached(cache, key, ttl, load) {
    let entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      entry = { expires: Date.now() + ttl, promise: Promise.resolve().then(load) };
      cache.set(key, entry);
    }
    try { return await entry.promise; }
    catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  }
  function signature(config) {
    const sources = JSON.stringify(config.sources.map(source => [source.id, source.api, source.name, source.enabled]));
    const value = JSON.stringify([config.showAdult === true, sources]);
    if (sources !== typeSignature) { typeCache.clear(); typeSignature = sources; }
    if (value !== configSignature) { browseCache.clear(); searchCache.clear(); configSignature = value; }
    return value;
  }
  async function batch(cache, key, ttl, sources, load, format, progressive) {
    let entry = cache.get(key);
    if (!entry || (entry.done && entry.expires <= Date.now())) {
      if (cache.size >= 128) {
        const oldest = [...cache].find(([, item]) => item.done);
        if (!oldest) throw failure('正在加载的请求过多，请稍后重试', 503);
        cache.delete(oldest[0]);
      }
      let first;
      entry = { results: new Array(sources.length), done: false, firstReady: new Promise(resolve => { first = resolve; }) };
      cache.set(key, entry);
      entry.promise = fromSources(sources, load, (result, index) => { entry.results[index] = result; first(); }).then(results => {
        entry.results = results; entry.done = true;
        entry.expires = Date.now() + (results.some(result => result.error) ? 15000 : ttl);
      });
    }
    if (progressive && !entry.done) {
      let timer;
      try { await Promise.race([entry.promise, entry.firstReady, new Promise(resolve => { timer = setTimeout(resolve, 150); })]); }
      finally { clearTimeout(timer); }
    } else await entry.promise;
    const result = format(entry.results.filter(Boolean));
    if (progressive) {
      result.complete = entry.done;
      result.pendingSources = sources.filter((_, index) => !entry.results[index]).map(source => ({ source: source.id, name: source.name }));
    } else if (result.failedSources.length && cache.get(key) === entry) cache.delete(key);
    return structuredClone(result);
  }
  async function query(source, parameters, priority = false) {
    const url = validateUrl(source.api);
    for (const key of ['wd', 'ids', 't', 'pg', 'ac', 'year', 'class', 'sort_direction']) url.searchParams.delete(key);
    url.searchParams.set('ac', 'videolist');
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return limited(async () => {
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
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('影视源返回的数据格式不兼容');
        return body;
      })();
      try {
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; response?.destroy(); reject(failure('影视源请求超时')); }, 8000);
        })]);
      } catch (cause) {
        throw cause.status ? cause : failure('影视源请求失败', 502, cause);
      } finally { clearTimeout(timer); }
    }, priority);
  }
  function videos(body) {
    if (!Array.isArray(body.list)) throw failure('影视源返回的数据格式不兼容');
    return body.list;
  }
  function hasMore(body, page) {
    if (page >= 100) return false;
    const count = Number(body.pagecount);
    if (body.pagecount != null && String(body.pagecount) !== '' && Number.isInteger(count) && count >= 0) return page < count;
    const total = Number(body.total);
    const limit = Number(body.limit);
    if (body.total != null && body.limit != null && Number.isInteger(total) && total >= 0 && Number.isInteger(limit) && limit > 0) return page * limit < total;
    return body.list.length > 0;
  }
  async function sourceTypes(source, priority = false) {
    return cached(typeCache, JSON.stringify([source.id, source.api]), 180000, async () => {
      const body = await query(source, { ac: 'list' }, priority);
      return classifyTypes(Array.isArray(body.class) ? body.class : []);
    });
  }
  async function classifiedVideos(source, body, priority = false) {
    const list = videos(body);
    const types = Array.isArray(body.class) ? classifyTypes(body.class) : list.some(video => video?.type_id != null) ? await sourceTypes(source, priority) : undefined;
    return types ? list.map(video => types.categories.get(String(video?.type_id)) === 'adult' ? { ...video, _catalogAdult: true } : video) : list;
  }
  async function sourceBrowse(source, category, page, { genre, year }) {
    const types = await sourceTypes(source);
    const readPage = async type => {
      const body = await query(source, { pg: page, ...(type ? { t: type.id } : {}), ...(year ? { year } : {}) });
      const list = videos(body);
      let recognized = false;
      const filtered = list.filter(video => {
        const kind = adultVideo(video) || types.categories.get(String(video?.type_id)) === 'adult' ? 'adult' : types.categories.get(String(video?.type_id)) || inferCategory(video?.type_name || video?.vod_type_name);
        if (kind) recognized = true;
        return kind === category;
      }).map(video => {
        const typeName = types.byId.get(String(video.type_id))?.name || '';
        return { ...video, type_name: video.type_name || video.vod_type_name || typeName,
          vod_class: [video.vod_class, typeName].filter(Boolean).join(',') };
      });
      if (list.length && !recognized) throw failure('影视源未提供可识别的影片分类');
      return { videos: filtered.filter(video => (!year || String(video.vod_year || '').trim() === year) && (!genre || genres(video).includes(genre))),
        categoryCount: filtered.length, hasMore: hasMore(body, page) };
    };
    const { root, leaves, matching } = selectTypes(types, category);
    // 子分类 ID 由每个源自己提供，不能把喜剧等类别固定成某个数字。
    const genreTypes = genre ? matching.filter(type => GENRES[genre].test(type.name)) : [];
    if (!genreTypes.length && root) {
      const result = await readPage(root);
      if (result.categoryCount || !leaves.length) return result;
    }
    if (!genreTypes.length && !leaves.length) {
      if (!matching.length && types.categories.size && category !== 'adult') return { videos: [], hasMore: false };
      return readPage();
    }
    const result = { videos: [], hasMore: false };
    const errors = [];
    const pages = await Promise.all((genreTypes.length ? genreTypes : leaves).map(async leaf => {
      try { return await readPage(leaf); } catch (error) { return { error }; }
    }));
    for (const pageResult of pages) {
      if (pageResult.error) { errors.push(pageResult.error.message); continue; }
      result.videos.push(...pageResult.videos);
      result.hasMore ||= pageResult.hasMore;
    }
    if (errors.length) result.error = failure(errors.join('；'));
    return result;
  }

  return {
    async search(config, value, { progressive = false } = {}) {
      const q = String(value ?? '').trim();
      if (!q || q.length > 100) throw failure('请输入 1 到 100 个字符的关键词', 400);
      const sources = config.sources.filter(source => source.enabled !== false);
      const key = JSON.stringify([signature(config), q]);
      return batch(searchCache, key, 30000, sources,
        async source => ({ videos: (await classifiedVideos(source, await query(source, { wd: q }))).filter(video => config.showAdult === true || !adultVideo(video)) }),
        results => aggregate(results), progressive);
    },

    async browse(config, { category = 'movie', page = 1, source: sourceId, progressive = false, genre = '', year = '', sort = 'updated' } = {}) {
      if (typeof category !== 'string' || !Object.hasOwn(ROOT_NAMES, category)) throw failure('分类必须为 movie、tv、anime、variety 或 adult', 400);
      if (category === 'adult' && config.showAdult !== true) throw failure('三级内容已隐藏，请先在设置中开启显示', 403);
      if (!((typeof page === 'number' && Number.isInteger(page)) || (typeof page === 'string' && /^[1-9]\d{0,2}$/.test(page))) || Number(page) < 1 || Number(page) > 100) throw failure('页码必须为 1 到 100 的整数', 400);
      page = Number(page);
      if (typeof genre !== 'string' || genre && !Object.hasOwn(GENRES, genre)) throw failure('影片类型无效，请选择提供的类型', 400);
      const currentYear = new Date().getFullYear();
      if (typeof year !== 'string' || year && (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > currentYear + 3)) throw failure('上映年份必须为 1900 至当前年份加 3 的四位年份', 400);
      if (!['updated', 'release', 'year'].includes(sort)) throw failure('排序方式无效', 400);
      const sources = config.sources.filter(source => source.enabled !== false && (sourceId === undefined || source.id === sourceId));
      if (sourceId !== undefined && !sources.length) throw failure('影视源不存在或已停用', 400);
      const filters = { genre, year, sort };
      const key = JSON.stringify([signature(config), category, page, sourceId, filters]);
      return batch(browseCache, key, 180000, sources, source => sourceBrowse(source, category, page, filters), results => {
        const result = aggregate(results, category);
        // 采集 API 按资源更新时间分页；上映顺序只适用于已加载的影片。
        if (sort !== 'updated') result.groups.sort((a, b) => {
          const value = item => sort === 'release' ? item.releaseDate : /^\d{4}$/.test(item.year) ? item.year : '';
          return value(b).localeCompare(value(a)) || a.title.localeCompare(b.title, 'zh-CN');
        });
        const years = new Set(Array.from({ length: Math.max(1, currentYear - 1899) }, (_, index) => String(currentYear - index)));
        for (const item of result.groups) if (/^\d{4}$/.test(item.year) && Number(item.year) >= 1900 && Number(item.year) <= currentYear + 3) years.add(item.year);
        return { category, page, ...result, filters, facets: { genres: Object.keys(GENRES), years: [...years].sort((a, b) => Number(b) - Number(a)) },
          sortScope: 'loaded', hasMore: results.some(result => result.hasMore === true) };
      }, progressive);
    },

    async detail(config, sourceId, id) {
      const source = config.sources.find(item => item.id === sourceId && item.enabled !== false);
      if (!source) throw failure('影视源不存在或已停用', 400);
      const videoId = String(id ?? '').trim();
      if (!videoId || videoId.length > 128 || /[\u0000-\u001f\u007f]/.test(videoId)) throw failure('影片标识无效', 400);
      const key = JSON.stringify([source.id, source.api, source.name, videoId]);
      const item = await cached(detailCache, key, 30000, async () => {
        const video = (await classifiedVideos(source, await query(source, { ids: videoId }, true), true)).find(item => String(item.vod_id) === videoId);
        const item = metadata(video, source);
        if (!item) throw failure('影片不存在或源未返回详情');
        const description = String(video.vod_content || video.vod_blurb || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
        const shareLinks = [video.vod_content, video.vod_blurb, video.vod_down_url].filter(Boolean).join(' ').replace(/&amp;/g, '&')
          .match(/https:\/\/pan\.quark\.cn\/s\/[A-Za-z0-9]{6,64}(?:\?[^\s<>"']*)?/g) || [];
        const sharesByPath = new Map();
        for (const value of shareLinks.slice(0, 20)) {
          const url = new URL(value), password = url.searchParams.get('pwd') || '';
          url.search = '';
          if (/^[A-Za-z0-9]{1,16}$/.test(password)) url.searchParams.set('pwd', password);
          if (!sharesByPath.has(url.pathname) || url.search) sharesByPath.set(url.pathname, url.href);
        }
        const quarkShares = [...sharesByPath.values()].slice(0, 10);
        return { ...item, description, ...(quarkShares.length ? { quarkShares } : {}) };
      });
      if (item.category === 'adult' && config.showAdult !== true) throw failure('三级内容已隐藏，请先在设置中开启显示', 403);
      if (!item.lines.length) { detailCache.delete(key); throw failure('该影片没有可用的 HTTP / HTTPS 播放线路'); }
      return structuredClone(item);
    },
  };
}

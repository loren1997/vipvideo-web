import { request as networkRequest, readText, validateUrl } from './network.mjs';
import { hasNetflixLabel, normalizeCountries, validCountryFilter } from './catalog-filters.mjs';

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
    genres: genres(video), releaseDate: releaseDate(video.vod_pubdate), countries: normalizeCountries(video.vod_area),
    netflix: hasNetflixLabel(video.vod_platform, video.vod_tv, video.vod_producer, video.vod_tag, video.vod_class, typeName),
    ...(category ? { category } : {}), ...(Object.keys(douban).length ? { douban } : {}), lines };
}

function catalogItems(result, category, source = result.source) {
  if (result.items) return result.items;
  result.items = [];
  for (const video of result.videos || []) {
    const item = metadata(video, source, category);
    if (item) {
      const { lines, ...summary } = item;
      result.items.push(summary);
    }
  }
  delete result.videos;
  return result.items;
}

function aggregate(results, category) {
  const groups = new Map();
  const failedSources = [];
  for (const result of results) {
    if (result.error) failedSources.push({ source: result.source.id, name: result.source.name, error: result.error.message });
    for (const item of catalogItems(result, category)) {
      const { source, id, ...fields } = item;
      if (!groups.has(item.key)) groups.set(item.key, { ...fields, items: [] });
      const group = groups.get(item.key);
      if (item.category === 'adult') group.category = 'adult';
      if (!group.items.some(existing => existing.source === item.source && existing.id === item.id)) group.items.push({ ...fields, source, id });
      for (const field of ['poster', 'typeName', 'remarks']) if (!group[field] && item[field]) group[field] = item[field];
      if (item.releaseDate && (!group.releaseDate || item.releaseDate < group.releaseDate)) group.releaseDate = item.releaseDate;
      group.genres = [...new Set([...group.genres, ...item.genres])];
      group.countries = [...new Set([...group.countries, ...item.countries])];
      group.netflix ||= item.netflix;
      if (!group.douban?.score && item.douban?.score) group.douban = item.douban;
    }
  }
  return { groups: [...groups.values()], failedSources };
}

function browseSnapshot(entry, category) {
  return entry.snapshot ??= aggregate(entry.results.filter(Boolean), category);
}

async function fromSources(sources, load, completed, signal) {
  const results = new Array(sources.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
    while (next < sources.length && !signal?.aborted) {
      const index = next++;
      const source = sources[index];
      try { results[index] = { source, ...await load(source) }; }
      catch (error) { results[index] = { source, error }; }
      completed?.(results[index], index);
    }
  }));
  return results;
}

function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createCatalog({ request = networkRequest } = {}) {
  const typeCache = new Map();
  const browseCache = new Map();
  const searchCache = new Map();
  const detailCache = new Map();
  let configSignature, typeSignature;
  const browseAttempts = new Map();
  let recentBrowseSuccess;
  let active = 0;
  const waiting = [];
  const urgent = [];
  function limited(operation, priority = false, signal) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const queue = priority ? urgent : waiting;
      const cancel = () => { queue.splice(queue.indexOf(run), 1); reject(signal.reason); };
      const run = () => {
        signal?.removeEventListener('abort', cancel);
        active++;
        operation().then(resolve, reject).finally(() => { active--; (urgent.shift() || waiting.shift())?.(); });
      };
      if (active < 3) run();
      else { queue.push(run); signal?.addEventListener('abort', cancel, { once: true }); }
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
    if (value !== configSignature) { browseCache.clear(); searchCache.clear(); browseAttempts.clear(); recentBrowseSuccess = undefined; configSignature = value; }
    return value;
  }
  async function batch(cache, key, ttl, sources, load, format, progressive, resume = false) {
    let entry = cache.get(key);
    if (!entry || (entry.done && entry.expires <= Date.now())) {
      if (cache.size >= 128) {
        const oldest = [...cache].find(([, item]) => item.done);
        if (!oldest) throw failure('正在加载的请求过多，请稍后重试', 503);
        cache.delete(oldest[0]);
      }
      entry = { results: new Array(sources.length), done: false };
      cache.set(key, entry);
    }
    if (!entry.promise || (resume && entry.done && entry.results.some(result => result.deferred))) {
      const isBrowse = cache === browseCache;
      const indices = sources.map((_, i) => i).filter(i => !entry.results[i] || entry.results[i].deferred);
      const controller = isBrowse ? new AbortController() : null;
      const signal = controller?.signal;
      let timer;
      if (isBrowse) {
        entry.attempts ??= Array(sources.length).fill(0);
        indices.sort((a, b) => entry.attempts[a] - entry.attempts[b] || (browseAttempts.get(sources[a].id) || 0) - (browseAttempts.get(sources[b].id) || 0));
        const recent = indices.findIndex(i => sources[i].id === recentBrowseSuccess);
        if (!resume && recent > 0) indices.unshift(...indices.splice(recent, 1));
        timer = setTimeout(() => controller.abort(Object.assign(new Error('本轮片库查询时间已到'), { code: 'BROWSE_DEFERRED' })), 16000);
      }
      let first;
      entry.done = false;
      entry.firstReady = new Promise(resolve => { first = resolve; });
      entry.promise = fromSources(indices, async i => {
        const source = sources[i];
        if (isBrowse) { entry.attempts[i]++; browseAttempts.set(source.id, Date.now()); }
        return load(source, signal, entry.results[i]?.partialPages);
      }, (result, position) => {
        const i = indices[position];
        result.source = sources[i];
        if (result.error?.code === 'BROWSE_DEFERRED') result = entry.results[i] || { source: sources[i], deferred: true };
        else if (result.error && entry.results[i]?.partialPages && !result.items) result = { ...entry.results[i], error: result.error };
        if (isBrowse && !result.error && result.items?.length) recentBrowseSuccess = sources[i].id;
        entry.results[i] = result;
        entry.snapshot = undefined;
        first();
      }, signal).then(() => {
        for (const i of indices) entry.results[i] ??= { source: sources[i], deferred: true };
        entry.done = true;
        const retryFailed = entry.results.some(result => result.error) && !entry.results.some(result => result.deferred);
        entry.expires = Date.now() + (retryFailed ? 15000 : ttl);
      }).finally(() => clearTimeout(timer));
    }
    if (progressive && !entry.done) {
      let timer;
      try { await Promise.race([entry.promise, entry.firstReady, new Promise(resolve => { timer = setTimeout(resolve, 150); })]); }
      finally { clearTimeout(timer); }
    } else await entry.promise;
    const result = format(entry.results.filter(Boolean), entry);
    if (cache === browseCache) result.deferredSources = entry.results.filter(row => row?.deferred).map(row => ({ source: row.source.id, name: row.source.name }));
    if (progressive) {
      result.complete = entry.done;
      result.pendingSources = entry.done ? [] : sources.filter((_, index) => !entry.results[index] || entry.results[index].deferred).map(source => ({ source: source.id, name: source.name }));
    } else if (result.failedSources.length && !result.deferredSources?.length && cache.get(key) === entry) cache.delete(key);
    return structuredClone(result);
  }
  async function query(source, parameters, priority = false, signal) {
    const url = validateUrl(source.api);
    for (const key of ['wd', 'ids', 't', 'pg', 'ac', 'year', 'class', 'sort_direction']) url.searchParams.delete(key);
    url.searchParams.set('ac', 'videolist');
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return limited(async () => {
      let response;
      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(failure('影视源请求超时')), 8000);
      const operation = (async () => {
        response = await request(url, { timeout: 8000, headers: { accept: 'application/json' }, signal: requestSignal });
        if (requestSignal.aborted) { response.destroy(); throw requestSignal.reason; }
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
        return await untilAborted(operation, requestSignal);
      } catch (cause) {
        if (requestSignal.aborted) { response?.destroy(); throw requestSignal.reason; }
        throw cause.status ? cause : failure('影视源请求失败', 502, cause);
      } finally { clearTimeout(timer); }
    }, priority, signal);
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
  async function sourceTypes(source, priority = false, signal) {
    const key = JSON.stringify([source.id, source.api]);
    for (;;) {
      signal?.throwIfAborted();
      try {
        return await untilAborted(cached(typeCache, key, 180000, async () => {
          const body = await query(source, { ac: 'list' }, priority, signal);
          return classifyTypes(Array.isArray(body.class) ? body.class : []);
        }), signal);
      } catch (error) {
        // Another browse batch may own the shared in-flight classification and reach its deadline.
        if (error.code !== 'BROWSE_DEFERRED' || signal?.aborted) throw error;
      }
    }
  }
  async function classifiedVideos(source, body, priority = false) {
    const list = videos(body);
    const types = Array.isArray(body.class) ? classifyTypes(body.class) : list.some(video => video?.type_id != null) ? await sourceTypes(source, priority) : undefined;
    return types ? list.map(video => types.categories.get(String(video?.type_id)) === 'adult' ? { ...video, _catalogAdult: true } : video) : list;
  }
  async function sourceBrowse(source, category, page, { genre, year }, signal, partialPages = new Map()) {
    const types = await sourceTypes(source, false, signal);
    const readPage = async type => {
      const saved = partialPages.get(type?.id);
      if (saved) return saved;
      const body = await query(source, { pg: page, ...(type ? { t: type.id } : {}), ...(year ? { year } : {}) }, false, signal);
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
      const result = { videos: filtered.filter(video => (!year || String(video.vod_year || '').trim() === year) && (!genre || genres(video).includes(genre))),
        categoryCount: filtered.length, hasMore: hasMore(body, page) };
      catalogItems(result, category, source);
      partialPages.set(type?.id, result);
      return result;
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
    const result = { items: [], hasMore: false };
    const errors = [];
    const children = genreTypes.length ? genreTypes : leaves;
    const remaining = children.filter(child => !partialPages.get(child.id));
    // Finish unvisited subcategories before retrying those interrupted in an earlier round.
    remaining.sort((a, b) => Number(partialPages.has(a.id)) - Number(partialPages.has(b.id)));
    await fromSources(remaining, child => {
      partialPages.set(child.id, null);
      return readPage(child);
    }, row => {
      if (row.error && row.error.code !== 'BROWSE_DEFERRED') partialPages.set(row.source.id, { error: row.error.message });
    }, signal);
    for (const child of children) {
      const pageResult = partialPages.get(child.id);
      if (!pageResult) result.deferred = true;
      else if (pageResult.error) errors.push(pageResult.error);
      else {
        result.items.push(...pageResult.items);
        result.hasMore ||= pageResult.hasMore;
      }
    }
    if (errors.length) result.error = failure(errors.join('；'));
    if (result.deferred) result.partialPages = partialPages;
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

    async browse(config, { category = 'movie', page = 1, source: sourceId, progressive = false, resume = false, genre = '', year = '', country = '', platform = '', sort = 'updated' } = {}) {
      if (typeof category !== 'string' || !Object.hasOwn(ROOT_NAMES, category)) throw failure('分类必须为 movie、tv、anime、variety 或 adult', 400);
      if (category === 'adult' && config.showAdult !== true) throw failure('三级内容已隐藏，请先在设置中开启显示', 403);
      if (!((typeof page === 'number' && Number.isInteger(page)) || (typeof page === 'string' && /^[1-9]\d{0,2}$/.test(page))) || Number(page) < 1 || Number(page) > 100) throw failure('页码必须为 1 到 100 的整数', 400);
      page = Number(page);
      if (typeof genre !== 'string' || genre && !Object.hasOwn(GENRES, genre)) throw failure('影片类型无效，请选择提供的类型', 400);
      const currentYear = new Date().getFullYear();
      if (typeof year !== 'string' || year && (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > currentYear + 3)) throw failure('上映年份必须为 1900 至当前年份加 3 的四位年份', 400);
      if (!['updated', 'release', 'year'].includes(sort)) throw failure('排序方式无效', 400);
      if (!validCountryFilter(country) || !['', 'netflix'].includes(platform)) throw failure('制片国家/地区或平台筛选无效', 400);
      country = normalizeCountries(country)[0] || '';
      const sources = config.sources.filter(source => source.enabled !== false && (sourceId === undefined || source.id === sourceId));
      if (sourceId !== undefined && !sources.length) throw failure('影视源不存在或已停用', 400);
      const filters = { genre, year, country, platform, sort };
      const scope = JSON.stringify([signature(config), category, sourceId, genre]);
      const key = JSON.stringify([scope, page, year]);
      return batch(browseCache, key, 180000, sources, (source, signal, partialPages) => sourceBrowse(source, category, page, filters, signal, partialPages), (results, entry) => {
        const snapshot = browseSnapshot(entry, category);
        const facets = { genres: Object.keys(GENRES), years: new Set(), countries: new Set() };
        const matches = item => (!year || item.year === year) && (!country || item.countries.includes(country)) && (!platform || item.netflix);
        const result = { ...snapshot, groups: snapshot.groups.filter(matches) };
        const includeKnown = page === 1 && (country || platform || year);
        const seen = new Set(result.groups.map(group => group.key));
        const known = [];
        const collect = rows => {
          for (const item of rows) {
            if (platform && !item.netflix) continue;
            if ((!country || item.countries.includes(country)) && /^\d{4}$/.test(item.year) && +item.year >= 1900 && +item.year <= currentYear + 3) facets.years.add(item.year);
            if (!year || year === item.year) for (const name of item.countries) facets.countries.add(name);
          }
        };
        collect(snapshot.groups);
        // Keep options from loaded pages and other year selections for the lifetime of their source responses.
        entry.facetScope = scope;
        for (const other of browseCache.values()) {
          if (other === entry || other.facetScope !== scope || other.done && other.expires <= Date.now()) continue;
          const rows = browseSnapshot(other, category).groups;
          collect(rows);
          if (!includeKnown || known.length >= 100) continue;
          for (const row of rows) {
            if (seen.has(row.key) || !matches(row)) continue;
            seen.add(row.key);
            known.push(row);
            if (known.length === 100) break;
          }
        }
        // The client merges these known matches by film key without skipping subsequent source pages.
        if (known.length) result.cachedMatches = known;
        // 采集 API 按资源更新时间分页；上映顺序只适用于已加载的影片。
        if (sort !== 'updated') {
          const value = item => sort === 'release' ? item.releaseDate : /^\d{4}$/.test(item.year) ? item.year : '';
          const compare = (a, b) => value(b).localeCompare(value(a)) || a.title.localeCompare(b.title, 'zh-CN');
          result.groups.sort(compare); known.sort(compare);
        }
        return { category, page, ...result, filters, facets: { genres: facets.genres, years: [...facets.years].sort().reverse(), countries: [...facets.countries].sort((a, b) => a.localeCompare(b, 'zh-CN')) },
          sortScope: 'loaded', hasMore: results.some(result => result.hasMore === true) };
      }, progressive, resume);
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
        const aliases = [...new Set(String(video.vod_sub || '').slice(0, 2048).normalize('NFKC').replace(/https?:\/\/[^\s|、;；]+/gi, '').replace(/<[^>]*>|[\u0000-\u001f\u007f]/g, ' ')
          .split(/[/|、;；]/).map(value => value.trim()).filter(value => value.length >= 2 && value.length <= 300 && value !== item.title && !/https?:\/\//i.test(value)))].slice(0, 2);
        return { ...item, description, ...(aliases.length ? { aliases } : {}), ...(quarkShares.length ? { quarkShares } : {}) };
      });
      if (item.category === 'adult' && config.showAdult !== true) throw failure('三级内容已隐藏，请先在设置中开启显示', 403);
      if (!item.lines.length) { detailCache.delete(key); throw failure('该影片没有可用的 HTTP / HTTPS 播放线路'); }
      return structuredClone(item);
    },
  };
}

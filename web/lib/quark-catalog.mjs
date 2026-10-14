import { request as networkRequest, readText } from './network.mjs';

const ORIGIN = 'https://m.douban.com';
const API = `${ORIGIN}/rexxar/api/v2/`;
const CACHE_KEY = 'quark-library-douban-v1';
const HOUR = 3600000;
const PAGE_SIZE = 20;
const POSTER_HOSTS = new Set(['img1.doubanio.com', 'img2.doubanio.com', 'img3.doubanio.com', 'img5.doubanio.com', 'img9.doubanio.com']);
const GENRES = ['剧情', '喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '恐怖', '冒险', '奇幻', '家庭', '历史', '战争', '传记', '音乐', '歌舞', '武侠', '古装', '运动', '灾难', '西部', '纪录片', '短片', '真人秀', '脱口秀'];
const ADULT = /^(?:情色|色情|成人|伦理|倫理|三级|三級|限制级|限制級|里番|裏番|hentai|r-?18\+?)$/i;
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const clone = value => JSON.parse(JSON.stringify(value));
const idOf = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? String(value) : '';
const text = (value, limit = 300) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, limit) : '';
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const scoreOf = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 10 ? Number(value) : null;

function posterOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && POSTER_HOSTS.has(url.hostname.toLowerCase()) ? url.href : '';
  } catch { return ''; }
}

function dateOf(values) {
  const dates = (Array.isArray(values) ? values : [values]).slice(0, 30).map(value => {
    const found = String(value ?? '').match(/^((?:18|19|20)\d{2})-(\d{2})-(\d{2})(?:$|T|\s|\()/);
    if (!found) return '';
    const date = found.slice(1).join('-'), parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
  }).filter(Boolean);
  return dates.sort()[0] || '';
}

function metadata(raw, hint, detailed = false, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !['movie', 'tv'].includes(raw.type)) return null;
  const id = idOf(raw.id), originalTitle = text(raw.title), subtitle = text(raw.card_subtitle, 1500);
  const names = [originalTitle, ...(Array.isArray(raw.aka) ? raw.aka.slice(0, 20).map(value => text(value)) : [])];
  const title = names.find(value => /\p{Script=Han}/u.test(value)) || originalTitle;
  if (!id || !title || raw.is_restrictive === true) return null;
  const parts = Array.isArray(raw.genres) ? raw.genres.map(value => text(value, 40)) : (subtitle.split(' / ')[2] || '').split(/\s+/);
  if (parts.some(value => ADULT.test(value))) return null;
  const genres = [...new Set(parts.filter(value => GENRES.includes(value)))];
  const category = genres.includes('动画') ? 'anime' : hint === 'variety' || raw.is_show === true || genres.some(value => ['真人秀', '脱口秀'].includes(value)) ? 'variety' : raw.type === 'movie' ? 'movie' : 'tv';
  const type = raw.type === 'movie' ? 'movie' : 'series';
  const year = /^(?:18|19|20)\d{2}$/.test(String(raw.year ?? '')) ? String(raw.year) : '';
  const releaseDate = dateOf([...(Array.isArray(raw.pubdate) ? raw.pubdate : [raw.pubdate]), raw.release_date]);
  const aliases = [], seen = new Set([normalized(title)]);
  for (const value of [raw.original_title, ...names].map(value => text(value))) {
    const key = normalized(value);
    if (!key || seen.has(key)) continue;
    seen.add(key); aliases.push(value);
  }
  const score = raw.rating?.count === 0 || raw.rating?.max !== undefined && raw.rating.max !== 10 ? null : scoreOf(raw.rating?.value ?? raw.rate);
  const votes = Number.isSafeInteger(raw.rating?.count) && raw.rating.count >= 0 ? raw.rating.count : undefined;
  const today = new Date(now).toISOString().slice(0, 10), availableDate = dateOf(raw.playable_date);
  const releaseStatus = raw.is_released === false ? 'upcoming' : raw.is_released === true ? 'released'
    : year && Number(year) > Number(today.slice(0, 4)) || releaseDate && releaseDate > today ? 'upcoming'
    : releaseDate && releaseDate <= today || availableDate && availableDate <= today ? 'released'
      : score !== null && votes > 0 ? 'screened' : 'unknown';
  const synopsis = text(raw.intro, 1600), han = [...synopsis.matchAll(/\p{Script=Han}/gu)].length;
  const foreignScript = [...synopsis.matchAll(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)].length;
  const chineseSynopsis = han >= 3 && han >= [...synopsis.matchAll(/\p{L}/gu)].length * 0.2 && foreignScript < Math.max(4, han * 0.2);
  const typeName = ({ movie: '电影', tv: '电视剧', anime: '动漫', variety: '综艺' })[category];
  const description = chineseSynopsis ? synopsis : `豆瓣暂无中文剧情简介。${year ? `${year}年` : ''}${typeName}${genres.length ? `，类型：${genres.join('、')}` : ''}。`;
  const count = [raw.episodes_count, raw.last_episode_number].find(value => Number.isSafeInteger(value) && value > 0 && value <= 1000);
  const episodes = type === 'movie' ? [{ name: '正片' }] : Array.from({ length: count || 1 }, (_, index) => ({ name: `第${index + 1}集` }));
  return { source: 'quark-library', id, key: `quark-library:${id}`, title, year, type, category,
    poster: [raw.pic?.large, raw.pic?.normal, raw.cover].map(posterOf).find(Boolean) || '', genres, releaseDate, aliases, originalTitle: text(raw.original_title),
    description, descriptionLanguage: chineseSynopsis ? 'zh' : 'unavailable', ...(synopsis && !chineseSynopsis ? { originalDescription: synopsis } : {}), typeName, releaseStatus,
    episodeCount: type === 'movie' ? 1 : count || null,
    douban: { id, score, ...(votes === undefined ? {} : { votes }), url: `https://movie.douban.com/subject/${id}/`, attribution: detailed ? '豆瓣公开条目' : '豆瓣公开列表' },
    lines: [{ name: '夸克网盘', episodes }] };
}

function restoreItem(item, now) {
  if (!item || item.source !== 'quark-library' || !['movie', 'tv', 'anime', 'variety'].includes(item.category)) return null;
  const normalized = metadata({ id: item.id, title: item.title, type: item.type === 'movie' ? 'movie' : item.type === 'series' ? 'tv' : '',
    year: item.year, genres: item.genres, pubdate: item.releaseDate, aka: item.aliases, original_title: item.originalTitle, intro: item.originalDescription || (item.descriptionLanguage === 'unavailable' ? '' : item.description),
    is_released: item.releaseStatus === 'released' ? true : item.releaseStatus === 'upcoming' ? false : undefined,
    pic: { large: item.poster }, rating: { value: item.douban?.score, count: item.douban?.votes }, episodes_count: item.episodeCount }, item.category, item.douban?.attribution === '豆瓣公开条目', now);
  return normalized;
}

export function createQuarkCatalog({ store, request = networkRequest, now = Date.now } = {}) {
  if (!store?.meta || !store?.setMeta) throw new Error('夸克影院需要 SQLite 存储');
  const pages = new Map(), subjects = new Map(), flights = new Map(), controllers = new Set(), waiting = [], failures = new Map();
  let active = 0, stopped = false;
  const saved = store.meta(CACHE_KEY);
  if (typeof saved === 'string' && saved.length <= 2 * 1024 * 1024) {
    try {
      const data = JSON.parse(saved);
      for (const [id, entry] of Array.isArray(data.subjects) ? data.subjects.slice(-300) : []) {
        const item = restoreItem(entry?.item, now());
        if (item && item.id === id && Number.isFinite(entry.at) && entry.at <= now() && entry.at > now() - 7 * 24 * HOUR) subjects.set(id, { item, at: entry.at, detailed: data.version === 4 && entry.detailed === true });
      }
      for (const [key, entry] of data.version === 4 && Array.isArray(data.pages) ? data.pages.slice(-32) : []) {
        if (typeof key !== 'string' || key.length > 200 || !Number.isFinite(entry?.at) || entry.at > now() || entry.at <= now() - 7 * 24 * HOUR || !Array.isArray(entry.items)) continue;
        const items = entry.items.slice(0, 40).map(id => subjects.get(idOf(id))?.item).filter(Boolean);
        if (items.length === entry.items.length) pages.set(key, { at: entry.at, items, hasMore: entry.hasMore === true,
          errors: Array.isArray(entry.errors) ? entry.errors.slice(0, 2).map(value => text(value, 200)).filter(Boolean) : [], stale: entry.stale === true });
      }
    } catch { console.error('夸克影院目录缓存无法读取，已重新建立缓存'); }
  }

  function persist() {
    while (pages.size > 32) pages.delete(pages.keys().next().value);
    while (subjects.size > 300) subjects.delete(subjects.keys().next().value);
    const serialize = () => JSON.stringify({
      version: 4,
      pages: [...pages].map(([key, entry]) => [key, { ...entry, items: entry.items.map(item => item.id) }]),
      subjects: [...subjects].map(([id, entry]) => { const { lines, ...item } = entry.item; return [id, { ...entry, item }]; }),
    });
    let saved = serialize();
    while (Buffer.byteLength(saved) > 2 * 1024 * 1024) {
      if (pages.size) pages.delete(pages.keys().next().value);
      else if (subjects.size) subjects.delete(subjects.keys().next().value);
      else break;
      saved = serialize();
    }
    store.setMeta(CACHE_KEY, saved);
  }

  function register(item, detailed) {
    const old = subjects.get(item.id);
    const merged = !detailed && old?.detailed ? { ...old.item, poster: item.poster || old.item.poster, douban: item.douban.score === null ? old.item.douban : item.douban } : item;
    if (!detailed && item.releaseStatus === 'unknown' && ['released', 'screened'].includes(old?.item.releaseStatus)) merged.releaseStatus = old.item.releaseStatus;
    subjects.delete(item.id);
    subjects.set(item.id, { item: merged, at: detailed || !old?.detailed ? now() : old.at, detailed: detailed || old?.detailed === true });
    return merged;
  }

  async function limited(work, signal) {
    signal.throwIfAborted();
    if (active < 2) active++;
    else {
      if (waiting.length >= 32) throw failure('夸克影院请求较多，请稍后再试', 503);
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, abort: () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); } };
        waiting.push(entry);
        signal.addEventListener('abort', entry.abort, { once: true });
      });
    }
    try { signal.throwIfAborted(); return await work(); }
    finally {
      const next = waiting.shift();
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
      else active--;
    }
  }

  async function load(key, work) {
    if (stopped) throw failure('夸克影院已停止', 503);
    if (flights.has(key)) return clone(await flights.get(key));
    if (flights.size >= 32) throw failure('夸克影院请求较多，请稍后再试', 503);
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(failure('豆瓣目录读取超时，请稍后再试', 504)), 8000);
    let abort;
    const job = Promise.race([work(controller.signal), new Promise((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    })]);
    flights.set(key, job);
    try { return clone(await job); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controllers.delete(controller); flights.delete(key); }
  }

  async function fetchJson(path, signal) {
    return limited(async () => {
      let response;
      try {
        response = await request(new URL(path, API).href, { timeout: 8000, followRedirects: false, signal,
          headers: { accept: 'application/json', referer: `${ORIGIN}/`, 'user-agent': 'Mozilla/5.0 VipVideoWeb/1.0' } });
        response.on('error', () => {});
        signal.throwIfAborted();
        const movieId = path.match(/^movie\/([1-9]\d*)$/)?.[1];
        if (movieId && [301, 302, 307, 308].includes(response.statusCode) && response.headers?.location) {
          const target = new URL(response.headers.location, API);
          if (target.href === `${API}tv/${movieId}`) throw failure('该豆瓣条目属于电视剧', 404);
        }
        if (response.statusCode !== 200) throw failure([403, 429].includes(response.statusCode) ? '豆瓣目录暂需验证或访问受限，请稍后再试' : `豆瓣目录返回 HTTP ${response.statusCode}`, response.statusCode === 404 ? 404 : 502);
        if (response.finalUrl && (new URL(response.finalUrl).origin !== ORIGIN || new URL(response.finalUrl).pathname !== new URL(path, API).pathname)) throw failure('豆瓣目录暂需验证，请稍后再试');
        const abort = () => response.destroy(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        try {
          const body = await readText(response, 512 * 1024);
          signal.throwIfAborted();
          let json;
          try { json = JSON.parse(body); } catch { throw failure('豆瓣目录格式暂不可读取，请稍后再试'); }
          if (!json || typeof json !== 'object' || Array.isArray(json)) throw failure('豆瓣目录格式暂不可读取，请稍后再试');
          return json;
        } finally { signal.removeEventListener('abort', abort); }
      } catch (error) {
        // 安全传输会先拒绝 301；只允许下一步查询同 ID 的固定电视剧接口。
        if (/^movie\/[1-9]\d*$/.test(path) && error.message === '此请求不允许重定向') throw failure('该豆瓣条目可能属于电视剧', 404);
        throw error.status ? error : failure('豆瓣目录连接失败，请稍后再试');
      }
      finally { response?.destroy(); }
    }, signal);
  }

  function filters(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('夸克影院筛选条件无效', 400);
    const category = options.category || 'movie', genre = options.genre || '', year = String(options.year || ''), sort = options.sort || 'release', page = Number(options.page ?? 1);
    if (!['movie', 'tv', 'anime', 'variety'].includes(category) || genre && !GENRES.includes(genre) || year && (!/^(?:18|19|20)\d{2}$/.test(year) || Number(year) < 1888 || Number(year) > new Date(now()).getUTCFullYear() + 2) || !['release', 'release-score', 'score'].includes(sort) || !Number.isSafeInteger(page) || page < 1 || page > 25) throw failure('夸克影院筛选条件无效', 400);
    return { category, genre, year, sort, page };
  }

  function result(entry, values, errors = entry.errors || [], stale = entry.stale === true) {
    const year = new Date(now()).getUTCFullYear();
    const items = entry.items.map(item => subjects.get(item.id)?.item || item).filter(item => ['released', 'screened'].includes(item.releaseStatus)
      && (!values.year || item.year === values.year) && (!values.genre || item.genres.includes(values.genre))
      && (values.category !== 'anime' || item.category === 'anime') && (values.category !== 'tv' || item.category === 'tv') && (values.category !== 'variety' || item.category === 'variety'));
    const years = [...new Set([...Array.from({ length: year - 1886 }, (_, index) => String(year + 1 - index)), ...entry.items.map(item => item.year).filter(Boolean)])].sort((a, b) => Number(b) - Number(a));
    return { ...values, items: clone(items), hasMore: entry.hasMore, facets: { genres: [...GENRES], years }, errors: [...errors], stale,
      attribution: '豆瓣公开目录', sortLabel: values.sort === 'score' ? '已上映片目，豆瓣高分优先' : values.sort === 'release-score' ? '热门已上映片目，年份优先、同年高分优先' : '热门已上映片目，上映年份优先' };
  }

  return {
    poster(value) {
      const id = idOf(value);
      if (stopped || !id) return undefined;
      const item = subjects.get(id)?.item || [...pages.values()].flatMap(page => page.items).find(item => item.id === id);
      return item?.poster || undefined;
    },

    async browse(options = {}) {
      if (stopped) throw failure('夸克影院已停止', 503);
      const values = filters(options), key = JSON.stringify(values), cached = pages.get(key);
      if (cached && cached.at + (cached.errors?.length ? 60000 : HOUR) > now()) return result(cached, values);
      const recentFailure = failures.get(key);
      if (recentFailure && recentFailure.until > now()) return result(cached || { items: [], hasMore: false }, values, recentFailure.errors, !!cached);
      return load(`browse:${key}`, async signal => {
        const started = Date.now();
        const kinds = values.category === 'anime' ? ['movie', 'tv'] : [values.category === 'movie' ? 'movie' : 'tv'];
        const errors = [], rows = [], failedKinds = new Set(), unconfirmed = new Map();
        let hasMore = false, successes = 0;
        await Promise.all(kinds.map(async kind => {
          const tags = [...new Set([values.category === 'anime' ? '动画' : values.category === 'variety' ? '综艺' : kind === 'tv' ? '电视剧' : '', values.genre, values.year].filter(Boolean))];
          const query = new URLSearchParams({ refresh: '0', start: String((values.page - 1) * PAGE_SIZE), count: String(PAGE_SIZE), uncollect: 'false', tags: tags.join(','), sort: values.sort === 'score' ? 'S' : 'U' });
          try {
            const data = await fetchJson(`${kind}/recommend?${query}`, signal);
            if (!Array.isArray(data.items) || data.items.length > 100) throw failure('豆瓣目录格式暂不可读取，请稍后再试');
            successes++;
            const total = Number(data.total);
            hasMore ||= Number.isFinite(total) && total >= 0 ? values.page * PAGE_SIZE < total : data.items.length >= PAGE_SIZE;
            for (const raw of data.items) {
              const item = metadata(raw, values.category, false, now());
              if (!item || item.type !== (kind === 'movie' ? 'movie' : 'series') || values.category === 'anime' && item.category !== 'anime' || values.category === 'tv' && item.category !== 'tv' || values.category === 'variety' && item.category !== 'variety' || values.year && item.year !== values.year || values.genre && !item.genres.includes(values.genre)) continue;
              if (item.releaseStatus === 'upcoming') continue;
              const known = subjects.get(item.id);
              if (item.releaseStatus === 'unknown' && known?.item.releaseStatus === 'upcoming' && known.at + 6 * HOUR > now()) continue;
              if (item.releaseStatus === 'unknown' && (!known || !['released', 'screened'].includes(known.item.releaseStatus))) unconfirmed.set(item.id, { item, kind });
              else { const registered = register(item, false); if (['released', 'screened'].includes(registered.releaseStatus)) rows.push(registered); }
            }
          } catch (error) { failedKinds.add(kind); errors.push(error.status ? error.message : '豆瓣目录暂不可读取，请稍后再试'); }
        }));
        signal.throwIfAborted();
        const budget = Math.max(0, Math.min(2000, 7000 - (Date.now() - started)));
        let unverified = unconfirmed.size;
        if (unconfirmed.size && budget >= 250) {
          const verification = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
          await Promise.all([...unconfirmed.values()].slice(0, 4).map(async ({ item, kind }) => {
            try {
              const raw = await fetchJson(`${kind}/${item.id}`, verification);
              if (idOf(raw.id) !== item.id || raw.type !== kind) return;
              const checked = metadata(raw, values.category, true, now());
              if (checked && checked.releaseStatus !== 'unknown') unverified--;
              if (checked?.releaseStatus === 'upcoming') register(checked, true);
              if (checked && ['released', 'screened'].includes(checked.releaseStatus) && (!values.year || checked.year === values.year) && (!values.genre || checked.genres.includes(values.genre)) && (values.category !== 'anime' || checked.category === 'anime') && (values.category !== 'tv' || checked.category === 'tv') && (values.category !== 'variety' || checked.category === 'variety')) rows.push(register(checked, true));
            } catch { /* 汇总到下方可重试提示，不让单条核验失败阻塞已确认的片目。 */ }
          }));
        }
        signal.throwIfAborted();
        if (unverified) errors.push('部分未评分片目暂未核实上映状态，已隐藏；可稍后重试或继续翻页');
        if (!successes) {
          failures.set(key, { until: now() + 60000, errors: [...new Set(errors)] });
          while (failures.size > 32) failures.delete(failures.keys().next().value);
          return result(cached || { items: [], hasMore: false }, values, [...new Set(errors)], !!cached);
        }
        if (cached && failedKinds.size) {
          rows.push(...cached.items.filter(item => ['released', 'screened'].includes(item.releaseStatus) && failedKinds.has(item.type === 'movie' ? 'movie' : 'tv')));
          hasMore ||= cached.hasMore;
        }
        const items = [...new Map(rows.map(item => [item.id, item])).values()];
        // 热门候选按真实上映年份排序，不拿上线日期或未上映排期冒充首映时间。
        if (values.sort === 'score') items.sort((a, b) => (b.douban.score ?? -1) - (a.douban.score ?? -1));
        else items.sort((a, b) => b.year.localeCompare(a.year) || Number(b.douban.score !== null) - Number(a.douban.score !== null) || Number(/\p{Script=Han}/u.test(b.title)) - Number(/\p{Script=Han}/u.test(a.title)) || (values.sort === 'release-score' ? (b.douban.score ?? -1) - (a.douban.score ?? -1) : 0));
        const entry = { at: now(), items, hasMore, errors: [...new Set(errors)], stale: !!cached && failedKinds.size > 0 };
        pages.delete(key);
        pages.set(key, entry);
        persist();
        return result(entry, values, [...new Set(errors)]);
      }).catch(error => {
        if (stopped) throw error;
        return result(cached || { items: [], hasMore: false }, values, [error.status ? error.message : '豆瓣目录暂不可读取，请稍后再试'], !!cached);
      });
    },

    async detail(value) {
      if (stopped) throw failure('夸克影院已停止', 503);
      const id = idOf(value);
      if (!id) throw failure('豆瓣条目标识无效', 400);
      const cached = subjects.get(id);
      if (cached?.detailed && cached.at + 6 * HOUR > now()) return clone({ ...cached.item, errors: [], stale: false });
      return load(`detail:${id}`, async signal => {
        const kinds = cached ? [cached.item.type === 'movie' ? 'movie' : 'tv'] : ['movie', 'tv'];
        let last;
        for (const kind of kinds) {
          try {
            const raw = await fetchJson(`${kind}/${id}`, signal);
            if (idOf(raw.id) !== id || raw.type !== kind) throw failure('豆瓣条目信息不匹配，暂不可读取');
            const item = metadata(raw, cached?.item.category, true, now());
            if (!item) throw Object.assign(failure('此豆瓣条目不在夸克影院展示范围', 404), { excluded: true });
            register(item, true);
            persist();
            return { ...item, errors: [], stale: false };
          } catch (error) {
            last = error;
            if (error.excluded) throw error;
            if (error.status !== 404 || signal.aborted) break;
          }
        }
        if (cached) return { ...cached.item, errors: [last?.message || '豆瓣详情暂不可读取'], stale: true };
        throw last || failure('豆瓣条目暂不可读取');
      }).catch(error => {
        if (stopped || !cached || error.excluded) throw error;
        return clone({ ...cached.item, errors: [error.status ? error.message : '豆瓣详情暂不可读取'], stale: true });
      });
    },

    async stop() {
      stopped = true;
      for (const controller of controllers) controller.abort(failure('夸克影院已停止', 503));
      await Promise.allSettled([...flights.values()]);
    },
  };
}

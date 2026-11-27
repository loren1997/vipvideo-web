import { request as networkRequest, readText } from './network.mjs';
import { catalogLanguage, catalogSeason, knownMotionComicSeries, MOTION_COMIC_SEEDS, motionComicSeriesKey, motionComicTags, motionComicTitle, normalizeCountries, shortDramaGenre, validCountryFilter } from './catalog-filters.mjs';
import { isNetflixId, NETFLIX_GENRES } from './netflix-catalog.mjs';

const ORIGIN = 'https://m.douban.com';
const API = `${ORIGIN}/rexxar/api/v2/`;
const CACHE_KEY = 'quark-library-douban-v1';
const HOUR = 3600000;
const PAGE_SIZE = 20;
const LANGUAGE_WARNING = '部分片目暂未核实原声语言，已暂时隐藏';
const COMIC_WARNING = '部分动画暂未核实节目形态，已暂时隐藏';
const CATEGORY_NAME = { movie: '电影', tv: '电视剧', anime: '动漫', 'motion-comic': '漫剧', variety: '综艺' };
const markComic = item => Object.assign(item, { category: 'motion-comic', typeName: CATEGORY_NAME['motion-comic'] });
const POSTER_HOSTS = new Set(['img1.doubanio.com', 'img2.doubanio.com', 'img3.doubanio.com', 'img5.doubanio.com', 'img9.doubanio.com']);
const GENRES = ['剧情', '喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '恐怖', '冒险', '奇幻', '家庭', '历史', '战争', '传记', '音乐', '歌舞', '武侠', '古装', '运动', '灾难', '西部', '纪录片', '短片', '真人秀', '脱口秀'];
const ADULT = /^(?:情色|色情|成人|伦理|倫理|三级|三級|限制级|限制級|里番|裏番|hentai|r-?18\+?)$/i;
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const clone = value => JSON.parse(JSON.stringify(value));
const idOf = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? String(value) : '';
export const validQuarkTitleId = value => Boolean(idOf(value) || isNetflixId(value));
const text = (value, limit = 300) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, limit) : '';
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const scoreOf = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 10 ? Number(value) : null;
const validYear = (year, now) => /^(?:18|19|20)\d{2}$/.test(year) && Number(year) >= 1888 && Number(year) <= new Date(now).getUTCFullYear() + 2;

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

function metadata(raw, detailed = false, now = Date.now(), confirmedComic = false) {
  if (!raw || typeof raw !== 'object' || !['movie', 'tv'].includes(raw.type)) return null;
  const id = idOf(raw.id), originalTitle = text(raw.title), subtitle = text(raw.card_subtitle, 1500);
  const names = [originalTitle, ...(Array.isArray(raw.aka) ? raw.aka.slice(0, 20).map(value => text(value)) : [])];
  const title = names.find(value => /\p{Script=Han}/u.test(value)) || originalTitle;
  if (!id || !title || raw.is_restrictive === true) return null;
  const parts = Array.isArray(raw.genres) ? raw.genres.map(value => text(value, 40)) : (subtitle.split(' / ')[2] || '').split(/\s+/);
  if (parts.some(value => ADULT.test(value))) return null;
  const genres = [...new Set(parts.filter(value => GENRES.includes(value)))];
  const tags = Array.isArray(raw.tags) ? raw.tags.slice(0, 24).map(tag => tag?.name || tag?.title || tag) : [];
  const animated = genres.includes('动画');
  const comic = confirmedComic || motionComicTitle(title) || motionComicTitle(raw.original_title) || motionComicTags([...parts, ...tags], animated)
    || animated && (parts.some(shortDramaGenre) || [title, raw.original_title].some(knownMotionComicSeries));
  const category = raw.type === 'movie' ? 'movie' : comic ? 'motion-comic' : animated ? 'anime'
    : raw.is_show === true || genres.some(value => ['真人秀', '脱口秀'].includes(value)) ? 'variety' : 'tv';
  const type = raw.type === 'movie' ? 'movie' : 'series';
  const card = subtitle.split(/\s+\/\s+/);
  const year = [String(raw.year ?? ''), card[0]].find(y => /^(?:18|19|20)\d{2}$/.test(y)) || '';
  let countries = normalizeCountries(raw.countries || raw.production_countries);
  if (!countries.length && /^\d{4}$/.test(card[0])) countries = normalizeCountries(card[1]);
  const languageLabels = Array.isArray(raw.languages) ? raw.languages.slice(0, 24)
    : typeof raw.languages === 'string' ? raw.languages.slice(0, 600).split(/[,，/、]+/) : undefined;
  const languages = languageLabels && [...new Set(languageLabels.map(catalogLanguage).filter(Boolean))];
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
  const typeName = CATEGORY_NAME[category];
  const description = chineseSynopsis ? synopsis : `豆瓣暂无中文剧情简介。${year ? `${year}年` : ''}${typeName}${genres.length ? `，类型：${genres.join('、')}` : ''}。`;
  const count = [raw.episodes_count, raw.last_episode_number].find(value => Number.isSafeInteger(value) && value > 0 && value <= 1000);
  const episodes = type === 'movie' ? [{ name: '正片' }] : Array.from({ length: count || 1 }, (_, index) => ({ name: `第${index + 1}集` }));
  return { source: 'quark-library', id, key: `quark-library:${id}`, title, year, type, category, countries, ...(languages ? { languages } : {}),
    ...(type === 'series' ? catalogSeason(title, id) : undefined),
    poster: [raw.pic?.large, raw.pic?.normal, raw.cover].map(posterOf).find(Boolean) || '', genres, releaseDate, aliases, originalTitle: text(raw.original_title),
    description, descriptionLanguage: chineseSynopsis ? 'zh' : 'unavailable', ...(synopsis && !chineseSynopsis ? { originalDescription: synopsis } : {}), typeName, releaseStatus,
    episodeCount: type === 'movie' ? 1 : count || null,
    douban: { id, score, ...(votes === undefined ? {} : { votes }), url: `https://movie.douban.com/subject/${id}/`, attribution: detailed ? '豆瓣公开条目' : '豆瓣公开列表' },
    lines: [{ name: '夸克网盘', episodes }] };
}

function restoreItem(item, now, version) {
  if (!item || item.source !== 'quark-library' || typeof item.category !== 'string' || !Object.hasOwn(CATEGORY_NAME, item.category)) return null;
  const normalized = metadata({ id: item.id, title: item.title, type: item.type === 'movie' ? 'movie' : item.type === 'series' ? 'tv' : '',
    year: item.year, countries: item.countries, genres: item.genres, languages: item.languages, pubdate: item.releaseDate, aka: item.aliases, original_title: item.originalTitle, intro: item.originalDescription || (item.descriptionLanguage === 'unavailable' ? '' : item.description),
    is_released: item.releaseStatus === 'released' ? true : item.releaseStatus === 'upcoming' ? false : undefined, is_show: version >= 9 && item.category === 'variety',
    pic: { large: item.poster }, rating: { value: item.douban?.score, count: item.douban?.votes }, episodes_count: item.episodeCount }, item.douban?.attribution === '豆瓣公开条目', now, version >= 10 && item.category === 'motion-comic');
  return normalized;
}

export function createQuarkCatalog({ store, request = networkRequest, now = Date.now, netflix } = {}) {
  if (!store?.meta || !store?.setMeta) throw new Error('夸克影院需要 SQLite 存储');
  const pages = new Map(), subjects = new Map(), flights = new Map(), controllers = new Set(), waiting = [], failures = new Map();
  const learnedComicFamilies = new Set(), checkedComicTags = new Map(), comicDiscoveryUntil = new Map();
  let active = 0, stopped = false;
  let comicIds = new Set(), shortComicItems = [], shortComicFamilies = new Set(), comicIndexUntil = -Infinity;
  const saved = store.meta(CACHE_KEY);
  if (typeof saved === 'string' && saved.length <= 2 * 1024 * 1024) {
    try {
      const data = JSON.parse(saved);
      const withFacets = [5, 6, 7, 8, 9, 10, 11, 12].includes(data.version);
      for (const [id, entry] of Array.isArray(data.subjects) ? data.subjects.slice(-300) : []) {
        const oldCategory = entry?.item?.category;
        const item = restoreItem(entry?.item, now(), data.version);
        if (item && item.id === id && Number.isFinite(entry.at) && entry.at <= now() && entry.at > now() - 7 * 24 * HOUR) subjects.set(id, { item, at: entry.at, detailed: withFacets && entry.detailed === true && (oldCategory !== 'variety' || item.category === 'variety'), comicDiscovery: data.version >= 10 && (entry.comicDiscovery === true || oldCategory === 'anime' && item.category === 'motion-comic') });
        if (data.version >= 11 && item?.category === 'motion-comic' && subjects.has(id)) learnedComicFamilies.add(motionComicSeriesKey(item.title));
      }
      for (const [key, entry] of withFacets && Array.isArray(data.pages) ? data.pages.slice(-32) : []) {
        if (typeof key !== 'string' || key.length > 200 || !Number.isFinite(entry?.at) || entry.at > now() || entry.at <= now() - 7 * 24 * HOUR || !Array.isArray(entry.items)) continue;
        if (key.includes('"platform":"netflix"')) continue;
        if (data.version < 12 && (key.includes('"category":"anime"') || key.includes('"category":"motion-comic"'))) continue;
        if (data.version < 9 && key.includes('"category":"variety"')) continue;
        const items = entry.items.slice(0, 40).map(id => subjects.get(idOf(id))?.item).filter(Boolean);
        const errors = Array.isArray(entry.errors) ? entry.errors.slice(0, 4).map(value => text(value, 200)).filter(Boolean) : [];
        const languageIncomplete = entry.languageIncomplete === true || entry.unavailable === true || errors.some(error => error.startsWith('部分片目暂未核实原声语言'));
        if (items.length === entry.items.length) pages.set(key, { at: entry.at, category: entry.category, items, hasMore: entry.hasMore === true,
          errors: errors.map(error => error.startsWith('部分片目暂未核实原声语言') ? LANGUAGE_WARNING : error), stale: entry.stale === true, languageIncomplete });
      }
    } catch { console.error('夸克影院目录缓存无法读取，已重新建立缓存'); }
  }

  function persist() {
    while (pages.size > 32) pages.delete(pages.keys().next().value);
    while (subjects.size > 300) subjects.delete(subjects.keys().next().value);
    const serialize = () => JSON.stringify({
      version: 12,
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

  function register(item, detailed, comicDiscovery = false) {
    const old = subjects.get(item.id);
    const merged = !detailed && old?.detailed ? { ...old.item, poster: item.poster || old.item.poster, douban: item.douban.score === null ? old.item.douban : item.douban } : item;
    if (item.category === 'motion-comic' && merged.type === 'series') markComic(merged);
    if (old && old.at + 6 * HOUR > now()) {
      if (!merged.countries.length) merged.countries = item.countries.length ? item.countries : old.item.countries;
      if (!merged.languages?.length) merged.languages = item.languages?.length ? item.languages : old.item.languages ?? item.languages;
    }
    if (!detailed && item.releaseStatus === 'unknown' && ['released', 'screened'].includes(old?.item.releaseStatus)) merged.releaseStatus = old.item.releaseStatus;
    subjects.delete(item.id);
    subjects.set(item.id, { item: merged, at: detailed || !old?.detailed ? now() : old.at, detailed: detailed || old?.detailed === true,
      comicDiscovery: comicDiscovery || old?.comicDiscovery === true });
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
          headers: { accept: 'application/json', 'accept-encoding': 'gzip, br', referer: `${ORIGIN}/`, 'user-agent': 'Mozilla/5.0 VipVideoWeb/1.0' } });
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

  async function comicChart(tags, count, signal) {
    const query = new URLSearchParams({ refresh: '0', start: '0', count, uncollect: 'false', tags, sort: 'U' });
    const { items } = await fetchJson(`tv/recommend?${query}`, signal);
    if (!Array.isArray(items) || items.length > 100) throw failure('豆瓣动画目录格式暂不可读取');
    return items.map(raw => metadata(raw, false, now())).filter(item => item?.type === 'series' && item.releaseStatus !== 'upcoming');
  }

  function learnComicFamily(item) {
    const family = motionComicSeriesKey(item.title);
    if (family) learnedComicFamilies.add(family);
    while (learnedComicFamilies.size > 300) learnedComicFamilies.delete(learnedComicFamilies.values().next().value);
  }

  async function resolveComicTags(item, signal) {
    const family = motionComicSeriesKey(item.title);
    if (learnedComicFamilies.has(family)) return true;
    const known = checkedComicTags.get(item.id);
    if (known?.until > now()) return known.comic;
    try {
      const { tags } = await fetchJson(`tv/${item.id}/tags?count=50`, AbortSignal.any([signal, AbortSignal.timeout(1400)]));
      if (!Array.isArray(tags) || !tags.length) return undefined;
      const comic = motionComicTags(tags.slice(0, 50).map(tag => text(tag?.name || tag?.title || tag)), true);
      checkedComicTags.set(item.id, { comic, until: now() + 6 * HOUR });
      while (checkedComicTags.size > 200) checkedComicTags.delete(checkedComicTags.keys().next().value);
      if (comic) learnComicFamily(item);
      return comic;
    } catch { return undefined; }
  }

  function saveComicDiscoveries(items, detailed = false) {
    let changed = false;
    for (const entry of subjects.values()) {
      if (entry.item.category !== 'anime' || !learnedComicFamilies.has(motionComicSeriesKey(entry.item.title))) continue;
      markComic(entry.item);
      entry.comicDiscovery = changed = true;
    }
    for (const item of items) {
      const old = subjects.get(item.id);
      if (!old?.comicDiscovery || detailed && !old.detailed) {
        register(markComic(item), detailed, true);
        changed = true;
      }
    }
    if (changed) {
      for (const [key, page] of pages) if (page.category === 'motion-comic') pages.delete(key);
      persist();
    }
  }

  async function refreshComicIndex() {
    if (comicIndexUntil > now()) return;
    try {
      await load('motion-comic-index', async signal => {
        // shortcut: index the first 100 entries per source; Anime browse also verifies candidate subjects on later pages.
        const probe = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
        const [tagged, distributor, short] = await Promise.allSettled([comicChart('漫剧', '100', probe), comicChart('动画,红果短剧', '100', probe), comicChart('动画,短剧', '100', probe)]);
        signal.throwIfAborted();
        const animated = item => item.category === 'anime' || item.category === 'motion-comic';
        if (tagged.status === 'fulfilled') comicIds = new Set(tagged.value.filter(animated).map(item => item.id));
        if (short.status === 'fulfilled') {
          shortComicItems = short.value;
          shortComicFamilies = new Set(shortComicItems.filter(animated).map(item => motionComicSeriesKey(item.title)));
        }
        const distributed = (distributor.value || []).filter(animated);
        for (const item of distributed) learnComicFamily(item);
        saveComicDiscoveries(distributed);
        comicIndexUntil = now() + ([tagged, distributor, short].every(result => result.status === 'fulfilled') ? HOUR : 60000);
        return true;
      });
    } catch { comicIndexUntil = now() + 60000; }
  }

  async function discoverComics(year) {
    if (comicDiscoveryUntil.get(year) > now()) return;
    let fresh = false;
    try {
      fresh = await load(`motion-comic-discovery:${year}`, async signal => {
        const probe = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const recent = await comicChart(`动画,${year}`, '100', probe).catch(() => null);
        const listed = [...(recent || []), ...shortComicItems];
        signal.throwIfAborted();
        for (const item of listed) if (item.category === 'motion-comic') learnComicFamily(item);
        const families = new Set([...listed, ...[...subjects.values()].map(({ item }) => item)]
          .filter(item => item.category === 'motion-comic').map(item => motionComicSeriesKey(item.title)));
        const missing = MOTION_COMIC_SEEDS.filter(([title]) => !families.has(motionComicSeriesKey(title)));
        const seeded = await Promise.allSettled(missing.map(async ([title, id]) => {
          const raw = await fetchJson(`tv/${id}`, probe);
          if (idOf(raw.id) !== id || raw.type !== 'tv') return false;
          const item = metadata(raw, true, now(), true);
          if (!item || item.releaseStatus === 'upcoming' || motionComicSeriesKey(item.title) !== motionComicSeriesKey(title)) return false;
          signal.throwIfAborted();
          register(item, true, true);
          return true;
        }));
        const candidates = new Map();
        for (const item of shortComicItems) {
          const family = motionComicSeriesKey(item.title);
          if (item.category === 'anime' && family && !learnedComicFamilies.has(family) && !candidates.has(family) && !(checkedComicTags.get(item.id)?.until > now())) candidates.set(family, item);
        }
        // shortcut: corroborate at most six new families per discovery; known families and explicit labels need no additional calls.
        const checks = [...candidates.values()].slice(0, 6);
        let finished = 0;
        await Promise.all([0, 1].map(async offset => {
          for (let i = offset; i < checks.length && !probe.aborted; i += 2) {
            if (await resolveComicTags(checks[i], probe) !== undefined) finished++;
          }
        }));
        signal.throwIfAborted();
        if (seeded.some(row => row.value === true)) {
          for (const [key, page] of pages) if (page.category === 'motion-comic') pages.delete(key);
          persist();
        }
        saveComicDiscoveries(listed.filter(item => item.category === 'motion-comic' || item.category === 'anime' && learnedComicFamilies.has(motionComicSeriesKey(item.title))));
        return recent !== null && finished === candidates.size && seeded.every(row => row.value === true);
      });
    } catch { /* The already known motion comics and dedicated feed remain usable. */ }
    comicDiscoveryUntil.set(year, now() + (fresh ? HOUR : 60000));
    while (comicDiscoveryUntil.size > 6) comicDiscoveryUntil.delete(comicDiscoveryUntil.keys().next().value);
  }

  function filters(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('夸克影院筛选条件无效', 400);
    const category = options.category || 'movie', genre = options.genre || '', year = String(options.year || ''), sort = options.sort || 'release', page = Number(options.page ?? 1);
    const { country = '', platform = '', language: selectedLanguage = 'all' } = options;
    const language = selectedLanguage === 'all' ? 'all' : catalogLanguage(selectedLanguage);
    if (!validCountryFilter(country) || !['', 'netflix'].includes(platform) || !language) throw failure('夸克影院国家、平台或语言筛选条件无效', 400);
    const validGenre = !genre || (platform ? NETFLIX_GENRES.has(genre) : GENRES.includes(genre));
    const maxPage = platform ? Math.floor(Number.MAX_SAFE_INTEGER / 30) : 25;
    if (typeof category !== 'string' || !Object.hasOwn(CATEGORY_NAME, category) || !validGenre || year && !validYear(year, now()) || !['release', 'release-score', 'score'].includes(sort) || !Number.isSafeInteger(page) || page < 1 || page > maxPage) throw failure('夸克影院筛选条件无效', 400);
    return { category, genre, year, country: normalizeCountries(country)[0] || '', platform, sort, page, language };
  }

  function result(entry, values, errors = entry.errors || [], stale = entry.stale === true) {
    const resolve = item => subjects.get(item.id)?.item || item;
    const eligible = item => ['released', 'screened'].includes(item.releaseStatus) &&
      item.category === values.category && (values.category !== 'anime' || !comicIds.has(item.id) && !learnedComicFamilies.has(motionComicSeriesKey(item.title))) &&
      (!values.genre || item.genres.includes(values.genre));
    const inCountry = item => !values.country || item.countries.includes(values.country);
    const inYear = item => !values.year || item.year === values.year;
    const inLanguage = item => values.language === 'all' || item.languages?.includes(values.language);
    const items = entry.items.map(resolve).filter(item => eligible(item) && inYear(item) && inCountry(item) && inLanguage(item));
    const observed = [entry, ...[...pages.values()].filter(p => p !== entry && p.category === values.category && p.at + HOUR > now())]
      .flatMap(p => p.items).map(resolve).filter(eligible);
    const languages = [...new Set(observed.filter(item => inCountry(item) && inYear(item)).flatMap(item => item.languages ?? []))].sort();
    const years = [...new Set(observed.filter(item => inCountry(item) && inLanguage(item)).map(item => item.year).filter(year => validYear(year, now())))].sort().reverse();
    const countries = [...new Set(observed.filter(item => inYear(item) && inLanguage(item)).flatMap(item => item.countries))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return { ...values, items: clone(items), hasMore: entry.hasMore, facets: { genres: [...GENRES], years, countries, languages }, errors: [...errors], stale,
      attribution: '豆瓣公开目录', sortLabel: values.sort === 'score' ? '已上映片目，豆瓣高分优先' : values.sort === 'release-score' ? '热门已上映片目，年份优先、同年高分优先' : '热门已上映片目，上映年份优先' };
  }

  function fallback(entry, values, errors) {
    const response = result(entry || { items: [], hasMore: false }, values, errors, !!entry);
    if (!response.items.length) response.unavailable = true;
    return response;
  }

  return {
    poster(value) {
      if (stopped) return undefined;
      if (isNetflixId(value)) return netflix?.poster?.(value);
      const id = idOf(value);
      if (!id) return undefined;
      const item = subjects.get(id)?.item || [...pages.values()].flatMap(page => page.items).find(item => item.id === id);
      return item?.poster || undefined;
    },

    async browse(options = {}) {
      if (stopped) throw failure('夸克影院已停止', 503);
      const values = filters(options);
      if (values.platform) {
        const selected = netflix ? await netflix.browse(values) : { items: [], hasMore: false, unconfigured: true };
        return { ...values, ...selected };
      }
      if (values.category === 'motion-comic') {
        await refreshComicIndex();
        await discoverComics(values.year || String(new Date(now()).getUTCFullYear()));
      }
      const filterLanguage = values.language !== 'all';
      const key = JSON.stringify({ ...values, language: filterLanguage ? values.language : undefined }), cached = pages.get(key);
      const comicIndex = values.category === 'anime' ? refreshComicIndex() : undefined;
      if (cached && cached.at + (cached.languageIncomplete ? 15000 : cached.errors?.length ? 60000 : HOUR) > now()) {
        await comicIndex;
        return result(cached, values);
      }
      const extra = values.category === 'motion-comic' ? [...subjects.values()].filter(({ item, comicDiscovery }) => comicDiscovery && item.category === 'motion-comic'
        && (!values.year || item.year === values.year) && (!values.genre || item.genres.includes(values.genre))
        && (!values.country || !item.countries.length || item.countries.includes(values.country))
        && (!filterLanguage || !item.languages?.length || item.languages.includes(values.language)))
        .sort((a, b) => Number(a.item.id) - Number(b.item.id)) : [];
      const offset = (values.page - 1) * PAGE_SIZE;
      const extraPage = extra.slice(offset, offset + PAGE_SIZE);
      const moreExtra = extra.length > offset + PAGE_SIZE;
      const fallbackPage = cached || (extraPage.length ? { items: extraPage.map(entry => entry.item), hasMore: moreExtra } : undefined);
      const recentFailure = failures.get(key);
      if (recentFailure && recentFailure.until > now()) {
        await comicIndex;
        return fallback(fallbackPage, values, recentFailure.errors);
      }
      return load(`browse:${key}`, async signal => {
        const started = Date.now();
        const kind = values.category === 'movie' ? 'movie' : 'tv';
        const errors = [], rows = [], unconfirmed = new Map();
        const tags = values.category === 'motion-comic' ? ['漫剧'] : [...new Set([values.category === 'anime' ? '动画' : values.category === 'variety' ? '综艺' : kind === 'tv' ? '电视剧' : '', values.genre, values.year, values.country, values.language === 'zh' ? '华语' : ''].filter(Boolean))];
        const query = new URLSearchParams({ refresh: '0', start: String((values.page - 1) * PAGE_SIZE), count: String(PAGE_SIZE), uncollect: 'false', tags: tags.join(','), sort: values.sort === 'score' ? 'S' : 'U' });
        let data;
        try {
          data = await fetchJson(`${kind}/recommend?${query}`, signal);
          await comicIndex;
          if (!Array.isArray(data.items) || data.items.length > 100) throw failure('豆瓣目录格式暂不可读取，请稍后再试');
        } catch (error) {
          signal.throwIfAborted();
          errors.push(error.status ? error.message : '豆瓣目录暂不可读取，请稍后再试');
          failures.set(key, { until: now() + 60000, errors });
          while (failures.size > 32) failures.delete(failures.keys().next().value);
          return fallback(fallbackPage, values, errors);
        }
        const total = Number(data.total ?? NaN);
        const hasMore = moreExtra || (Number.isFinite(total) && total >= 0 ? values.page * PAGE_SIZE < total : data.items.length >= PAGE_SIZE);
        const considered = new Set();
        function consider(item, known, hasShowFlag) {
          if (!item || considered.has(item.id) || item.releaseStatus === 'upcoming') return;
          considered.add(item.id);
          if (item.category === 'motion-comic' && values.category !== 'motion-comic') {
            if (known?.item.category !== 'motion-comic') {
              register(item, false, !comicIds.has(item.id));
              for (const [pageKey, page] of pages) if (page.category === 'motion-comic') pages.delete(pageKey);
            }
            return;
          }
          if (values.year && item.year !== values.year || values.genre && !item.genres.includes(values.genre)) return;
          const fresh = known && known.at + 6 * HOUR > now();
          const category = fresh && known.detailed && item.category !== 'motion-comic' ? known.item.category : item.category;
          const needsCategory = values.category === 'variety' && category === 'tv' && !hasShowFlag && !(fresh && known.detailed);
          if (category !== values.category && !needsCategory) return;
          if (item.releaseStatus === 'unknown' && known?.item.releaseStatus === 'upcoming' && known.at + 6 * HOUR > now()) return;
          const releaseUnknown = item.releaseStatus === 'unknown' && (!known || !['released', 'screened'].includes(known.item.releaseStatus));
          if (fresh) {
            if (!item.countries.length) item.countries = known.item.countries;
            item.languages ??= known.item.languages;
            if (item.releaseStatus === 'unknown') item.releaseStatus = known.item.releaseStatus;
          }
          const needsCountry = values.country && !item.countries.length && !(fresh && known.detailed);
          const needsLanguage = filterLanguage && (!item.languages?.length && !(fresh && known.detailed && item.languages));
          if (releaseUnknown || needsCountry || needsLanguage || needsCategory) unconfirmed.set(item.id, { item, releaseUnknown, needsCountry, needsLanguage, needsCategory });
          else { const registered = register(item, false); if (['released', 'screened'].includes(registered.releaseStatus)) rows.push(registered); }
        }
        const entries = [];
        for (const raw of data.items) {
          if (raw?.type !== kind) continue;
          const id = idOf(raw.id), known = subjects.get(id);
          const item = metadata(raw, false, now(), comicIds.has(id) || known?.item.category === 'motion-comic');
          if (!item || item.releaseStatus === 'upcoming') continue;
          if (item.category === 'anime' && (values.category === 'motion-comic' || learnedComicFamilies.has(motionComicSeriesKey(item.title)))) markComic(item);
          entries.push({ item, hasShowFlag: typeof raw.is_show === 'boolean' });
        }
        const pendingComic = new Set();
        if (values.category === 'anime') {
          const recentYear = new Date(now()).getUTCFullYear() - 2;
          const checks = [];
          for (const { item } of entries) {
            if (item.category !== 'anime' || values.year && item.year !== values.year || values.genre && !item.genres.includes(values.genre)) continue;
            const recentDomestic = Number(item.year) >= recentYear && item.countries.includes('中国大陆');
            const uncertain = shortComicFamilies.has(motionComicSeriesKey(item.title)) || recentDomestic && !item.douban.votes;
            if (!uncertain && !recentDomestic && !item.genres.includes('短片')) continue;
            if (uncertain) pendingComic.add(item.id);
            checks.push({ item, uncertain });
          }
          const probeBudget = Math.min(2500, 7000 - (Date.now() - started));
          if (checks.length && probeBudget >= 250) {
            const probe = AbortSignal.any([signal, AbortSignal.timeout(probeBudget)]);
            checks.sort((a, b) => Number(b.uncertain) - Number(a.uncertain));
            await Promise.all([0, 1].map(async offset => {
              for (let i = offset; i < checks.length && !probe.aborted; i += 2) {
                const { item } = checks[i], comic = await resolveComicTags(item, probe);
                if (comic === true) markComic(item);
                if (comic !== undefined) pendingComic.delete(item.id);
              }
            }));
          }
          signal.throwIfAborted();
          for (const { item } of entries) if (item.category === 'motion-comic') learnComicFamily(item);
          const discovered = [];
          for (const { item } of entries) {
            if (item.category === 'anime' && learnedComicFamilies.has(motionComicSeriesKey(item.title))) markComic(item);
            if (item.category === 'motion-comic') {
              pendingComic.delete(item.id);
              if (!comicIds.has(item.id)) discovered.push(item);
            }
          }
          saveComicDiscoveries(discovered);
          if (pendingComic.size) errors.push(COMIC_WARNING);
        }
        for (const { item, hasShowFlag } of entries) {
          if (!pendingComic.has(item.id)) consider(item, subjects.get(item.id), hasShowFlag);
        }
        for (const entry of extraPage) consider({ ...entry.item }, entry, false);
        signal.throwIfAborted();
        const verifyPage = filterLanguage || values.category === 'variety' || values.category === 'motion-comic';
        const budget = Math.min(verifyPage ? 6000 : 2000, 7000 - (Date.now() - started));
        const queued = [...unconfirmed.values()];
        const candidates = verifyPage ? queued : queued.slice(0, 4);
        let unverified = queued.filter(row => row.releaseUnknown).length;
        let pendingCountries = queued.filter(row => row.needsCountry).length;
        let pendingLanguages = queued.filter(row => row.needsLanguage).length;
        let pendingCategories = queued.filter(row => row.needsCategory).length;
        const verifiedComics = [];
        if (candidates.length && budget >= 250) {
          const verification = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
          async function verify({ item, releaseUnknown, needsCountry, needsLanguage, needsCategory }) {
            try {
              const raw = await fetchJson(`${kind}/${item.id}`, verification);
              signal.throwIfAborted();
              if (idOf(raw.id) !== item.id || raw.type !== kind) return;
              const checked = metadata(raw, true, now(), item.category === 'motion-comic');
              if (!checked) return;
              if (!checked.countries.length) checked.countries = item.countries;
              checked.languages ??= item.languages ?? [];
              if (checked.releaseStatus === 'unknown' && !releaseUnknown) checked.releaseStatus = item.releaseStatus;
              if (releaseUnknown && checked.releaseStatus !== 'unknown') unverified--;
              if (needsCountry && checked.countries.length) pendingCountries--;
              if (needsLanguage) pendingLanguages--;
              if (needsCategory) pendingCategories--;
              if (values.category !== 'motion-comic' && checked.category === 'motion-comic' && checked.releaseStatus !== 'upcoming') verifiedComics.push(checked);
              const matches = ['released', 'screened'].includes(checked.releaseStatus) && checked.category === values.category && (!values.year || checked.year === values.year) && (!values.genre || checked.genres.includes(values.genre));
              if (matches || needsCategory || checked.releaseStatus === 'upcoming') register(checked, true);
              if (matches) rows.push(checked);
            } catch { /* 汇总到下方可重试提示，不让单条核验失败阻塞已确认的片目。 */ }
          }
          await Promise.all([0, 1].map(async offset => {
            for (let i = offset; i < candidates.length && !verification.aborted; i += 2) await verify(candidates[i]);
          }));
        }
        signal.throwIfAborted();
        if (verifiedComics.length) {
          for (const item of verifiedComics) learnComicFamily(item);
          saveComicDiscoveries(verifiedComics, true);
        }
        if (unverified) errors.push('部分未评分片目暂未核实上映状态，已隐藏；可稍后重试或继续翻页');
        if (pendingCountries) errors.push('部分片目暂未核实制作国家或地区，可继续翻页');
        if (pendingCategories) errors.push('部分片目暂未核实是否为综艺，可稍后重试或继续翻页');
        if (pendingLanguages) errors.push(LANGUAGE_WARNING);
        const items = [...new Map(rows.map(item => [item.id, item])).values()];
        // 热门候选按真实上映年份排序，不拿上线日期或未上映排期冒充首映时间。
        if (values.sort === 'score') items.sort((a, b) => (b.douban.score ?? -1) - (a.douban.score ?? -1));
        else items.sort((a, b) => b.year.localeCompare(a.year) || Number(b.douban.score !== null) - Number(a.douban.score !== null) || Number(/\p{Script=Han}/u.test(b.title)) - Number(/\p{Script=Han}/u.test(a.title)) || (values.sort === 'release-score' ? (b.douban.score ?? -1) - (a.douban.score ?? -1) : 0));
        const entry = { at: now(), category: values.category, items, hasMore, errors, languageIncomplete: pendingLanguages > 0 };
        pages.delete(key);
        pages.set(key, entry);
        persist();
        return result(entry, values, [...new Set(errors)]);
      }).catch(error => {
        if (stopped) throw error;
        return fallback(fallbackPage, values, [error.status ? error.message : '豆瓣目录暂不可读取，请稍后再试']);
      });
    },

    async detail(value) {
      if (stopped) throw failure('夸克影院已停止', 503);
      if (isNetflixId(value)) {
        if (!netflix) throw failure('奈飞片库未配置', 503);
        return netflix.detail(value);
      }
      const id = idOf(value);
      if (!id) throw failure('豆瓣条目标识无效', 400);
      const cached = subjects.get(id);
      if (cached?.item.type === 'series' && (comicIds.has(id) || cached.item.category === 'anime' && learnedComicFamilies.has(motionComicSeriesKey(cached.item.title)))) markComic(cached.item);
      if (cached?.detailed && cached.at + 6 * HOUR > now()) return clone({ ...cached.item, errors: [], stale: false });
      return load(`detail:${id}`, async signal => {
        const kinds = cached ? [cached.item.type === 'movie' ? 'movie' : 'tv'] : ['movie', 'tv'];
        let last;
        for (const kind of kinds) {
          try {
            const raw = await fetchJson(`${kind}/${id}`, signal);
            if (idOf(raw.id) !== id || raw.type !== kind) throw failure('豆瓣条目信息不匹配，暂不可读取');
            const item = metadata(raw, true, now(), cached?.item.category === 'motion-comic' || comicIds.has(id));
            if (!item) throw Object.assign(failure('此豆瓣条目不在夸克影院展示范围', 404), { excluded: true });
            if (item.category === 'anime' && learnedComicFamilies.has(motionComicSeriesKey(item.title))) markComic(item);
            item.languages ??= [];
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
      await Promise.allSettled([...flights.values(), netflix?.stop?.()]);
    },
  };
}

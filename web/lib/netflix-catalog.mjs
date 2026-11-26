import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogLanguage, normalizeCountries } from './catalog-filters.mjs';
import { request as networkRequest, readText } from './network.mjs';

const API = 'https://api.themoviedb.org/3/';
const ATTRIBUTION = 'TMDB · JustWatch';
const PAGE_SIZE = 30, TMDB_PAGE_LIMIT = 500;
const DAY = 24 * 60 * 60000, RETRY_AFTER = 10 * 60000, CHECKPOINT_AGE = 3 * DAY;
const SNAPSHOT_LIMIT = 64 * 1024 * 1024;
const ID = /^tmdb:(movie|tv):([1-9]\d{0,9})$/;
const REGION = /^[A-Z]{2}$/;
const POSTER = /^\/[\w-]+\.(?:jpg|jpeg|png|webp)$/i;
const GENRE = {
  12: '冒险', 14: '奇幻', 16: '动画', 18: '剧情', 27: '恐怖', 28: '动作',
  35: '喜剧', 36: '历史', 37: '西部', 53: '惊悚', 80: '犯罪', 99: '纪录片',
  878: '科幻', 9648: '悬疑', 10402: '音乐', 10749: '爱情', 10751: '家庭',
  10752: '战争', 10759: '动作', 10762: '儿童', 10763: '新闻', 10764: '真人秀',
  10765: '科幻', 10766: '肥皂剧', 10767: '脱口秀', 10768: '战争',
};
export const NETFLIX_GENRES = new Set(Object.values(GENRE));
const VARIETY = new Set([10763, 10764, 10767]);
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const text = (value, max = 300) => typeof value === 'string' ? value.replace(/<[^>]*>|[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const numberId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const regionCodes = values => Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && REGION.test(value) && value !== 'ZZ'))].sort() : [];

export function isNetflixId(value) {
  const parts = typeof value === 'string' && ID.exec(value);
  return !!parts && numberId(Number(parts[2]));
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
}

function summarize(raw, kind) {
  if (!numberId(raw?.id) || raw.adult === true) return null;
  const originalTitle = text(raw.original_title || raw.original_name);
  const title = text(raw.title || raw.name) || originalTitle;
  if (!title) return null;
  const genreIds = [...new Set((Array.isArray(raw.genre_ids) ? raw.genre_ids : Array.isArray(raw.genres) ? raw.genres.map(genre => genre?.id) : []).filter(id => Number.isInteger(id) && Object.hasOwn(GENRE, id)))];
  const releaseDate = date(raw.release_date || raw.first_air_date);
  const votes = Number.isSafeInteger(raw.vote_count) && raw.vote_count > 0 ? raw.vote_count : 0;
  const score = votes && Number.isFinite(raw.vote_average) && raw.vote_average > 0 && raw.vote_average <= 10 ? raw.vote_average : null;
  const posterPath = typeof raw.poster_path === 'string' && POSTER.test(raw.poster_path) ? raw.poster_path : '';
  const countryCodes = regionCodes([...(Array.isArray(raw.origin_country) ? raw.origin_country : []), ...(Array.isArray(raw.production_countries) ? raw.production_countries.map(country => country?.iso_3166_1) : [])]);
  return { kind, id: raw.id, title, original_title: originalTitle, original_language: catalogLanguage(raw.original_language),
    genre_ids: genreIds, release_date: releaseDate, vote_count: votes, vote_average: score, poster_path: posterPath, origin_country: countryCodes };
}

function itemOf(summary, regions) {
  const { kind, id: externalId, title, original_title: originalTitle, genre_ids: genreIds, release_date: releaseDate } = summary;
  const id = `tmdb:${kind}:${externalId}`, type = kind === 'movie' ? 'movie' : 'series';
  const category = kind === 'movie' ? 'movie' : genreIds.includes(16) ? 'anime'
    : genreIds.some(genre => VARIETY.has(genre)) ? 'variety' : 'tv';
  const typeName = { movie: '电影', tv: '电视剧', anime: '动漫', variety: '综艺' }[category];
  return { source: 'quark-library', id, key: `quark-library:${id}`, title, originalTitle, aliases: originalTitle && originalTitle !== title ? [originalTitle] : [],
    type, typeName, category, language: summary.original_language, year: releaseDate.slice(0, 4), releaseDate, releaseStatus: 'released', countries: normalizeCountries(summary.origin_country),
    genres: [...new Set(genreIds.map(genre => GENRE[genre]))], netflix: true, availabilityRegions: regions,
    poster: summary.poster_path ? `https://image.tmdb.org/t/p/w342${summary.poster_path}` : '',
    tmdb: { id: externalId, score: summary.vote_average, votes: summary.vote_count, url: `https://www.themoviedb.org/${kind}/${externalId}`, attribution: 'TMDB' },
  };
}

function viewOf(data) {
  return { at: data.at, coverageRegions: data.coverageRegions, items: new Map(data.rows.map(row => {
    const item = itemOf(row, row.regions);
    return [item.id, item];
  })) };
}

function restore(path, now, pending = false) {
  if (!path) return;
  try {
    if (statSync(path).size > SNAPSHOT_LIMIT) throw new Error('oversized Netflix catalog');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const coverageRegions = regionCodes(saved.coverageRegions);
    if (saved.version !== 1 || !Number.isSafeInteger(saved.at) || saved.at > now || !coverageRegions.length || !Array.isArray(saved.rows)) throw new Error('invalid Netflix catalog');
    const countries = new Set(coverageRegions), rows = [];
    const targetRegions = regionCodes(saved.targetRegions);
    if (pending && (!Number.isSafeInteger(saved.startedAt) || saved.startedAt > saved.at || now - saved.startedAt > CHECKPOINT_AGE
      || !coverageRegions.every(region => targetRegions.includes(region)) || !/^\d+(?:\|\d+)*:\d+(?:\|\d+)*$/.test(saved.providers || ''))) return;
    for (const row of saved.rows) {
      const summary = ['movie', 'tv'].includes(row?.kind) && summarize(row, row.kind);
      const regions = regionCodes(row?.regions).filter(region => countries.has(region));
      if (!summary || !regions.length) throw new Error('invalid Netflix catalog row');
      rows.push({ ...summary, regions });
    }
    const data = { at: saved.at, coverageRegions, rows };
    return pending ? { ...data, startedAt: saved.startedAt, targetRegions, providers: saved.providers, view: viewOf(data) }
      : { ...viewOf(data), legacyLanguage: saved.rows.length > 0 && saved.rows.every(row => !Object.hasOwn(row, 'original_language')) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('奈飞片库缓存无法读取，将重新同步。');
  }
}

async function save(path, data, signal) {
  signal.throwIfAborted();
  if (!path) return;
  const file = `${path}.${randomUUID()}.tmp`;
  try {
    const encoded = JSON.stringify({ version: 1, ...data });
    if (Buffer.byteLength(encoded) > SNAPSHOT_LIMIT) throw failure('奈飞片库超出当前缓存容量。');
    await writeFile(file, encoded, { flag: 'wx', mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(file, path);
  } finally { await rm(file, { force: true }); }
}

function episodesOf(kind, raw) {
  if (kind === 'movie') return [{ name: '正片' }];
  const seasons = new Map();
  for (const season of Array.isArray(raw.seasons) ? raw.seasons : []) {
    const number = season?.season_number, count = season?.episode_count;
    if (Number.isInteger(number) && number > 0 && number <= 99 && Number.isInteger(count) && count > 0 && count <= 999) {
      seasons.set(number, { count, year: date(season.air_date).slice(0, 4) });
    }
  }
  return [...seasons].sort((a, b) => a[0] - b[0]).flatMap(([season, { count, year }]) =>
    Array.from({ length: count }, (_, index) => ({ name: `第${season}季 第${index + 1}集`, season, ...(year ? { seasonYear: year } : {}) })));
}

export function createNetflixCatalog({ token, request = networkRequest, now = Date.now, dataDir } = {}) {
  const accessToken = typeof token === 'string' && /^[A-Za-z0-9._~-]{1,4096}$/.test(token.trim()) ? token.trim() : '';
  const snapshotPath = dataDir && join(dataDir, 'netflix-tmdb-v1.json');
  const checkpointPath = dataDir && join(dataDir, 'netflix-tmdb-v1.pending.json');
  const shutdown = new AbortController(), details = new Map(), detailJobs = new Map();
  let snapshot = accessToken ? restore(snapshotPath, now()) : undefined;
  let checkpoint = accessToken ? restore(checkpointPath, now(), true) : undefined;
  if (snapshot && checkpoint?.at <= snapshot.at) checkpoint = undefined;
  let job, nextAttempt = 0, warning = '', throttledUntil = 0, progress;
  const visible = () => snapshot || checkpoint?.view;

  async function fetchJson(path, params, signal = shutdown.signal) {
    const url = new URL(path, API);
    url.search = new URLSearchParams(params).toString();
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const wait = throttledUntil - Date.now();
      if (wait > 60000) throw failure('TMDB 请求受限，稍后重试同步。', 429);
      if (wait > 0) await delay(wait, undefined, { signal });
      let response, abort;
      try {
        response = await request(url.href, { timeout: 8000, signal, followRedirects: false, headers: {
          accept: 'application/json', 'accept-encoding': 'gzip, br', authorization: `Bearer ${accessToken}` } });
        response.on('error', () => {});
        if (response.finalUrl && response.finalUrl !== url.href) throw failure('TMDB 请求地址异常。');
        if (response.statusCode === 401 || response.statusCode === 403) {
          throw Object.assign(failure('TMDB API Read Access Token 无效或没有访问权限。', 503), { credential: true });
        }
        if (response.statusCode === 404) throw failure('TMDB 找不到这部影片。', 404);
        if (response.statusCode === 429) {
          const raw = response.headers?.['retry-after'];
          const seconds = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - Date.now() : 0;
          throttledUntil = Math.max(throttledUntil, Date.now() + Math.max(Number.isFinite(seconds) ? seconds : 0, 1000 * (attempt + 1)));
          if (throttledUntil > Date.now() + 60000 || attempt === 3) throw failure('TMDB 请求受限，稍后重试同步。', 429);
          continue;
        }
        if (response.statusCode !== 200) {
          const status = response.statusCode;
          throw Object.assign(failure(Number.isInteger(status) && status >= 100 && status <= 599 ? `TMDB 返回 HTTP ${status}。` : 'TMDB 响应状态异常。', status >= 500 ? 502 : 503), { responseStatus: true });
        }
        abort = () => response.destroy(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        signal.throwIfAborted();
        const result = JSON.parse(await readText(response, 1024 * 1024));
        signal.throwIfAborted();
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('TMDB 片单格式异常。');
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if ([404, 429, 503].includes(error.status)) throw error;
        if (attempt === 3) {
          if (error.responseStatus) throw error;
          throw failure(error.code === 'MEDIA_SOURCE_TIMEOUT' ? 'TMDB 连接或读取超时。' : 'TMDB 连接或响应失败，请稍后重试。');
        }
      } finally {
        if (abort) signal.removeEventListener('abort', abort);
        response?.destroy();
      }
      await delay(300 * (attempt + 1), undefined, { signal });
    }
  }

  async function sync(signal) {
    const activeProgress = { completed: checkpoint?.coverageRegions.length || 0, total: checkpoint?.targetRegions.length || 0 };
    progress = activeProgress;
    const { results: rawRegions } = await fetchJson('watch/providers/regions', {}, signal);
    const coverageRegions = regionCodes(Array.isArray(rawRegions) ? rawRegions.map(region => region?.iso_3166_1) : []);
    if (!coverageRegions.length) throw failure('TMDB 地区清单暂时无法读取。');
    const byKind = new Map();
    for (const kind of ['movie', 'tv']) {
      const { results } = await fetchJson(`watch/providers/${kind}`, {}, signal);
      const providers = [...new Set((Array.isArray(results) ? results : [])
        .filter(row => /^Netflix(?: (?:Standard |Basic )?with Ads| Kids| Free)?$/i.test(row?.provider_name) && numberId(row.provider_id))
        .map(row => row.provider_id))];
      if (!providers.length) throw failure('TMDB 片库中找不到 Netflix 平台。');
      byKind.set(kind, providers.join('|'));
    }
    const providers = [...byKind.values()].map(ids => ids.split('|').sort().join('|')).join(':');
    if (checkpoint && (checkpoint.providers !== providers || checkpoint.targetRegions.join(',') !== coverageRegions.join(',')
      || now() - checkpoint.startedAt > CHECKPOINT_AGE)) checkpoint = undefined;
    const startedAt = checkpoint?.startedAt ?? now();
    const completed = new Set(checkpoint?.coverageRegions);
    const remaining = coverageRegions.filter(region => !completed.has(region));
    activeProgress.completed = completed.size;
    activeProgress.total = coverageRegions.length;
    const rows = new Map(checkpoint?.rows.map(row => [`${row.kind}:${row.id}`, { ...row, regions: new Set(row.regions) }]));
    async function scan(kind, region, regional, bounds = {}) {
      const query = { language: 'zh-CN', include_adult: 'false', watch_region: region,
        with_watch_providers: byKind.get(kind), with_watch_monetization_types: 'flatrate|free|ads',
        sort_by: kind === 'movie' ? 'title.asc' : 'name.asc', ...(kind === 'tv' ? { include_null_first_air_dates: 'true' } : {}), ...bounds };
      async function page(number) {
        try {
          const result = await fetchJson(`discover/${kind}`, { ...query, page: number }, signal);
          if (result.page !== number || !Array.isArray(result.results) || result.results.length > 20
            || !Number.isSafeInteger(result.total_results) || result.total_results < 0 || !Number.isSafeInteger(result.total_pages) || result.total_pages < 0
            || result.total_results > 0 && (result.total_pages < number || !result.results.length || result.total_pages * 20 < Math.min(result.total_results, TMDB_PAGE_LIMIT * 20))
            || result.total_results === 0 && (number !== 1 || result.total_pages > 1 || result.results.length > 0)) {
            throw failure('TMDB 返回的地区片单页格式异常。');
          }
          return result;
        } catch (error) {
          signal.throwIfAborted();
          throw Object.assign(error, { page: number });
        }
      }
      const first = await page(1);
      if (first.total_pages > TMDB_PAGE_LIMIT || first.total_results > TMDB_PAGE_LIMIT * 20) {
        // 评分次数的无交集分区保留上映日期缺失的条目。
        const min = bounds['vote_count.gte'] ?? 0, max = bounds['vote_count.lte'] ?? 2147483647;
        if (min >= max) throw failure('TMDB 地区片单超过接口分页上限。');
        const split = Math.floor((min + max) / 2);
        const left = await scan(kind, region, regional, { 'vote_count.gte': min, 'vote_count.lte': split });
        const right = await scan(kind, region, regional, { 'vote_count.gte': split + 1, 'vote_count.lte': max });
        if (left + right !== first.total_results) throw failure('TMDB 地区片单在同步中发生变化，请稍后重试。', 409);
        return first.total_results;
      }
      function collect(result) {
        for (const raw of result.results) {
          if (!numberId(raw?.id) || regional.has(raw.id)) throw failure('TMDB 地区片单在同步中发生变化，请稍后重试。', 409);
          const row = summarize(raw, kind);
          regional.set(raw.id, row);
        }
      }
      const previous = regional.size;
      collect(first);
      for (let number = 2; number <= first.total_pages; number++) collect(await page(number));
      if (regional.size - previous !== first.total_results) throw failure('TMDB 地区片单在同步中发生变化，请稍后重试。', 409);
      return first.total_results;
    }
    function records() { return [...rows.values()].map(row => ({ ...row, regions: [...row.regions].sort() })); }
    const regionErrors = [];
    let regionIndex = 0, fatal, writing = Promise.resolve();
    await Promise.all([0, 1].map(async () => {
      while (!fatal && regionIndex < remaining.length) {
        signal.throwIfAborted();
        const region = remaining[regionIndex++], next = [];
        let kind;
        try {
          for (kind of byKind.keys()) {
            const regional = new Map();
            try { await scan(kind, region, regional); }
            catch (error) {
              if (error.status !== 409) throw error;
              regional.clear();
              await scan(kind, region, regional);
            }
            for (const row of regional.values()) if (row) next.push(row);
          }
        } catch (error) {
          signal.throwIfAborted();
          const part = `${region} ${kind === 'movie' ? '电影' : '剧集'}${error.page ? `第 ${error.page} 页` : ''}`;
          regionErrors.push(`${part} · ${error.status ? error.message : '暂时无法读取。'}`);
          if (error.status === 429 || error.credential) fatal = error;
          continue;
        }
        // 两个下载任务共享一个写入队列，每个地区完整写入后才公开进度。
        writing = writing.then(async () => {
          for (const row of next) {
            const key = `${row.kind}:${row.id}`;
            const old = rows.get(key);
            if (old) {
              old.regions.add(region);
              old.original_language ||= row.original_language;
            } else rows.set(key, { ...row, regions: new Set([region]) });
          }
          completed.add(region);
          const stage = { at: now(), startedAt, providers, targetRegions: coverageRegions, coverageRegions: [...completed].sort(), rows: records() };
          await save(checkpointPath, stage, signal);
          checkpoint = { ...stage, view: snapshot ? undefined : viewOf(stage) };
          activeProgress.completed = completed.size;
        });
        await writing;
      }
    }));
    signal.throwIfAborted();
    if (completed.size !== coverageRegions.length) {
      const diagnostics = regionErrors.slice(0, 3).join('；');
      throw failure(`奈飞片库已同步 ${completed.size}/${coverageRegions.length} 个地区，剩余地区将重试。${diagnostics ? ` ${diagnostics}` : ''}`, fatal?.status);
    }
    const complete = { at: now(), coverageRegions, rows: records() };
    await save(snapshotPath, complete, signal);
    snapshot = viewOf(complete);
    checkpoint = undefined;
    warning = '';
    if (checkpointPath) await rm(checkpointPath, { force: true }).catch(() => console.warn('奈飞片库旧同步缓存暂时无法清理。'));
  }

  function startSync() {
    const controller = new AbortController(), signal = AbortSignal.any([shutdown.signal, controller.signal]);
    job = sync(signal).catch(error => {
      controller.abort(error);
      if (!shutdown.signal.aborted) {
        warning = error.status ? error.message : '奈飞片库暂时无法缓存或同步，请稍后重试。';
        nextAttempt = now() + Math.max(RETRY_AFTER, throttledUntil - Date.now());
      }
    }).finally(() => { job = undefined; progress = undefined; });
  }

  return {
    browse(values) {
      shutdown.signal.throwIfAborted();
      const at = snapshot?.at;
      const expired = at === undefined || now() - at >= DAY;
      if (!job && checkpoint && now() - checkpoint.startedAt > CHECKPOINT_AGE) checkpoint = undefined;
      if (accessToken && (expired || snapshot?.legacyLanguage) && !job && now() >= nextAttempt) startSync();
      const current = visible(), provisional = !snapshot && !!current;
      const syncProgress = progress || (checkpoint && { completed: checkpoint.coverageRegions.length, total: checkpoint.targetRegions.length });
      const matching = [], language = catalogLanguage(values.language);
      const genres = new Set(), years = new Set(), countries = new Set(), languages = new Set();
      for (const item of current?.items.values() || []) {
        if (item.category !== values.category) continue;
        for (const genre of item.genres) genres.add(genre);
        if (values.genre && !item.genres.includes(values.genre)) continue;
        const inYear = !values.year || item.year === values.year, inCountry = !values.country || item.countries.includes(values.country);
        if (inCountry && inYear && item.language) languages.add(item.language);
        if (language && item.language !== language) continue;
        if (inCountry && item.year) years.add(item.year);
        if (inYear) for (const country of item.countries) countries.add(country);
        if (inCountry && inYear) matching.push(item);
      }
      const score = (a, b) => (b.tmdb.score ?? -1) - (a.tmdb.score ?? -1);
      matching.sort((a, b) => (values.sort === 'score' ? score(a, b)
        : b.year.localeCompare(a.year) || (values.sort === 'release-score' ? score(a, b) : 0) || b.releaseDate.localeCompare(a.releaseDate))
        || a.id.localeCompare(b.id));
      const start = (values.page - 1) * PAGE_SIZE;
      const sortLabel = values.sort === 'score' ? 'TMDB 评分优先' : values.sort === 'release-score' ? '上映年份优先、同年 TMDB 评分优先' : '上映日期优先';
      return { ...values, items: structuredClone(matching.slice(start, start + PAGE_SIZE)), total: matching.length, hasMore: start + PAGE_SIZE < matching.length,
        facets: { genres: [...genres].sort((a, b) => a.localeCompare(b, 'zh-CN')), years: [...years].sort().reverse(),
          countries: [...countries].sort((a, b) => a.localeCompare(b, 'zh-CN')), languages: [...languages].sort() },
        errors: accessToken ? warning ? [warning] : [] : ['请先在 NAS 配置 TMDB API Read Access Token。'], unconfigured: !accessToken,
        unavailable: !!accessToken && !current && !job, syncing: !!job, ...(syncProgress ? { syncProgress: { ...syncProgress } } : {}),
        stale: !!snapshot && expired, provisional, coverageRegions: [...(current?.coverageRegions || [])], updatedAt: current?.at, attribution: ATTRIBUTION, sortLabel,
      };
    },
    poster(id) {
      return details.get(id)?.item.poster || visible()?.items.get(id)?.poster || undefined;
    },
    async detail(id) {
      shutdown.signal.throwIfAborted();
      if (!isNetflixId(id)) throw failure('TMDB 影片标识无效。', 400);
      if (!accessToken) throw failure('请先在 NAS 配置 TMDB API Read Access Token。', 503);
      const cached = details.get(id);
      if (cached && now() - cached.at < DAY) return structuredClone(cached.item);
      if (detailJobs.has(id)) return structuredClone(await detailJobs.get(id));
      if (detailJobs.size >= 8) throw failure('TMDB 影片详情正在排队，请稍后重试。', 503);
      const [, kind, externalId] = ID.exec(id);
      const pending = (async () => {
        const raw = await fetchJson(`${kind}/${externalId}`, { language: 'zh-CN' });
        const summary = raw.id === Number(externalId) && summarize(raw, kind);
        if (!summary) throw failure('此 TMDB 条目不在夸克影院展示范围。', 404);
        const listed = visible()?.items.get(id);
        const item = itemOf(summary, listed?.availabilityRegions || []);
        item.language ||= listed?.language || '';
        const episodes = episodesOf(kind, raw);
        const overview = text(raw.overview, 1600), chinese = /\p{Script=Han}/u.test(overview);
        Object.assign(item, { netflix: !!listed, description: chinese ? overview : '暂无中文剧情简介。', descriptionLanguage: chinese ? 'zh' : 'unavailable',
          ...(!chinese && overview ? { originalDescription: overview } : {}), episodeCount: episodes.length,
          lines: [{ name: '夸克网盘', episodes }], errors: [], stale: false });
        details.delete(id);
        details.set(id, { at: now(), item });
        if (details.size > 256) details.delete(details.keys().next().value);
        return item;
      })().finally(() => detailJobs.delete(id));
      detailJobs.set(id, pending);
      try { return structuredClone(await pending); }
      catch (error) {
        if (!cached || shutdown.signal.aborted || error.status === 404) throw error;
        return structuredClone({ ...cached.item, errors: [error.message], stale: true });
      }
    },
    async stop() {
      shutdown.abort(failure('奈飞片库已停止。', 503));
      await Promise.allSettled([job, ...detailJobs.values()]);
    },
  };
}

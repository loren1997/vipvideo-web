const $ = (selector, root = document) => root.querySelector(selector);
const content = $('#content');
let config = { platforms: [], parsers: [], sources: [], subscriptions: [], liveSources: [], showAdult: false };
let library = { favorites: [], history: [] };
let lastSearch = { q: '', groups: [] };
let browseGroups = [];
let openingItem = null;
let detail = null;
let detailTarget = null;
let player = null;
let hls = null;
let hlsScriptPromise;
let routeVersion = 0;
let playVersion = 0;
let toastTimer;
let historyQueue = Promise.resolve();
let quarkProgressQueue = Promise.resolve();
let importWarnings = [];
const openSettingsSections = new Set();
const defaultPreferences = { introSeconds: 0, outroSeconds: 0, autoNext: true, speed: 1, danmakuEnabled: true, skipAds: false, adRanges: [] };
const sourceSuccess = new Map();
const playabilityCache = new Map();
let verificationActive = 0;
const verificationQueue = [];
const resourceSnapshots = new Map();
const resourceRequests = new Map();
let liveSnapshot;
let resourceVersion = 0;

function resourceKey(path) { return `${resourceVersion}:${path}`; }

function resourceSnapshot(path) {
  const saved = resourceSnapshots.get(resourceKey(path));
  return saved && Date.now() - saved.at < 30000 ? saved.data : null;
}

function resourceRequest(path, force = false) {
  const key = resourceKey(path), saved = resourceSnapshot(path);
  if (!force && saved && saved.complete !== false) return Promise.resolve(saved);
  if (resourceRequests.has(key)) return resourceRequests.get(key);
  const request = api(path).then(data => {
    resourceSnapshots.set(key, { at: Date.now(), data });
    if (resourceSnapshots.size > 24) resourceSnapshots.delete(resourceSnapshots.keys().next().value);
    return data;
  }).finally(() => resourceRequests.delete(key));
  resourceRequests.set(key, request); return request;
}

async function progressiveResults(path, valid, draw, force = false) {
  let data;
  do {
    try { data = await resourceRequest(path, force); }
    catch (error) {
      if (error.status === 409 && valid()) {
        const latest = await api('/api/config');
        if (valid() && !applyConfig(latest)) void renderRoute();
        return null;
      }
      throw error;
    }
    if (!valid()) return null;
    draw(data); content.setAttribute('aria-busy', 'false');
    if (data.complete !== false) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
    force = true;
  } while (valid());
  return data;
}

function pendingSources(data) {
  const pending = data.pendingSources || [];
  return data.complete === false ? `已显示先返回的影片，${pending.length ? `${pending.length} 个影视源` : '其他影视源'}仍在加载…` : '';
}

function ensureHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsScriptPromise) return hlsScriptPromise;
  hlsScriptPromise = new Promise((resolve, reject) => {
    const script = node('script'); script.src = '/vendor/hls.min.js'; script.async = true;
    const timer = setTimeout(() => { script.remove(); hlsScriptPromise = null; reject(new Error('播放器组件加载超时，请刷新后重试。')); }, 15000);
    script.onload = () => { clearTimeout(timer); if (window.Hls) resolve(window.Hls); else { script.remove(); hlsScriptPromise = null; reject(new Error('播放器组件未能初始化，请刷新后重试。')); } };
    script.onerror = () => { clearTimeout(timer); script.remove(); hlsScriptPromise = null; reject(new Error('播放器组件加载失败，请刷新后重试。')); };
    document.head.append(script);
  });
  return hlsScriptPromise;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, action, className = 'button') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function mediaUrl(value) {
  try { return typeof value === 'string' ? httpUrl(new URL(value, location.origin).href) : null; }
  catch { return null; }
}

function notify(message, error = false) {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${error ? ' error' : ''}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function api(path, options = {}) {
  const sourcesAtRequest = /^\/api\/(?:search|browse)\?/.test(path) ? JSON.stringify(config.sources) : null;
  const response = await fetch(path, {
    method: options.method || 'GET', credentials: 'same-origin', signal: AbortSignal.timeout(options.timeoutMs || 45000),
    headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && data.quarkAuth !== true && !path.includes('/auth/login')) showLogin();
    const error = new Error(data.error || data.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.adultHidden = response.status === 403 && error.message.includes('三级内容已隐藏');
    if (error.adultHidden) applyConfig(await api('/api/config'));
    throw error;
  }
  if (sourcesAtRequest !== null && sourcesAtRequest === JSON.stringify(config.sources)) {
    const failed = new Set((data.failedSources || []).map(source => source.source));
    for (const source of failed) sourceSuccess.delete(source);
    for (const group of data.groups || []) for (const item of group.items || []) if (!failed.has(item.source)) sourceSuccess.set(item.source, Date.now());
  }
  return data;
}

function goto(view, params = {}) {
  const query = new URLSearchParams(params).toString();
  const hash = `#${view}${query ? `?${query}` : ''}`;
  if (location.hash === hash) void renderRoute();
  else location.hash = hash;
}

function section(title, subtitle, action) {
  const wrapper = node('section', undefined, 'section');
  const heading = node('div', undefined, 'section-heading');
  const headingText = node('h2', title);
  if (subtitle) headingText.append(node('small', subtitle));
  heading.append(headingText);
  if (action) heading.append(action);
  wrapper.append(heading);
  return wrapper;
}

function empty(title, message, action) {
  const element = node('div', undefined, 'empty-state');
  element.append(node('h3', title), node('p', message, 'muted'));
  if (action) element.append(action);
  return element;
}

function externalLink(label, url, className = 'button subtle') {
  const element = node('a', label, className);
  const safe = httpUrl(url);
  if (safe) element.href = safe;
  else { element.removeAttribute('href'); element.setAttribute('aria-disabled', 'true'); }
  element.target = '_blank';
  element.rel = 'noopener noreferrer';
  return element;
}

function typeLabel(type) { return type === 'series' ? '剧集' : type === 'movie' ? '电影' : '链接'; }
function sourceName(id) { return config.sources.find(source => source.id === id)?.name || id || '链接播放'; }
function fieldsOf(item) {
  return { key: item.key, title: item.title, year: item.year || '', type: item.type || 'movie', poster: item.poster || '', source: item.source || '', id: String(item.id ?? ''), ...(item.category ? { category: item.category } : {}) };
}

function visibleItem(item) { return config.showAdult === true || item.category !== 'adult'; }

function sameContentCategory(first, second) { return (first.category === 'adult') === (second.category === 'adult'); }

function sourceCandidates(target, items) {
  const matching = items.filter(item => visibleItem(item) && sameContentCategory(target, item));
  return matching.filter((item, index) => matching.findIndex(other => other.source === item.source && String(other.id) === String(item.id)) === index);
}

function leaveAdultScreen() {
  routeVersion++; void stopPlayer(); detail = null; detailTarget = null; openingItem = null;
  content.replaceChildren(node('div', '分类显示设置已更新，正在返回电影分类…', 'loading'));
  goto('home', { category: 'movie' }); notify('三级内容已隐藏，已返回电影分类。');
}

function applyConfig(next) {
  const changed = Boolean(config.showAdult) !== Boolean(next.showAdult);
  const sourcesChanged = JSON.stringify(config.sources) !== JSON.stringify(next.sources);
  if (sourcesChanged || changed) { resourceVersion++; sourceSuccess.clear(); playabilityCache.clear(); resourceSnapshots.clear(); }
  if (JSON.stringify(config.liveSources) !== JSON.stringify(next.liveSources)) liveSnapshot = null;
  const adultScreen = detail?.category === 'adult' || detailTarget?.category === 'adult' || openingItem?.category === 'adult' || location.hash.startsWith('#home?') && new URLSearchParams(location.hash.split('?')[1]).get('category') === 'adult';
  config = next;
  if (changed) {
    browseGroups = []; lastSearch = { q: '', groups: [] }; openingItem = null;
    if (!config.showAdult && adultScreen) { leaveAdultScreen(); return true; }
  }
  if (sourcesChanged && player?.detail === detail && detail) { detail.verification = null; renderSources(detail, detail.candidates || []); renderEpisodes(detail); }
  return false;
}

function acceptImport(next) {
  importWarnings = (Array.isArray(next.importWarnings) ? next.importWarnings : []).filter(message => typeof message === 'string');
  const { importWarnings: _warnings, ...accepted } = next;
  applyConfig(accepted);
}

function openItem(item, resume = false) {
  if (!visibleItem(item)) { leaveAdultScreen(); return; }
  if (item.key?.startsWith('link:')) goto('link', { url: item.url || item.key.slice(5), resume: resume ? '1' : '0' });
  else {
    const candidates = item.items ? sourceCandidates(item, item.items) : [item];
    const selected = candidates.find(candidate => candidate.source === item.source && String(candidate.id) === String(item.id)) || candidates[0];
    if (!selected) return notify('这个分类暂时没有可用的影视源，请重新搜索。', true);
    const saved = library.history.find(record => record.key === item.key && sameContentCategory(item, record) && config.sources.some(source => source.id === record.source && source.enabled !== false));
    openingItem = { ...item, ...selected, ...(saved || {}) };
    goto('detail', { source: openingItem.source, id: openingItem.id });
  }
}

function card(item, options = {}) {
  const element = node('article', undefined, 'media-card');
  const cover = button('', () => openItem(item, options.resume), 'poster-link');
  cover.setAttribute('aria-label', `${options.resume ? '继续观看' : '播放'} ${item.title}`);
  const poster = httpUrl(item.poster);
  if (poster) {
    const image = node('img');
    image.src = poster; image.alt = ''; image.loading = options.priority ? 'eager' : 'lazy'; image.decoding = 'async'; image.fetchPriority = options.priority ? 'high' : 'low'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    cover.append(image);
  }
  cover.append(node('span', item.title, 'poster-fallback'));
  if (item.douban?.id && Number.isFinite(item.douban.score) && item.douban.score >= 0 && item.douban.score <= 10) {
    const badge = node('span', `豆瓣 ${item.douban.score.toFixed(1)}`, 'rating-badge'); badge.title = '豆瓣评分由影视源提供，可能存在更新延迟。'; cover.append(badge);
  }
  cover.append(node('span', options.resume ? `继续 · ${formatTime(item.position || 0)}` : item.remarks || `${item.year || '年份未知'} · ${item.typeName || typeLabel(item.type)}`, 'poster-tag'));
  if (item.duration > 0 && options.resume) {
    const progress = node('progress'); progress.max = item.duration; progress.value = item.position || 0;
    progress.setAttribute('aria-label', '观看进度'); cover.append(progress);
  }
  const metadata = node('p', options.resume ? sourceName(item.source) : `${item.year || '年份未知'} · ${item.typeName || typeLabel(item.type)} · ${item.items?.length || 1} 个来源`, 'card-meta'); metadata.title = (item.genres || []).join(' · ');
  element.append(cover, node('h3', item.title, 'card-title'), metadata);
  if (options.releaseDates) element.append(node('p', browseReleaseDate(item) || '上映日期未知', 'card-date'));
  if (options.remove) {
    const remove = button('×', options.remove, 'card-delete'); remove.setAttribute('aria-label', `移除 ${item.title}`); element.append(remove);
  }
  return element;
}

function grid(items, options = {}) {
  const element = node('div', undefined, 'poster-grid');
  items.filter(visibleItem).forEach((item, index) => element.append(card(item, typeof options === 'function' ? options(item) : { ...options, priority: index < (options.priorityCount || 0) })));
  return element;
}

function urlForm() {
  const panel = node('section', undefined, 'url-panel');
  panel.append(node('h2', '已有视频链接？直接开始看'), node('p', '粘贴视频页、MP4 或 M3U8 链接，选择解析线路播放。', 'muted'));
  const form = node('form', undefined, 'url-form');
  const input = node('input'); input.type = 'url'; input.required = true; input.placeholder = 'https://…'; input.setAttribute('aria-label', '视频链接');
  const submit = node('button', '播放链接 →', 'button primary'); submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const url = httpUrl(input.value.trim());
    if (!url) return notify('请输入有效的 HTTP 或 HTTPS 视频链接', true);
    goto('link', { url });
  });
  panel.append(form);
  return panel;
}

async function addPresets(element) {
  element.disabled = true;
  try {
    const presets = await api('/api/config/presets');
    acceptImport(await api('/api/config/import', { method: 'POST', body: { config: presets } }));
    updateSourceStatus(); await renderRoute(); notify('内置影视源已添加，原有自定义源已保留');
  } catch (error) { notify(`添加失败：${error.message}`, true); }
  finally { element.disabled = false; }
}

function presetButton() {
  return button('添加内置影视源', event => void addPresets(event.currentTarget), 'button small primary');
}

function groupCards(groups) {
  return groups.map(group => {
    const items = sourceCandidates(group, group.items || []);
    return items.length ? { ...group, ...items[0], key: group.key, items, releaseDate: browseReleaseDate(group), genres: group.genres || items[0].genres || [] } : null;
  }).filter(Boolean);
}

function mergeGroups(previous, incoming) {
  const groups = new Map(previous.map(group => [group.key, { ...group, items: [...group.items] }]));
  for (const group of incoming) {
    const existing = groups.get(group.key);
    if (!existing) groups.set(group.key, { ...group, items: [...group.items], releaseDate: browseReleaseDate(group), genres: [...(group.genres || [])] });
    else {
      existing.releaseDate = [browseReleaseDate(existing), browseReleaseDate(group)].filter(Boolean).sort()[0] || '';
      existing.genres = [...new Set([...(existing.genres || []), ...(group.genres || [])])];
      for (const item of group.items) if (!existing.items.some(other => other.source === item.source && String(other.id) === String(item.id))) existing.items.push(item);
    }
  }
  return [...groups.values()];
}

function failuresList(sources, label = '影视源') {
  if (!sources?.length) return null;
  const failures = node('details', undefined, 'failure-list');
  failures.append(node('summary', `${sources.length} 个${label}未返回内容，其他来源不受影响`));
  for (const source of sources) failures.append(node('p', `${source.name || source.source}：${source.error}`));
  return failures;
}

const browseGenres = ['喜剧', '惊悚', '恐怖', '动作', '爱情', '科幻', '悬疑', '犯罪', '战争', '剧情', '动画', '冒险', '奇幻', '家庭', '历史', '纪录', '武侠', '古装', '音乐', '运动', '青春'];

function browseParams(category, source = '', filters = {}) {
  return { category, ...(source ? { source } : {}), ...(filters.genre ? { genre: filters.genre } : {}), ...(filters.year ? { year: filters.year } : {}), ...(filters.sort && filters.sort !== 'updated' ? { sort: filters.sort } : {}) };
}

function browseReleaseDate(item) {
  return [item.releaseDate, ...(item.items || []).map(value => value.releaseDate)].filter(value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }).sort()[0] || '';
}

function sortBrowseGroups(groups, sort) {
  if (sort === 'updated') return groups;
  const value = group => {
    if (sort === 'year') return /^\d{4}$/.test(group.year) ? Number(group.year) : 0;
    const date = browseReleaseDate(group);
    return date ? Number(date.replaceAll('-', '')) : 0;
  };
  return [...groups].sort((first, second) => value(second) - value(first));
}

function categoryTabs(category, selectedSource = '', filters = {}) {
  const tabs = node('div', undefined, 'category-tabs'); tabs.setAttribute('aria-label', '影视分类');
  const categories = { movie: '电影', tv: '电视剧', anime: '动漫', variety: '综艺·栏目', live: '电视直播', ...(config.showAdult === true ? { adult: '三级' } : {}) };
  for (const [id, name] of Object.entries(categories)) {
    const tab = button(name, () => id === 'live' ? goto('live') : goto('home', browseParams(id, selectedSource, filters)), `button${id === category ? ' selected' : ''}`);
    tab.setAttribute('aria-pressed', String(id === category)); tabs.append(tab);
  }
  return tabs;
}

async function renderHome(category = 'movie', selectedSource = '', stamp = routeVersion, statePromise = null, filters = {}) {
  filters = { genre: filters.genre || '', year: filters.year || '', sort: ['release', 'year'].includes(filters.sort) ? filters.sort : 'updated' };
  const page = document.createDocumentFragment();
  const catalog = section('发现好故事', '选一部，直接开始看');
  const controls = node('div', undefined, 'browse-controls');
  const categories = { movie: '电影', tv: '电视剧', anime: '动漫', variety: '综艺·栏目', ...(config.showAdult === true ? { adult: '三级' } : {}) };
  if (!categories[category]) category = 'movie';
  const tabs = categoryTabs(category, selectedSource, filters);
  const select = node('select'); select.setAttribute('aria-label', '浏览影视源');
  const all = node('option', '全部影视源'); all.value = ''; select.append(all);
  function updateSourceChoices() {
    select.replaceChildren(all);
    for (const source of config.sources.filter(source => source.enabled !== false && Date.now() - (sourceSuccess.get(source.id) || 0) < 5 * 60 * 1000)) {
      const option = node('option', source.name); option.value = source.id; select.append(option);
    }
    select.value = [...select.options].some(option => option.value === selectedSource) ? selectedSource : '';
  }
  updateSourceChoices();
  select.addEventListener('change', () => goto('home', browseParams(category, select.value, filters)));
  controls.append(tabs, select); catalog.append(controls);
  const filterRow = node('div', undefined, 'browse-filters');
  function filterSelect(label, ariaLabel) {
    const field = node('label', undefined, 'browse-filter'); field.append(node('span', label));
    const input = node('select'); input.setAttribute('aria-label', ariaLabel); field.append(input); filterRow.append(field); return input;
  }
  const genreSelect = filterSelect('类型', '影片类型'), yearSelect = filterSelect('上映年份', '上映年份'), sortSelect = filterSelect('排列', '影片排序');
  function choices(input, values, placeholder, selected) {
    const list = ['', ...values.filter(value => value !== '')]; if (selected && !list.includes(selected)) list.push(selected);
    if (input.options.length !== list.length || [...input.options].some((option, index) => option.value !== list[index])) {
      input.replaceChildren(); for (const value of list) { const option = node('option', value || placeholder); option.value = value; input.append(option); }
    }
    input.value = selected;
  }
  function updateFacets(facets = {}) {
    choices(genreSelect, Array.isArray(facets.genres) ? facets.genres.filter(value => typeof value === 'string') : browseGenres, '全部类型', filters.genre);
    choices(yearSelect, Array.isArray(facets.years) ? facets.years.map(String) : Array.from({ length: new Date().getFullYear() - 1899 }, (_value, index) => String(new Date().getFullYear() - index)), '全部年份', filters.year);
  }
  updateFacets();
  for (const [value, label] of [['updated', '默认顺序'], ['release', '上映时间（已加载）'], ['year', '年份（已加载）']]) { const option = node('option', label); option.value = value; sortSelect.append(option); }
  sortSelect.value = filters.sort;
  for (const [input, field] of [[genreSelect, 'genre'], [yearSelect, 'year'], [sortSelect, 'sort']]) input.addEventListener('change', () => goto('home', browseParams(category, selectedSource, { ...filters, [field]: input.value })));
  catalog.append(filterRow);
  const sortNote = node('p', filters.sort === 'year' ? '排序仅针对已加载影片，按上映年份从新到旧排列。' : '排序仅针对已加载影片；没有完整上映日期的影片排在末尾。', 'filter-note muted'); sortNote.hidden = filters.sort === 'updated'; catalog.append(sortNote);
  const listing = node('div'); listing.id = 'browse-results'; catalog.append(listing);
  const more = button('加载更多', () => void loadPage(), 'button subtle'); more.hidden = true; more.classList.add('load-more'); catalog.append(more);
  page.append(catalog);
  if (!config.sources.some(source => source.enabled !== false)) {
    const guide = node('div', '还没有影视源。添加内置源，或导入兼容 MoonTV / KatelyaTV 的配置后即可浏览影片。', 'notice');
    guide.append(presetButton(), button('导入自定义源', () => goto('settings'), 'button small')); listing.append(guide);
  }
  const collections = node('div', undefined, 'home-collections');
  const drawCollections = () => {
  const recent = library.history.filter(item => !item.key.startsWith('link:') && visibleItem(item)).slice(0, 6);
  const watching = section('继续观看', recent.length ? `${recent.length} 部影片` : '', externalLink('全部记录 →', `${location.origin}/#history`, 'text-link'));
  const historyLink = $('.text-link', watching); if (historyLink) { historyLink.target = '_self'; historyLink.removeAttribute('rel'); }
  watching.append(recent.length ? grid(recent, { resume: true }) : empty('从一部影片开始', '搜索并播放后，观看进度会保存在这里。', button('搜索影片', () => goto('search'), 'button primary')));
  const savedFavorites = library.favorites.filter(visibleItem);
  const favorites = section('我的收藏', savedFavorites.length ? `${savedFavorites.length} 部` : '', button('查看全部 →', () => goto('favorites'), 'button subtle small'));
  favorites.append(savedFavorites.length ? grid(savedFavorites.slice(0, 6)) : node('p', '遇到喜欢的影片，点亮收藏按钮，留给下次观看。', 'muted'));
  collections.replaceChildren(watching, favorites);
  };
  drawCollections(); page.append(collections);
  const platforms = section('平台入口', '在平台找到视频页后，粘贴链接解析');
  const platformGrid = node('div', undefined, 'platform-grid');
  for (const platform of config.platforms.filter(item => item.enabled !== false && httpUrl(item.url))) {
    const link = externalLink('', platform.url, 'platform-link');
    const caption = node('div'); caption.append(node('strong', platform.name), node('small', platform.category || '视频平台'));
    link.append(node('span', platform.name.slice(0, 1), 'platform-logo'), caption, node('span', '↗', 'platform-arrow')); platformGrid.append(link);
  }
  platforms.append(platformGrid.childElementCount ? platformGrid : empty('暂无平台入口', '可在资源设置中添加平台链接。')); page.append(urlForm(), platforms);
  content.replaceChildren(page);
  if (statePromise) void statePromise.then(state => {
    if (state && stamp === routeVersion && content.contains(collections)) { library = state; drawCollections(); }
  });
  let groups = [];
  let nextPage = 1;
  const sourcesAtEntry = resourceVersion, hashAtEntry = location.hash;
  const valid = () => stamp === routeVersion && hashAtEntry === location.hash && sourcesAtEntry === resourceVersion;
  async function loadPage(force = false) {
    more.disabled = true;
    if (nextPage === 1 && !groups.length) listing.replaceChildren(node('div', `正在加载${categories[category]}…`, 'loading'));
    else more.textContent = '正在加载…';
    try {
      const path = `/api/browse?${new URLSearchParams({ ...browseParams(category, selectedSource, filters), page: nextPage, progressive: '1' })}`;
      const draw = result => {
      updateSourceChoices(); updateFacets(result.facets);
      const incoming = (result.groups || []).filter(group => category === 'adult' ? group.category === 'adult' : group.category !== 'adult').map(group => ({ ...group, items: group.items.filter(item => category === 'adult' ? item.category === 'adult' : item.category !== 'adult') }));
      groups = sortBrowseGroups(mergeGroups(groups, incoming.filter(group => group.items.length)), filters.sort); browseGroups = mergeGroups(browseGroups, groups);
      listing.replaceChildren(); const failures = failuresList(result.failedSources); if (failures) listing.append(failures);
      if (result.complete === false) listing.append(node('p', pendingSources(result), 'resource-progress muted'));
      listing.append(groups.length ? grid(groupCards(groups), { priorityCount: 6, releaseDates: filters.sort === 'release' }) : result.complete === false ? node('p', '正在等待影视源返回影片…', 'muted') : empty('这个分类暂时没有影片', '试试切换影视源或稍后重新加载。', button('重新加载', () => void loadPage(true))));
      more.hidden = !result.hasMore; more.textContent = '加载更多';
      };
      const cached = resourceSnapshot(path); if (cached && !force) draw(cached);
      const result = await progressiveResults(path, valid, draw, force);
      if (!valid() || !result) return;
      nextPage++;
    } catch (error) {
      if (!valid()) return;
      if (error.adultHidden) { leaveAdultScreen(); return; }
      if (selectedSource) { sourceSuccess.delete(selectedSource); updateSourceChoices(); }
      if (nextPage === 1 && !groups.length) listing.replaceChildren(empty('分类内容暂时不可用', error.message, button('重新加载', () => void loadPage(true))));
      else { more.textContent = '重试加载更多'; notify(error.message, true); }
    } finally { more.disabled = false; }
  }
  if (config.sources.some(source => source.enabled !== false)) await loadPage();
}

async function removeRecord(kind, item) {
  try {
    if (kind === 'history') await historyQueue.catch(error => console.warn('等待记录保存时失败', error));
    await api(`/api/${kind}?${new URLSearchParams({ key: item.key })}`, { method: 'DELETE' });
    library[kind] = library[kind].filter(record => record.key !== item.key);
    await renderRoute(); notify(kind === 'favorites' ? '已取消收藏' : '已移除记录');
  } catch (error) { notify(error.message, true); }
}

function linkHistory(items) {
  const list = node('div', undefined, 'link-history');
  for (const item of items) {
    const row = node('article', undefined, 'link-history-item');
    const text = node('div'); text.append(node('strong', item.title), node('p', item.url || item.key.slice(5)));
    const remove = button('×', () => void removeRecord('history', item), 'button subtle small'); remove.setAttribute('aria-label', `移除 ${item.title}`);
    row.append(text, button('继续播放', () => openItem(item, true), 'button small'), remove); list.append(row);
  }
  return list;
}

function renderLibrary(kind) {
  const items = library[kind].filter(visibleItem);
  const page = section(kind === 'favorites' ? '留给下一次的好故事' : '接着上次，继续看', `${items.length} 条`);
  const films = items.filter(item => !item.key.startsWith('link:'));
  if (films.length) page.append(grid(films, item => ({ resume: kind === 'history', remove: () => void removeRecord(kind, item) })));
  const links = items.filter(item => item.key.startsWith('link:'));
  if (links.length) page.append(linkHistory(links));
  if (!items.length) page.append(empty(kind === 'favorites' ? '收藏夹还是空的' : '还没有观看记录', '从搜索找到一部想看的影片。', button('搜索影片', () => goto('search'), 'button primary')));
  if (kind === 'history' && items.length) {
    const clear = button('清空观看记录', async () => {
      if (!window.confirm('清空所有设备共用的观看记录？收藏会保留。')) return;
      try { await historyQueue.catch(error => console.warn('等待记录保存时失败', error)); await api('/api/history', { method: 'DELETE' }); library.history = []; renderLibrary('history'); notify('观看记录已清空'); }
      catch (error) { notify(error.message, true); }
    }, 'button subtle danger');
    clear.style.marginTop = '24px'; page.append(clear);
  }
  content.replaceChildren(page);
}

async function renderSearch(query, stamp) {
  const form = node('form', undefined, 'search-form');
  const input = node('input'); input.type = 'search'; input.value = query; input.placeholder = '搜索电影、剧集名称'; input.required = true; input.setAttribute('aria-label', '影片名称');
  const submit = node('button', '搜索', 'button primary'); submit.type = 'submit'; form.append(input, submit);
  form.addEventListener('submit', event => { event.preventDefault(); goto('search', { q: input.value.trim() }); });
  const results = node('div'); content.replaceChildren(form, results);
  if (!config.sources.some(source => source.enabled !== false)) {
    results.append(empty('添加影视源，开启搜索', '支持导入 api_site JSON，也可以手动添加 AppleCMS 接口。', button('前往资源设置', () => goto('settings'), 'button primary'))); return;
  }
  if (!query) { results.append(empty('你想看什么？', '输入片名，在已启用的影视源中同时搜索。')); input.focus({ preventScroll: true }); return; }
  results.append(node('div', '正在各个影视源中查找…', 'loading'));
  try {
    const sourcesAtEntry = resourceVersion, hashAtEntry = location.hash;
    const valid = () => stamp === routeVersion && hashAtEntry === location.hash && sourcesAtEntry === resourceVersion;
    const path = `/api/search?${new URLSearchParams({ q: query, progressive: '1' })}`;
    let groups = [];
    const draw = data => {
    groups = mergeGroups(groups, (data.groups || []).filter(visibleItem)); lastSearch = { q: query, groups };
    results.replaceChildren();
    if (data.failedSources?.length) {
      results.append(failuresList(data.failedSources));
    }
    const heading = section('搜索结果', `${lastSearch.groups.length} 部影片`);
    const items = groupCards(lastSearch.groups);
    if (data.complete === false) heading.append(node('p', pendingSources(data), 'resource-progress muted'));
    heading.append(items.length ? grid(items, { priorityCount: 6 }) : data.complete === false ? node('p', '正在等待影视源返回影片…', 'muted') : empty('没有找到相关影片', '试试更短的片名，或在设置中检查影视源。')); results.append(heading);
    };
    const cached = resourceSnapshot(path); if (cached) draw(cached);
    await progressiveResults(path, valid, draw);
  } catch (error) { if (stamp === routeVersion) results.replaceChildren(empty('搜索暂时不可用', error.message, button('重试', () => goto('search', { q: query }), 'button'))); }
}

function findCandidates(data) {
  const items = [...(data.candidates || []), ...(lastSearch.groups.find(group => group.key === data.key)?.items || []), ...(browseGroups.find(group => group.key === data.key)?.items || [])];
  return sourceCandidates(data, items);
}

function loadCandidates(data, stamp) {
  if (data.candidatesPromise) return data.candidatesPromise;
  data.candidates = findCandidates(data);
  data.candidatesPromise = (async () => {
    try {
      const alternatives = await api(`/api/search?${new URLSearchParams({ q: data.title })}`);
      const group = alternatives.groups?.find(item => item.key === data.key && item.year === data.year && item.type === data.type);
      if (group) data.candidates = sourceCandidates(data, mergeGroups([{ key: data.key, items: data.candidates }], [group])[0].items);
      if (stamp === routeVersion && detail === data) renderSources(data, data.candidates);
    } catch (error) {
      if (stamp === routeVersion && detail === data) $('#source-row')?.append(node('span', `其他来源查询失败：${error.message}`, 'muted'));
    }
    return data.candidates;
  })();
  return data.candidatesPromise;
}

async function fetchDetail(candidate, target, flow, stamp, request) {
  let lastError;
  while (candidate && flow.tried.size < 3) {
    flow.tried.add(candidate.source);
    try {
      const data = await api(`/api/detail?${new URLSearchParams({ source: candidate.source, id: candidate.id })}`);
      if (stamp !== routeVersion || request !== playVersion) return null;
      if (target && !sameContentCategory(target, data)) throw new Error('这个来源的影片分类不匹配');
      if (!visibleItem(data)) { leaveAdultScreen(); return null; }
      if (target?.key && (flow.tried.size > 1 || target.source !== candidate.source) && (data.key !== target.key || data.year !== target.year || data.type !== target.type)) throw new Error('这个来源的影片信息不匹配');
      data.candidates = target ? findCandidates(target) : findCandidates(data);
      if (target?.candidatesPromise) data.candidatesPromise = target.candidatesPromise;
      return data;
    } catch (error) {
      lastError = error;
      if (stamp !== routeVersion || request !== playVersion) return null;
      if (error.adultHidden && target?.category === 'adult') { leaveAdultScreen(); return null; }
      if (!target?.title || flow.tried.size >= 3) break;
      const candidates = await loadCandidates(target, stamp);
      if (stamp !== routeVersion || request !== playVersion) return null;
      candidate = candidates.find(item => !flow.tried.has(item.source));
    }
  }
  throw lastError || new Error('没有可用的其他影视源');
}

function selectionFor(data, reference = {}) {
  const choices = [];
  data.lines.forEach((line, index) => {
    const episode = reference.episodeName ? matchEpisode(line, reference.episodeName, reference.episode || 0) : line.episodes[reference.episode || 0] ? reference.episode || 0 : -1;
    if (episode >= 0 && ['hls', 'mp4'].includes(line.episodes[episode].type)) choices.push({ line: index, episode, direct: true, preferred: reference.source === data.source && index === reference.line || line.name === reference.lineName });
  });
  choices.sort((a, b) => Number(b.direct) - Number(a.direct) || Number(b.preferred) - Number(a.preferred));
  return choices[0] || null;
}

function playPosition(current) {
  if (current?.transcodeLoading || (current?.transcoded && !current.transcodeReady)) return current.position || 0;
  return current?.video?.readyState >= 1 ? (current.transcoded ? current.startPosition || 0 : 0) + current.video.currentTime : current?.position || 0;
}

function playDuration(current) {
  const duration = current?.transcoded ? current.originalDuration : current?.video?.duration;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function historyRecord(current) {
  return { ...fieldsOf(current.detail), line: current.line || 0, episode: current.episode || 0, url: current.originalUrl || current.url, mode: current.mode, ...(current.mode === 'parser' ? { parser: current.parser || '' } : { position: playPosition(current), duration: playDuration(current) }) };
}

function stopTranscode(id, keepalive = false) {
  if (!id) return Promise.resolve();
  return api('/api/transcode/stop', { method: 'POST', body: { id }, keepalive }).catch(error => console.warn('兼容播放任务停止失败', error.message));
}

function compatibilityLabel(current) {
  return current.acceleration === 'vaapi' ? '硬件兼容播放' : '软件兼容播放';
}

async function startCompatibility(current, position = playPosition(current), automatic = false) {
  if (player !== current || !(current.catalog || current.live) || !(current.quarkAsset ? ['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'] : ['hls', 'mp4']).includes(current.originalType || current.type)) return;
  if (automatic && current.flow?.transcodeTried) return;
  if (automatic) current.flow.transcodeTried = true;
  if (!current.transcodePromise) current.request = ++playVersion;
  if (current.catalog && !current.preferences) {
    current.preferences = normalizePreferences(await (current.detail.preferencesPromise ||= api(`/api/player/preferences?${new URLSearchParams({ key: current.detail.key })}`).catch(error => { console.warn('播放偏好读取失败', error.message); return defaultPreferences; })));
    if (player !== current) return;
  }
  const duration = playDuration(current);
  let target = current.live ? 0 : Math.max(0, Math.min(86400, Number(position) || 0));
  if (duration > 0) target = Math.min(target, Math.max(0, duration - 1));
  current.preferences ||= { ...defaultPreferences };
  if (current.catalog && target === 0 && !current.introHandled) target = Math.max(target, current.preferences.introSeconds);
  if (duration > 0) target = Math.min(target, Math.max(0, duration - 1));
  current.pendingTranscodePosition = target;
  if (current.transcodePromise) return current.transcodePromise;
  current.transcodePromise = (async () => {
    while (player === current && current.pendingTranscodePosition !== undefined) {
      const requested = current.pendingTranscodePosition; delete current.pendingTranscodePosition;
      const request = current.request, stamp = current.stamp;
      const valid = () => player === current && current.request === request && playVersion === request && routeVersion === stamp;
      current.position = requested; current.transcodeLoading = true; current.recovering = true; current.failed = false;
      clearTimeout(current.loadTimer); clearInterval(current.danmakuTimer); current.danmakuTimer = null;
      if (current.video) current.video.pause();
      current.note.textContent = '正在准备兼容播放，首次启动可能需要约 20 秒…'; current.note.className = 'player-note';
      if (current.compatibilityButton) current.compatibilityButton.disabled = true;
      try {
        const body = current.live ? { liveId: current.channel.id, line: current.line, position: 0, speed: 1 } : current.quarkAsset ? { quarkAsset: current.quarkAsset, position: requested, speed: current.preferences.speed } : { ...playbackSelection(current.detail, current.line, current.episode), id: String(current.detail.id), position: requested, speed: current.preferences.speed };
        const job = await api('/api/transcode/start', { method: 'POST', body, timeoutMs: 35000 });
        if (!valid()) { await stopTranscode(job.id, true); return; }
        if (!job.id || !mediaUrl(job.url) || job.type !== 'hls') { await stopTranscode(job.id, true); throw new Error('兼容播放服务返回了无效的播放任务。'); }
        current.originalUrl ||= current.url; current.originalType ||= current.type;
        Object.assign(current, { transcodeId: job.id, transcoded: true, transcodeReady: false, startPosition: Number(job.startPosition) || 0, originalDuration: Number.isFinite(job.duration) && job.duration > 0 ? job.duration : 0, acceleration: job.acceleration, url: job.url, type: 'hls', usedProxy: false, started: true, position: Number(job.startPosition) || 0, introHandled: true, failed: false, recovering: false });
        current.transcodeLoading = false;
        if (current.pendingTranscodePosition !== undefined) continue;
        if (current.video) { resetDanmaku(current); loadMedia(current, `正在连接${compatibilityLabel(current)}…`); }
        else mountPlayer(current);
        if (current.proxyButton) current.proxyButton.disabled = true;
        if (current.compatibilityButton) current.compatibilityButton.textContent = '重新兼容播放';
      } catch (error) {
        if (!valid()) { console.warn('离开播放器后兼容任务启动失败', error.message); return; }
        delete current.pendingTranscodePosition; current.failed = true; current.recovering = false;
        current.note.textContent = error.status === 409 ? '兼容播放正被另一台设备使用，请稍后再试。' : `兼容播放未启动：${error.message}`;
        current.note.className = 'player-note error-message'; console.warn('兼容播放启动失败', error.message);
      } finally {
        current.transcodeLoading = false;
        if (player === current && current.compatibilityButton) current.compatibilityButton.disabled = false;
      }
    }
  })().finally(() => { current.transcodePromise = null; });
  return current.transcodePromise;
}

async function withVerificationSlot(work) {
  if (verificationActive < 2) verificationActive++;
  else await new Promise(resolve => verificationQueue.push(resolve));
  try { return await work(); }
  finally { const next = verificationQueue.shift(); if (next) next(); else verificationActive--; }
}

function playbackSelection(data, line, episode) {
  return { source: data.source, id: data.id, line, episode };
}

function playbackKey(data, line, episode) {
  return JSON.stringify([config.sources.find(item => item.id === data.source)?.api, data.source, data.id, line, episode, data.lines[line]?.episodes[episode]?.url]);
}

function checkSelection(data, line, episode, valid = () => true) {
  const selected = data.lines[line]?.episodes[episode];
  if (!selected || !['hls', 'mp4'].includes(selected.type)) return Promise.resolve({ playable: false, error: '这条线路没有可直接播放的视频' });
  const key = playbackKey(data, line, episode);
  const cached = playabilityCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise || Promise.resolve(cached.result);
  const entry = { expires: Infinity };
  const work = async () => {
    if (!valid()) { entry.expires = 0; entry.promise = null; return { playable: false, cancelled: true }; }
    let result;
    try { result = await api(`/api/playability?${new URLSearchParams(playbackSelection(data, line, episode))}`, { timeoutMs: 25000 }); }
    catch (error) { result = { playable: false, error: error.message }; }
    if (entry.reported) return entry.result;
    entry.result = result; entry.expires = Date.now() + (result.playable ? 300000 : 60000); entry.promise = null;
    return result;
  };
  entry.promise = withVerificationSlot(work);
  playabilityCache.set(key, entry);
  if (playabilityCache.size > 2000) playabilityCache.delete(playabilityCache.keys().next().value);
  return entry.promise;
}

function verificationReference(data) {
  if (player?.detail === data) return player;
  return data.selectionReference || { source: data.source, line: data.selectedLine, episode: 0, episodeName: data.lines[data.selectedLine]?.episodes[0]?.name };
}

function verifyOptions(data, candidates) {
  const reference = verificationReference(data);
  const choices = sourceCandidates(data, candidates);
  if (!choices.some(item => item.source === data.source && String(item.id) === String(data.id))) choices.unshift(data);
  const signature = JSON.stringify([playVersion, config.sources, reference.episodeName, reference.episode, choices.map(item => [item.source, item.id])]);
  if (data.verification?.signature === signature) return;
  const state = { signature, sources: new Map(), lines: new Map(), pending: choices.length };
  const stamp = routeVersion, request = playVersion;
  data.verification = state;
  const valid = () => detail === data && data.verification === state && stamp === routeVersion && request === playVersion;
  for (const candidate of choices) void (async () => {
    if (!valid()) return;
    try {
      const own = candidate.source === data.source && String(candidate.id) === String(data.id);
      const item = own ? data : await withVerificationSlot(() => valid() ? api(`/api/detail?${new URLSearchParams({ source: candidate.source, id: candidate.id })}`, { timeoutMs: 10000 }) : null);
      if (!valid() || item.key !== data.key || item.year !== data.year || item.type !== data.type || !sameContentCategory(data, item)) return;
      const preferred = selectionFor(item, reference);
      const indexes = item.lines.map((_line, index) => index).sort((first, second) => Number(second === preferred?.line) - Number(first === preferred?.line));
      for (const line of indexes) {
        const episode = matchEpisode(item.lines[line], reference.episodeName, reference.episode || 0);
        if (episode < 0 || !valid()) continue;
        const result = await checkSelection(item, line, episode, valid);
        if (!valid()) return;
        if (result.playable) {
          state.sources.set(`${candidate.source}:${candidate.id}`, candidate);
          if (own) state.lines.set(line, episode);
          renderSources(data, data.candidates || candidates); renderEpisodes(data);
          if (!own) break;
        }
      }
    } catch (error) { if (valid()) console.warn('候选线路验证失败', error.message); }
    finally {
      state.pending--;
      if (valid()) { renderSources(data, data.candidates || candidates); renderEpisodes(data); }
    }
  })();
}

function reportPlayback(current, status) {
  if (player !== current || !current.catalog || current.transcoded || current.quarkAsset || current.playabilityReported === status) return;
  current.playabilityReported = status;
  const key = playbackKey(current.detail, current.line, current.episode);
  const entry = playabilityCache.get(key) || {};
  entry.reported = true; entry.promise = null; entry.result = { playable: status === 'ok', checkedAt: Date.now() }; entry.expires = Date.now() + (status === 'ok' ? 300000 : 60000);
  playabilityCache.set(key, entry);
  if (status === 'error') {
    const state = current.detail.verification;
    state?.lines.delete(current.line);
    if (!state?.lines.size) state?.sources.delete(`${current.detail.source}:${current.detail.id}`);
    renderSources(current.detail, current.detail.candidates || []); renderEpisodes(current.detail);
  }
  void api('/api/playability/report', { method: 'POST', body: { ...playbackSelection(current.detail, current.line, current.episode), status } }).catch(error => console.warn('影片线路结果未同步', error.message));
}

async function openDetail(source, id, stamp) {
  content.replaceChildren(node('div', '正在读取影片与播放线路…', 'loading'));
  const request = ++playVersion;
  const cached = [...lastSearch.groups, ...browseGroups].flatMap(group => group.items.map(item => ({ ...item, key: group.key }))).find(item => item.source === source && String(item.id) === String(id));
  const target = openingItem?.source === source && String(openingItem.id) === String(id) ? openingItem : cached || library.history.find(item => item.source === source && String(item.id) === String(id)) || library.favorites.find(item => item.source === source && String(item.id) === String(id));
  detailTarget = target || null;
  openingItem = null;
  if (target && !visibleItem(target)) { leaveAdultScreen(); return; }
  const flow = { tried: new Set() };
  let data;
  try { data = await fetchDetail({ source, id }, target, flow, stamp, request); }
  catch (error) {
    if (stamp !== routeVersion || request !== playVersion) return;
    if (error.adultHidden) { leaveAdultScreen(); return; }
    if (!target) throw error;
    detail = { ...target, source, id, lines: [], selectedLine: 0 };
    renderDetail(detail, findCandidates(target));
    $('#player-host').replaceChildren(empty('自动尝试已结束', `${error.message}。请手动切换影视源。`));
    return;
  }
  if (!data || stamp !== routeVersion || request !== playVersion) return;
  detail = data;
  const saved = library.history.find(record => record.key === data.key && sameContentCategory(data, record));
  const selected = selectionFor(data, saved || {});
  detail.selectedLine = selected?.line || 0;
  renderDetail(data, findCandidates(data));
  void loadCandidates(data, stamp);
  if (selected) void startEpisode(data, selected.line, selected.episode, saved?.position || 0, flow);
  else {
    const note = node('p', saved ? '未匹配到保存的剧集，请选择播放线路和剧集。' : '这个来源没有可播放剧集。', 'player-note');
    $('#player-host').replaceChildren(note);
    if (!data.lines.some(line => line.episodes.length)) {
      player = { detail: data, line: saved?.line || 0, episode: saved?.episode || 0, position: saved?.position || 0, started: false, catalog: true, stamp, request: playVersion, flow, note };
      void recoverPlayback(player);
    }
  }
}

function renderDetail(data, candidates) {
  const summary = node('section', undefined, 'detail-summary');
  const posterUrl = httpUrl(data.poster);
  if (posterUrl) { const image = node('img', undefined, 'detail-poster'); image.src = posterUrl; image.alt = ''; image.decoding = 'async'; image.fetchPriority = 'high'; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', () => image.remove(), { once: true }); summary.append(image); }
  const info = node('div', undefined, 'detail-info');
  info.append(node('h2', data.title), node('p', `${data.year || '年份未知'} · ${data.typeName || typeLabel(data.type)} · ${sourceName(data.source)}`, 'meta'));
  const ratings = node('div', '正在读取评分…', 'film-ratings'); ratings.setAttribute('aria-live', 'polite'); info.append(ratings);
  if (data.description) info.append(node('p', data.description, 'detail-description'));
  const actions = node('div', undefined, 'detail-actions');
  const history = library.history.find(record => record.key === data.key && record.source === data.source && sameContentCategory(data, record));
  const start = button(history ? `继续播放 · ${formatTime(history.position || 0)}` : '▷ 播放第一集', () => {
    const selected = selectionFor(data, history || {});
    if (selected) void startEpisode(data, selected.line, selected.episode, history?.position || 0);
  }, 'button primary');
  start.disabled = !data.lines.some(line => line.episodes.length);
  const favorite = button('', () => void toggleFavorite(data, favorite)); updateFavoriteButton(data, favorite);
  actions.append(start, favorite); info.append(actions); summary.append(info);
  const layout = node('div', undefined, 'watch-layout');
  const host = node('div', undefined, 'player-host'); host.id = 'player-host';
  const placeholder = node('div', undefined, 'player-surface');
  const placeholderContent = node('div', undefined, 'player-placeholder'); placeholderContent.append(node('span', '▷'), node('h3', '选一集，开始你的观影时间'), node('p', '观看进度会自动保存', 'muted')); placeholder.append(placeholderContent); host.append(placeholder);
  const episodes = node('aside', undefined, 'episode-panel'); episodes.id = 'episodes';
  layout.append(host, episodes);
  const sources = node('div', undefined, 'source-row'); sources.id = 'source-row';
  const quark = node('div'); quark.id = 'quark-resources'; content.replaceChildren(summary, layout, sources, quark);
  renderEpisodes(data); renderSources(data, candidates);
  void renderRatings(data, ratings);
}

async function renderRatings(data, host) {
  const searchUrl = `https://search.douban.com/movie/subject_search?${new URLSearchParams({ search_text: data.title, cat: '1002' })}`;
  try {
    const result = await (data.ratingsPromise ||= api(`/api/ratings?${new URLSearchParams({ source: data.source, id: data.id })}`));
    if (detail !== data || !host.isConnected) return;
    host.replaceChildren();
    const scores = node('div', undefined, 'rating-scores');
    const value = result.douban;
    const valid = Number.isFinite(value?.score) && value.score >= 0 && value.score <= 10;
    const badge = valid && httpUrl(value.url) ? externalLink(`豆瓣 ${value.score.toFixed(1)}`, value.url, 'rating-score') : node('span', valid ? `豆瓣 ${value.score.toFixed(1)}` : '暂无豆瓣评分', 'rating-score');
    if (valid && Number.isFinite(value.votes) && value.votes > 0) badge.title = `${Math.floor(value.votes).toLocaleString('zh-CN')} 人评分`;
    scores.append(badge); if (!valid) scores.append(externalLink('在豆瓣查找 ↗', searchUrl, 'rating-search'));
    host.append(scores);
    if (valid) host.append(node('small', value.attribution || '豆瓣评分由影视源提供，可能存在更新延迟。', 'rating-attribution'));
    if (result.errors?.length) host.append(node('small', result.errors.map(error => typeof error === 'string' ? error : error.error || error.message || '评分来源暂时不可用').join('；'), 'muted'));
  } catch (error) {
    if (detail === data && host.isConnected) host.replaceChildren(node('span', `暂无豆瓣评分：${error.message}`, 'muted'), externalLink('在豆瓣查找 ↗', searchUrl, 'rating-search'));
  }
}

function updateFavoriteButton(data, element) {
  const saved = library.favorites.some(item => item.key === data.key);
  element.textContent = saved ? '★ 已收藏' : '☆ 收藏'; element.setAttribute('aria-pressed', String(saved));
  element.className = `button${saved ? ' selected' : ''}`;
}

async function toggleFavorite(data, element) {
  element.disabled = true;
  try {
    if (library.favorites.some(item => item.key === data.key)) {
      await api(`/api/favorites?${new URLSearchParams({ key: data.key })}`, { method: 'DELETE' }); library.favorites = library.favorites.filter(item => item.key !== data.key);
    } else { const record = fieldsOf(data); await api('/api/favorites', { method: 'POST', body: record }); library.favorites.unshift(record); }
    updateFavoriteButton(data, element);
  } catch (error) { notify(error.message, true); }
  finally { element.disabled = false; }
}

function renderEpisodes(data) {
  const panel = $('#episodes'); if (!panel) return;
  panel.replaceChildren(node('h3', '播放线路与选集'));
  if (!data.lines.length) { panel.append(node('p', '这个来源暂时没有播放线路。', 'muted')); return; }
  const verified = data.verification?.lines || new Map();
  if (!verified.size) { panel.append(node('p', data.verification?.pending ? '正在验证当前剧集的可播放线路…' : '当前剧集暂无已验证可播放线路。', 'muted')); return; }
  if (!verified.has(data.selectedLine)) data.selectedLine = verified.keys().next().value;
  const tabs = node('div', undefined, 'line-tabs');
  data.lines.forEach((line, index) => {
    if (!verified.has(index)) return;
    const tab = button(line.name || `线路 ${index + 1}`, () => {
      const old = player;
      data.selectedLine = index; renderEpisodes(data);
      if (old?.detail === data) {
        const match = matchEpisode(line, old.episodeName, old.episode);
        if (match < 0) { void stopPlayer(); notify('这条线路没有对应剧集，请重新选集。'); }
        else void startEpisode(data, index, match, playPosition(old));
      }
    }, `button small${index === data.selectedLine ? ' selected' : ''}`);
    tab.setAttribute('aria-pressed', String(index === data.selectedLine)); tabs.append(tab);
  });
  panel.append(tabs);
  const episodes = node('div', undefined, 'episode-grid');
  const line = data.lines[data.selectedLine];
  line?.episodes.forEach((episode, index) => {
    const selected = player?.detail === data && player.line === data.selectedLine && player.episode === index;
    const item = button(episode.name || `第 ${index + 1} 集`, () => void startEpisode(data, data.selectedLine, index), `button${selected ? ' selected' : ''}`);
    item.title = episode.name; item.setAttribute('aria-pressed', String(selected)); episodes.append(item);
  });
  panel.append(episodes.childElementCount ? episodes : node('p', '这条线路没有剧集。', 'muted'));
}

function matchEpisode(line, name, index) {
  const named = line?.episodes.findIndex(episode => String(episode.name).trim() === String(name).trim()) ?? -1;
  return named >= 0 ? named : line?.episodes[index] ? index : -1;
}

function renderSources(data, candidates) {
  const row = $('#source-row'); if (!row) return;
  data.candidates = candidates;
  verifyOptions(data, candidates);
  row.replaceChildren(node('span', '切换影视源', 'meta'));
  const unique = [...data.verification.sources.values()];
  for (const candidate of unique) {
    const selected = candidate.source === data.source && String(candidate.id) === String(data.id);
    const item = button(sourceName(candidate.source), () => void switchSource(data, candidate), `button${selected ? ' selected' : ''}`);
    item.disabled = selected; item.setAttribute('aria-pressed', String(selected)); row.append(item);
  }
  if (data.verification.pending) row.append(node('span', '正在验证可播放来源…', 'muted'));
  else if (!unique.length) row.append(node('span', '暂无已验证可播放来源', 'muted'));
  if (unique.length <= 1) row.append(button('查找其他来源', () => goto('search', { q: data.title }), 'button subtle'));
}

async function switchSource(oldDetail, candidate, flow = { tried: new Set() }) {
  const old = player;
  const position = playPosition(old);
  const stamp = routeVersion;
  const request = ++playVersion;
  const reference = { source: oldDetail.source, line: old?.line ?? oldDetail.selectedLine, lineName: oldDetail.lines[old?.line ?? oldDetail.selectedLine]?.name, episode: old?.episode || 0, episodeName: old?.episodeName };
  void stopPlayer(false);
  $('#player-host')?.replaceChildren(node('div', '正在切换影视源…', 'loading'));
  try {
    const data = await fetchDetail(candidate, oldDetail, flow, stamp, request);
    if (!data || stamp !== routeVersion || request !== playVersion || detail !== oldDetail) return;
    const selected = selectionFor(data, reference);
    data.selectedLine = selected?.line || 0;
    detail = data; renderDetail(data, findCandidates(oldDetail));
    history.replaceState(null, '', `#detail?${new URLSearchParams({ source: data.source, id: data.id })}`);
    if (selected) void startEpisode(data, selected.line, selected.episode, position, flow);
    else { $('#player-host').replaceChildren(empty('请重新选集', '这个来源没有对应剧集，请手动选择播放线路和剧集。')); notify('这个来源没有对应剧集，请重新选集。'); }
  } catch (error) {
    if (stamp !== routeVersion || request !== playVersion) return;
    renderDetail(oldDetail, findCandidates(oldDetail)); $('#player-host').replaceChildren(empty('自动尝试已结束', `${error.message}。请手动切换影视源或重试选集。`));
  }
}

async function renderLive(params, stamp) {
  const page = section('电视直播', '选择频道，即刻播放');
  const controls = node('div', undefined, 'browse-controls'); controls.append(categoryTabs('live'));
  const refresh = button('刷新频道', () => void loadChannels(true), 'button small'); controls.append(refresh); page.append(controls);
  const feedback = node('div'); page.append(feedback);
  const layout = node('div', undefined, 'watch-layout live-layout');
  const watch = node('div');
  const host = node('div', undefined, 'player-host'); host.id = 'player-host';
  host.append(empty('选择一个频道', '支持在播放时手动切换频道线路。'));
  const lines = node('div', undefined, 'source-row'); lines.id = 'live-lines'; watch.append(host, lines);
  const panel = node('aside', undefined, 'episode-panel channel-panel'); panel.append(node('h3', '频道'));
  const categoryChoices = ['', '卫视', '央视', '地方', '体育', '少儿', '新闻·教育', '其他'];
  let liveCategory = categoryChoices.includes(params.get('category')) ? params.get('category') : '';
  const categories = node('div', undefined, 'live-category-tabs'); categories.setAttribute('aria-label', '直播频道分类');
  for (const category of categoryChoices) {
    const tab = button(category || '全部', () => {
      liveCategory = category; group.value = ''; updateCategories(); drawChannels();
      const query = new URLSearchParams(location.hash.split('?')[1] || ''); if (category) query.set('category', category); else query.delete('category');
      history.replaceState(null, '', `#live${query.size ? `?${query}` : ''}`);
    }, 'button small'); tab.dataset.category = category; categories.append(tab);
  }
  function updateCategories() { for (const tab of categories.children) { const selected = tab.dataset.category === liveCategory; tab.classList.toggle('selected', selected); tab.setAttribute('aria-pressed', String(selected)); } }
  updateCategories();
  const group = node('select'); group.setAttribute('aria-label', '频道分组');
  const list = node('div', undefined, 'channel-list'); list.setAttribute('aria-label', '可播放直播频道'); panel.append(categories, group, list); layout.append(watch, panel); page.append(layout); content.replaceChildren(page);
  let channels = [], loadingVersion = 0;
  let renderedCards = '', restoredChannel = false;
  const sourcesAtEntry = JSON.stringify(config.liveSources);
  const valid = request => stamp === routeVersion && location.hash.startsWith('#live') && request === loadingVersion && sourcesAtEntry === JSON.stringify(config.liveSources);
  function drawChannels() {
    const visible = channels.filter(item => item.streams.some(stream => stream.status === 'ok') && (!group.value || item.group === group.value) && (!liveCategory || item.category === liveCategory || liveCategory === '央视' && /^CCTV\s*\d/i.test(item.name)));
    const signature = JSON.stringify(visible.map(item => [item.id, item.name, item.group, item.logo, liveQualityLabel(item.streams[preferredLiveLine(item)])]));
    if (signature === renderedCards && list.childElementCount) return;
    renderedCards = signature;
    const focused = document.activeElement?.closest('.channel-card')?.dataset.channel;
    const scrollTop = list.scrollTop;
    const existing = new Map([...list.querySelectorAll('.channel-card')].map(item => [item.dataset.channel, item]));
    const ordered = [];
    for (const channel of visible) {
      const selectedChannel = player?.live && player.channel.id === channel.id;
      const appearance = JSON.stringify([channel.name, channel.group, channel.logo]);
      let item = existing.get(channel.id);
      if (!item || item.dataset.appearance !== appearance) {
      item = button('', () => { const latest = channels.find(value => value.id === channel.id); if (latest) void startLiveChannel(latest, preferredLiveLine(latest), stamp); }, 'channel-card channel-button'); item.dataset.channel = channel.id; item.dataset.appearance = appearance;
      const cover = node('span', undefined, 'channel-cover');
      const fallback = node('span', undefined, 'channel-fallback'); fallback.append(node('small', 'TV'), node('span', channel.name)); cover.append(fallback);
      const logo = httpUrl(channel.logo);
      if (logo) {
        const image = node('img'); image.src = logo; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        image.addEventListener('load', () => { fallback.hidden = true; }); image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }); cover.append(image);
      }
      cover.append(node('span', '可播放', 'channel-badge'));
      const caption = node('span', undefined, 'channel-caption'); caption.append(node('strong', channel.name), node('small', channel.group || '电视直播')); item.append(cover, caption);
      item.setAttribute('aria-label', `播放频道 ${channel.name}`);
      }
      const badge = $('.channel-badge', item); badge.textContent = liveQualityLabel(channel.streams[preferredLiveLine(channel)]) || '可播放'; badge.title = liveQualityDescription(channel.streams[preferredLiveLine(channel)]);
      item.classList.toggle('selected', Boolean(selectedChannel)); item.setAttribute('aria-pressed', String(Boolean(selectedChannel))); ordered.push(item);
    }
    ordered.forEach((item, index) => { if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null); });
    const retained = new Set(ordered); for (const item of [...list.children]) if (!retained.has(item)) item.remove();
    if (!list.childElementCount) list.append(node('p', liveCategory ? `“${liveCategory}”暂无已验证可播放频道，后台会继续探测。` : '没有可用频道。', 'muted'));
    list.scrollTop = scrollTop;
    if (focused) [...list.querySelectorAll('.channel-card')].find(item => item.dataset.channel === focused)?.focus({ preventScroll: true });
  }
  group.addEventListener('change', drawChannels);
  async function loadChannels(force = false) {
    const request = ++loadingVersion; refresh.disabled = force; feedback.replaceChildren(node('p', force ? '正在探测下一批可播放频道…' : '正在读取已验证频道…', 'muted'));
    try {
      const draw = result => {
      channels = (result.channels || []).filter(channel => channel.streams?.some(stream => stream.status === 'ok')); feedback.replaceChildren();
      const active = player?.live ? player : null, updated = active && channels.find(channel => channel.id === active.channel.id);
      if (updated) {
        active.staleLiveLines ||= new Set();
        active.channel.streams.forEach((stream, index) => {
          const same = updated.streams[index]?.url === stream.url;
          if (same) {
            stream.status = updated.streams[index].status; stream.quality = updated.streams[index].quality; stream.playbackUrl = updated.streams[index].playbackUrl; active.staleLiveLines.delete(index);
            const status = $(`#live-lines button[data-line="${index}"] .line-status`); if (status) { status.textContent = liveQualityLabel(stream) || '可用'; status.title = liveQualityDescription(stream); }
          }
          else active.staleLiveLines.add(index);
          if (!same || stream.status !== 'ok') $(`#live-lines button[data-line="${index}"]`)?.remove();
        });
        active.channel.preferredLine = updated.preferredLine;
      }
      const failures = failuresList(result.failedSources, '直播源');
      if (failures) { failures.open = result.failedSources.some(source => source.stale); feedback.append(failures); }
      const pending = Number.isFinite(result.checkedStreams) && Number.isFinite(result.totalStreams) && result.checkedStreams < result.totalStreams;
      if (result.probing || pending) feedback.append(node('p', `${channels.length ? `已显示 ${channels.length} 个可播放频道 · ` : ''}${result.probing ? '后台正在探测' : '等待下一批探测'}${Number.isFinite(result.totalStreams) ? ` · 已检查 ${result.checkedStreams || 0}/${result.totalStreams} 条线路` : ''}…`, 'resource-progress muted'));
      if (!channels.length && !result.probing && !pending) feedback.append(empty('暂无已验证可播放频道', '可继续刷新，探测下一批线路；也可以在资源设置中添加 M3U 直播源。', button('添加直播源', () => goto('settings'), 'button primary')));
      const names = new Set(channels.map(channel => channel.group).filter(Boolean));
      if (group.options.length !== names.size + 1 || [...group.options].slice(1).some(option => !names.has(option.value))) {
        const selected = group.value; group.replaceChildren(); const all = node('option', '全部频道'); all.value = ''; group.append(all);
        for (const name of names) { const option = node('option', name); option.value = name; group.append(option); }
        group.value = [...group.options].some(option => option.value === selected) ? selected : '';
      }
      drawChannels();
      if (!restoredChannel && !force && params.get('id')) {
        const channel = channels.find(item => item.id === params.get('id'));
        if (channel) { const savedLine = Number(params.get('line')); restoredChannel = true; void startLiveChannel(channel, params.has('line') && channel.streams[savedLine]?.status === 'ok' ? savedLine : preferredLiveLine(channel), stamp); }
      }
      content.setAttribute('aria-busy', 'false');
      };
      if (!force && liveSnapshot?.sources === sourcesAtEntry && Date.now() - liveSnapshot.at < 30000) draw(liveSnapshot.data);
      let result = await api(force ? '/api/live/probe' : '/api/live?verified=1', force ? { method: 'POST', body: {}, timeoutMs: 150000 } : {});
      let updates = 0;
      while (valid(request)) {
        liveSnapshot = { sources: sourcesAtEntry, at: Date.now(), data: result }; draw(result); refresh.disabled = false;
        const pending = Number.isFinite(result.checkedStreams) && Number.isFinite(result.totalStreams) && result.checkedStreams < result.totalStreams;
        let delay = 30000;
        if (result.backgroundMode !== 'low' && (result.probing || pending)) delay = ++updates <= 3 ? 1000 : 3000;
        else updates = 0;
        await new Promise(resolve => setTimeout(resolve, delay));
        if (!valid(request)) return;
        result = await api('/api/live?verified=1');
      }
    } catch (error) { if (stamp === routeVersion && request === loadingVersion) feedback.replaceChildren(empty('频道暂时不可用', error.message, button('重试', () => void loadChannels()))); }
    finally { if (stamp === routeVersion && request === loadingVersion) refresh.disabled = false; }
  }
  void loadChannels();
}

function liveQuality(stream) {
  const quality = stream?.quality;
  return stream?.status === 'ok' && ['manifest', 'bitstream'].includes(quality?.source) && Number.isInteger(quality.width) && Number.isInteger(quality.height) && quality.width > 0 && quality.height > 0 && quality.width <= 16384 && quality.height <= 16384 ? quality : null;
}

function liveQualityLabel(stream) {
  const quality = liveQuality(stream); return quality ? `${quality.source === 'manifest' ? '清单' : '码流'}${quality.height}p` : '';
}

function liveQualityDescription(stream) {
  const quality = liveQuality(stream); return quality ? `${quality.width} × ${quality.height}，${quality.source === 'manifest' ? '来自已验证播放清单' : '来自已验证视频码流'}。` : '线路已通过可用性检查，分辨率尚未核实。';
}

function hlsInitialLevel(levels, quality) {
  const matches = levels.map((level, index) => ({ level, index })).filter(({ level }) => level.width === quality.width && level.height === quality.height);
  if (quality.source === 'manifest') return matches[0]?.index ?? -1;
  const mediaSource = window.MediaSource || window.ManagedMediaSource;
  const compatible = matches.filter(({ level }) => {
    const declared = String(level.videoCodec || '').trim();
    const codecs = declared ? [declared] : String(level.attrs?.CODECS || '').split(',').map(codec => codec.trim());
    const avc = codecs.filter(codec => /^avc[13]\.[0-9a-f]{6}$/i.test(codec));
    return avc.length === 1 && mediaSource?.isTypeSupported?.(`video/mp4; codecs="${avc[0]}"`) === true;
  });
  return compatible.length === 1 ? compatible[0].index : -1;
}

function preferredLiveLine(channel, tried = new Set()) {
  const allowed = index => Number.isInteger(index) && channel.streams[index]?.status === 'ok' && !tried.has(index);
  if (allowed(channel.preferredLine)) return channel.preferredLine;
  const choices = channel.streams.map((stream, index) => ({ index, quality: liveQuality(stream) })).filter(value => allowed(value.index));
  choices.sort((first, second) => (second.quality?.width * second.quality?.height || 0) - (first.quality?.width * first.quality?.height || 0) || (second.quality?.bandwidth || 0) - (first.quality?.bandwidth || 0));
  return choices[0]?.index ?? -1;
}

function reportLive(current, status) {
  if (player !== current || current.transcoded || current.staleLiveLines?.has(current.line) || current.liveReported === status) return;
  current.liveReported = status;
  current.channel.streams[current.line].status = status;
  document.querySelectorAll('.channel-button').forEach(item => {
    if (item.dataset.channel !== current.channel.id) return;
    const stream = current.channel.streams[preferredLiveLine(current.channel, current.staleLiveLines || new Set())], badge = $('.channel-badge', item);
    if (badge) { badge.textContent = liveQualityLabel(stream) || '可播放'; badge.title = liveQualityDescription(stream); }
  });
  if (status === 'error') {
    $(`#live-lines button[data-line="${current.line}"]`)?.remove();
    if (!current.channel.streams.some(stream => stream.status === 'ok')) document.querySelectorAll('.channel-button').forEach(item => { if (item.dataset.channel === current.channel.id) item.remove(); });
  }
  void api('/api/live/report', { method: 'POST', body: { id: current.channel.id, line: current.line, status } }).catch(error => console.warn('直播线路结果未同步', error.message));
}

async function startLiveChannel(channel, line, stamp, flow = { tried: new Set() }) {
  if (stamp !== routeVersion) return;
  const selected = channel.streams[line]; if (!selected || selected.status !== 'ok') return notify('这个频道暂时没有已验证可播放线路。', true);
  const request = ++playVersion; void stopPlayer(false);
  const current = { live: true, catalog: false, channel, line, flow, request, stamp, started: false, position: 0, mode: 'direct', detail: { title: channel.name, source: 'live', id: channel.id }, url: selected.url, type: selected.type };
  flow.tried.add(line); player = current;
  const host = $('#player-host'); if (!host) return;
  host.replaceChildren(node('div', `正在连接 ${channel.name}…`, 'loading'));
  const choices = $('#live-lines'); choices.replaceChildren(node('span', '频道线路', 'meta'));
  channel.streams.forEach((stream, index) => {
    if (stream.status !== 'ok') return;
    const name = stream.name || `线路 ${index + 1}`;
    const item = button(name, () => void startLiveChannel(channel, index, stamp), `button${index === line ? ' selected' : ''}`);
    item.setAttribute('aria-label', name); item.dataset.line = index; const status = node('span', liveQualityLabel(stream) || '可用', 'line-status'); status.title = liveQualityDescription(stream); item.append(status);
    item.disabled = index === line; item.setAttribute('aria-pressed', String(index === line)); choices.append(item);
  });
  document.querySelectorAll('.channel-button').forEach(item => { const selectedChannel = item.dataset.channel === channel.id; item.setAttribute('aria-pressed', String(selectedChannel)); item.classList.toggle('selected', selectedChannel); });
  const query = new URLSearchParams(location.hash.split('?')[1] || ''); query.set('id', channel.id); query.set('line', line);
  history.replaceState(null, '', `#live?${query}`);
  try {
    const playback = await api(`/api/live/playback?${new URLSearchParams({ id: channel.id, line })}`);
    if (stamp !== routeVersion || request !== playVersion || player !== current) return;
    Object.assign(current, playback, { started: true }); mountPlayer(current);
  } catch (error) {
    if (stamp !== routeVersion || request !== playVersion || player !== current) return;
    current.note = node('p', error.message, 'player-note error-message'); host.replaceChildren(current.note);
    if (['hls', 'mp4'].includes(current.type)) host.append(button('兼容播放', () => void startCompatibility(current)));
    void recoverLive(current);
  }
}

async function recoverLive(current) {
  if (player !== current || current.recovering || current.failed || current.stamp !== routeVersion || current.request !== playVersion) return;
  current.recovering = true;
  if (current.proxyUrl && !current.usedProxy && current.video) {
    current.usedProxy = true; current.recovering = false;
    if (current.proxyButton) { current.proxyButton.textContent = '切回直连'; current.proxyButton.classList.add('selected'); }
    loadMedia(current, '直连失败，正在尝试兼容转发…'); return;
  }
  reportLive(current, 'error');
  const next = preferredLiveLine(current.channel, new Set([...current.flow.tried, ...(current.staleLiveLines || [])]));
  if (current.flow.tried.size < 3 && next >= 0) { await startLiveChannel(current.channel, next, current.stamp, current.flow); return; }
  if (!current.flow.transcodeTried && ['hls', 'mp4'].includes(current.type)) { current.recovering = false; await startCompatibility(current, 0, true); return; }
  current.failed = true; current.recovering = false;
  current.note.textContent = '当前频道暂时无法播放。请切换线路或选择其他频道。'; current.note.className = 'player-note error-message';
}

function formatTime(seconds) {
  const value = Math.floor(Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GiB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

function queueQuarkProgress(current, ended = false, keepalive = false, completed = false) {
  if (!current.quarkAsset || current.started === false) return Promise.resolve();
  const duration = playDuration(current);
  const body = { assetId: current.quarkAsset, position: ended && completed && duration > 0 ? duration : playPosition(current), duration, ended };
  const save = () => api('/api/quark/progress', { method: 'POST', body, keepalive });
  const saved = keepalive ? save() : quarkProgressQueue.catch(error => console.warn('等待网盘进度时失败', error.message)).then(save);
  if (!keepalive) quarkProgressQueue = saved;
  return saved.catch(error => { if (!current.quarkSaveFailed) { current.quarkSaveFailed = true; notify(`夸克观看状态未同步：${error.message}`, true); } });
}

async function playQuark(current, assetId) {
  if (player !== current || !current.catalog) return;
  const stamp = routeVersion, scope = adScope(current), position = playPosition(current);
  try {
    const [data, preferences] = await Promise.all([api('/api/quark/playback', { method: 'POST', body: { assetId }, timeoutMs: 35000 }), current.preferences ? Promise.resolve(current.preferences) : (current.detail.preferencesPromise ||= api(`/api/player/preferences?${new URLSearchParams({ key: current.detail.key })}`).catch(error => { console.warn('网盘播放偏好读取失败', error.message); return defaultPreferences; }))]);
    if (player !== current || stamp !== routeVersion || scope !== adScope(current)) return;
    const url = new URL(data.url, location.origin);
    if (url.origin !== location.origin || url.username || url.password || !url.pathname.startsWith('/api/') || !['hls', 'mp4', 'mkv', 'webm', 'avi', 'mpegts'].includes(data.type) || data.assetId !== assetId) throw new Error('网盘返回了无效的播放地址。');
    const request = ++playVersion; void stopPlayer(false);
    player = { detail: current.detail, line: current.line, episode: current.episode, episodeName: current.episodeName, position, started: true, catalog: true, flow: { tried: new Set() }, request, stamp, mode: 'direct', preferences: normalizePreferences(preferences), quarkAsset: assetId, quarkVersion: typeof data.version === 'string' ? data.version : JSON.stringify(data.quality ?? 'default'), requiresCompatibility: data.requiresCompatibility === true, quarkState: current.quarkState, quarkUrl: url.href, originalUrl: current.originalUrl || current.url, url: url.href, type: data.type, introHandled: current.introHandled };
    mountPlayer(player);
  } catch (error) { if (player === current && stamp === routeVersion) notify(`夸克播放未启动：${error.message}`, true); }
}

function mountQuark(current) {
  const host = $('#quark-resources'); if (!host || !current.catalog) return;
  const panel = node('section', undefined, 'quark-resources'); panel.append(node('h3', `夸克 · ${current.episodeName || current.detail.title}`));
  const feedback = node('p', '正在读取当前集的网盘设置…', 'muted'); feedback.setAttribute('aria-live', 'polite');
  const choices = node('div', undefined, 'quark-choices'), result = node('div', undefined, 'quark-ready'); panel.append(feedback, choices, result); host.replaceChildren(panel);
  const state = current.quarkState ||= { resources: [], files: [], version: 0 };
  const valid = () => player === current && current.stamp === routeVersion && host.contains(panel);
  function ready(data) {
    state.ready = data; result.replaceChildren(node('p', `${data.name || '当前集'}：${data.status === 'ready' ? '已准备好' : '正在准备'}${data.saved ? ' · 已转存' : ''}`, 'muted'));
    if (data.status === 'ready' && data.assetId) { const play = button(current.quarkAsset === data.assetId ? '正在夸克播放' : '夸克播放', () => void playQuark(current, data.assetId), 'button primary small'); play.disabled = current.quarkAsset === data.assetId; result.append(play); }
    if (data.reason) result.append(node('p', data.reason, 'muted'));
    if (data.status === 'pending' && state.selection) result.append(button('刷新准备状态', () => void prepare(state.selection.resource, state.selection.file), 'button small'));
  }
  async function prepare(resource, file, automatic = false) {
    if (!valid()) return;
    const version = ++state.version; transfer.disabled = true; feedback.textContent = '正在为当前单集准备夸克版本…';
    state.selection = { resource, file };
    try {
      const data = await api('/api/quark/prepare', { method: 'POST', body: { ...playbackSelection(current.detail, current.line, current.episode), shareId: resource.id, fileId: file.id, auto: automatic }, timeoutMs: 60000 });
      if (!valid() || version !== state.version) return;
      if (data.needsSelection) { feedback.textContent = data.reason || '无法唯一匹配当前集，请核对并选择一个视频文件。'; return; }
      ready(data); feedback.textContent = '普通线路继续播放，准备好后可手动切换。转存不会提高原视频画质。';
    } catch (error) { if (valid() && version === state.version) feedback.textContent = `夸克准备未完成：${error.message}`; }
    finally { if (valid() && version === state.version) transfer.disabled = !state.files.some(file => file.id === fileSelect.value); }
  }
  const shareSelect = node('select'); shareSelect.setAttribute('aria-label', '夸克分享资源');
  const fileSelect = node('select'); fileSelect.setAttribute('aria-label', '夸克视频文件');
  const shareField = node('label', undefined, 'quark-choice'); shareField.append(node('span', '分享资源'), shareSelect);
  const fileField = node('label', undefined, 'quark-choice'); fileField.append(node('span', '视频文件'), fileSelect);
  const transfer = button('转存所选单集', () => { const resource = state.resources.find(value => value.id === shareSelect.value), file = state.files.find(value => value.id === fileSelect.value); if (resource && file) void prepare(resource, file); }, 'button small'); transfer.disabled = true;
  const publicLink = externalLink('查看公开分享 ↗', '', 'button subtle small');
  const actions = node('div', undefined, 'quark-actions'); actions.append(transfer, publicLink);
  function filePlaceholder(message) {
    const option = node('option', message); option.value = ''; fileSelect.replaceChildren(option); fileSelect.disabled = true; fileSelect.title = message; state.files = []; transfer.disabled = true;
  }
  filePlaceholder('请先选择分享资源');
  async function loadFiles(automatic = false) {
    const resource = state.resources.find(value => value.id === shareSelect.value); if (!resource || !valid()) return;
    const version = ++state.version; filePlaceholder('正在读取视频文件…'); result.replaceChildren(); shareSelect.title = resource.name || resource.id; feedback.textContent = '正在核对当前集的视频文件…';
    const safe = httpUrl(resource.url); if (safe) { publicLink.href = safe; publicLink.removeAttribute('aria-disabled'); } else publicLink.removeAttribute('href');
    try {
      const data = await api(`/api/quark/files?${new URLSearchParams({ ...playbackSelection(current.detail, current.line, current.episode), shareId: resource.id })}`, { timeoutMs: 35000 });
      if (!valid() || version !== state.version) return;
      state.files = Array.isArray(data.files) ? data.files : [];
      if (!state.files.length) { filePlaceholder('此分享暂无匹配的视频文件'); feedback.textContent = data.reason || '此分享未找到当前集的视频文件，请选择其他分享资源。'; return; }
      const blank = node('option', '请选择当前集视频'); blank.value = '';
      fileSelect.replaceChildren(blank); fileSelect.disabled = false;
      for (const file of state.files) { const option = node('option', `${file.name} · ${fileSize(file.size)}${file.match ? ' · 匹配当前集' : ''}`); option.value = file.id; fileSelect.append(option); }
      const matching = state.files.filter(file => file.match === true);
      fileSelect.value = !data.ambiguous && matching.length === 1 ? matching[0].id : ''; transfer.disabled = !fileSelect.value; fileSelect.title = state.files.find(file => file.id === fileSelect.value)?.name || '请选择当前集视频';
      feedback.textContent = fileSelect.value ? '已核对当前集。准备后仍由你选择切换播放。' : '请核对文件名，只选择当前要看的单集；匹配不明确时不会自动转存。';
      if (automatic && state.resources.length === 1 && !data.ambiguous && matching.length === 1) void prepare(resource, matching[0], true);
    } catch (error) { if (valid() && version === state.version) { filePlaceholder('文件读取失败，请重试或切换分享'); feedback.textContent = `网盘文件暂时不可用：${error.message}`; result.replaceChildren(button('重试读取文件', () => void loadFiles(), 'button small')); } }
  }
  shareSelect.addEventListener('change', () => void loadFiles()); fileSelect.addEventListener('change', () => { const file = state.files.find(value => value.id === fileSelect.value); transfer.disabled = !file; fileSelect.title = file?.name || '请选择当前集视频'; });
  async function load() {
    try {
      const settings = await api('/api/quark/settings'); if (!valid()) return;
      if (!settings.configured || !settings.enabled) { feedback.textContent = '连接并启用夸克后，可为当前单集准备网盘版本。'; choices.replaceChildren(button('设置夸克账号', () => goto('settings'), 'button small')); return; }
      if (state.ready) { ready(state.ready); feedback.textContent = '当前集已准备，可手动切换；普通线路不会自动中断。'; return; }
      const data = await api(`/api/quark/resources?${new URLSearchParams(playbackSelection(current.detail, current.line, current.episode))}`, { timeoutMs: 35000 }); if (!valid()) return;
      state.resources = Array.isArray(data.resources) ? data.resources : []; shareSelect.replaceChildren();
      if (!state.resources.length) { feedback.textContent = data.reason || '当前集暂未找到可用夸克分享，普通播放不受影响。'; return; }
      for (const resource of state.resources) { const option = node('option', resource.name || resource.id); option.value = resource.id; shareSelect.append(option); }
      choices.replaceChildren(shareField, fileField, actions);
      void loadFiles(settings.autoSave === true);
    } catch (error) { if (valid()) { feedback.textContent = `夸克资源暂时不可用：${error.message}`; choices.replaceChildren(button('重试夸克资源', () => void load(), 'button small')); } }
  }
  void load();
}

async function startEpisode(data, line, episode, position = 0, flow = { tried: new Set() }) {
  let selected = data.lines[line]?.episodes[episode];
  if (!selected) return notify('当前剧集不可用，请重新选集。', true);
  const request = ++playVersion;
  const stamp = routeVersion;
  void stopPlayer(false);
  const host = $('#player-host'); host.replaceChildren(node('div', '正在准备播放…', 'loading'));
  flow.tried.add(data.source);
  const current = { detail: data, line, episode, episodeName: selected.name, url: selected.url, type: selected.type, position, mode: 'direct', catalog: true, flow, request, stamp, started: false };
  player = current;
  data.selectionReference = current;
  renderSources(data, data.candidates || []); renderEpisodes(data);
  try {
    const valid = () => stamp === routeVersion && request === playVersion && player === current;
    const choices = [{ line, episode }, ...data.lines.map((candidate, index) => ({ line: index, episode: matchEpisode(candidate, selected.name, episode) })).filter(candidate => candidate.line !== line && candidate.episode >= 0)];
    let verified = false, failure;
    for (const choice of choices) {
      const result = await checkSelection(data, choice.line, choice.episode, valid);
      if (!valid()) return;
      if (!result.playable) { failure = result.error; continue; }
      ({ line, episode } = choice); selected = data.lines[line].episodes[episode];
      Object.assign(current, { line, episode, episodeName: selected.name, url: selected.url, type: selected.type });
      verified = true; break;
    }
    if (!verified) throw new Error(failure || '当前剧集暂无已验证可播放线路');
    const [playback, preferences] = await Promise.all([
      api(`/api/playback?${new URLSearchParams({ source: data.source, id: data.id, line, episode })}`),
      (data.preferencesPromise ||= api(`/api/player/preferences?${new URLSearchParams({ key: data.key })}`).catch(error => { console.warn('播放偏好读取失败', error.message); return defaultPreferences; })),
    ]);
    if (stamp !== routeVersion || request !== playVersion || player !== current) return;
    data.selectedLine = line;
    Object.assign(current, playback, { url: playback.url || selected.url, type: playback.type || selected.type, started: true, preferences: normalizePreferences(preferences) });
    mountPlayer(current); renderSources(data, data.candidates || []); renderEpisodes(data);
  } catch (error) {
    if (stamp !== routeVersion || request !== playVersion || player !== current) return;
    const note = node('p', error.message, 'player-note error-message'); current.note = note;
    host.replaceChildren(note);
    if (['hls', 'mp4'].includes(current.type)) host.append(button('兼容播放', () => void startCompatibility(current)));
    mountQuark(current);
    void recoverPlayback(current);
  }
}

function normalizePreferences(value = {}) {
  const adRanges = (Array.isArray(value.adRanges) ? value.adRanges : []).filter(range => range && typeof range.scope === 'string' && range.scope.length <= 4096 && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end <= 86400 && range.end > range.start && range.end - range.start <= 600).slice(0, 20).map(range => ({ scope: range.scope, start: range.start, end: range.end }));
  return { introSeconds: Math.max(0, Math.min(600, Number(value.introSeconds) || 0)), outroSeconds: Math.max(0, Math.min(600, Number(value.outroSeconds) || 0)), autoNext: value.autoNext !== false, speed: Number.isFinite(value.speed) && value.speed >= 0.5 && value.speed <= 3 ? value.speed : 1, danmakuEnabled: value.danmakuEnabled !== false, skipAds: value.skipAds === true, adRanges };
}

function adScope(current) { return current.quarkAsset ? JSON.stringify(['quark', current.quarkAsset, current.quarkVersion, current.episodeName]) : JSON.stringify([current.detail.source, String(current.detail.id), current.detail.lines[current.line]?.name || '', current.episodeName]); }

async function loadAdMarkers(current) {
  if (player !== current || !current.catalog || current.quarkAsset || !current.preferences.skipAds || (current.originalType || current.type) !== 'hls' || current.adMetadataLoaded || current.adMetadataLoading) return;
  const version = current.adVersion = (current.adVersion || 0) + 1, scope = adScope(current);
  current.adMetadataLoading = true;
  try {
    const data = await api(`/api/ads?${new URLSearchParams(playbackSelection(current.detail, current.line, current.episode))}`);
    if (player !== current || version !== current.adVersion || !current.preferences.skipAds || adScope(current) !== scope) return;
    current.adMetadataLoaded = true;
    current.markedAdRanges = (data.supported && Array.isArray(data.ranges) ? data.ranges : []).filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start && range.end <= 86400 && range.end - range.start <= 600);
    current.adFeedback.textContent = current.markedAdRanges.length ? `已识别 ${current.markedAdRanges.length} 段清单中明确标记的广告。` : data.reason || '当前清单没有可可靠定位的广告标记，可手动标记时段。';
  } catch (error) { if (player === current && version === current.adVersion) current.adFeedback.textContent = `广告标记暂时不可用，继续正常播放：${error.message}`; }
  finally { if (version === current.adVersion) current.adMetadataLoading = false; }
}

function skipMarkedAd(current) {
  if (!current.catalog || !current.preferences.skipAds || current.video.paused || current.video.seeking || current.transcodeLoading || current.transcodePromise || current.adSkipping) return false;
  const position = playPosition(current), duration = playDuration(current);
  const ranges = [...current.preferences.adRanges.filter(range => range.scope === adScope(current)), ...(current.markedAdRanges || [])];
  const range = ranges.find(range => position >= range.start && position < range.end - 0.1);
  if (!range || !duration && !current.transcoded) return false;
  const end = duration ? Math.min(range.end, Math.max(0, duration - (current.transcoded ? 1 : 0.1))) : range.end;
  if (end <= position + 0.1) return false;
  current.adSkipping = true;
  current.adFeedback.textContent = `已跳过广告时段 ${formatTime(range.start)}–${formatTime(range.end)}。`;
  seekVideo(current, end - position);
  if (!current.transcoded) current.adSkipping = false;
  else void current.transcodePromise?.then(() => { current.adSkipping = false; }, error => { current.adSkipping = false; console.warn('广告时段跳转失败', error.message); });
  return true;
}

function playerAds(current, host) {
  const panel = node('details', undefined, 'player-ads'); panel.append(node('summary', '本集广告时段'));
  panel.append(node('p', '标记当前版本的广告时段后自动跳过；其他来源、线路和剧集不会共用这些时段。画面内的台标或文字无法靠播放器单独无损移除。', 'muted'));
  const prefs = current.preferences, label = node('label', '自动跳过已标记广告', 'player-option');
  const toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = prefs.skipAds; toggle.setAttribute('aria-label', '自动跳过已标记广告'); label.prepend(toggle); panel.append(label); current.adToggle = toggle;
  const form = node('div', undefined, 'ad-range-form');
  const inputs = {};
  for (const [key, title] of [['start', '广告开始（原片秒）'], ['end', '广告结束（原片秒）']]) {
    const field = node('label', title); const input = node('input'); input.type = 'number'; input.min = '0'; input.max = '86400'; input.step = '0.1'; input.setAttribute('aria-label', title); field.append(input); form.append(field); inputs[key] = input;
    form.append(button(key === 'start' ? '标记开始' : '标记结束', () => { input.value = String(Math.round(playPosition(current) * 10) / 10); }, 'button small'));
  }
  const list = node('div', undefined, 'ad-range-list'), feedback = node('p', undefined, 'muted'); feedback.setAttribute('aria-live', 'polite'); current.adFeedback = feedback;
  function draw() {
    list.replaceChildren();
    for (const [index, range] of prefs.adRanges.entries()) {
      if (range.scope !== adScope(current)) continue;
      const row = node('div', undefined, 'ad-range-row'); row.append(node('span', `${formatTime(range.start)}–${formatTime(range.end)}`));
      const remove = button('删除', async () => { await persist({ ...prefs, adRanges: prefs.adRanges.filter((_value, position) => position !== index) }); }, 'button subtle small'); remove.setAttribute('aria-label', `删除广告时段 ${formatTime(range.start)}–${formatTime(range.end)}`); row.append(remove); list.append(row);
    }
    if (!list.childElementCount) list.append(node('p', '本集当前线路尚未保存广告时段。', 'muted'));
  }
  async function persist(next) {
    if (player !== current) return;
    const version = current.adSaveVersion = (current.adSaveVersion || 0) + 1;
    save.disabled = true;
    try {
      const data = await api('/api/player/preferences', { method: 'PUT', body: { key: current.detail.key, ...next } });
      if (player !== current || version !== current.adSaveVersion) return;
      Object.assign(prefs, normalizePreferences(data)); current.detail.preferencesPromise = Promise.resolve({ ...prefs }); toggle.checked = prefs.skipAds; draw(); void loadAdMarkers(current); notify('本影片广告设置已保存');
    } catch (error) { if (player === current && version === current.adSaveVersion) notify(`广告设置未保存：${error.message}`, true); }
    finally { if (player === current && version === current.adSaveVersion) save.disabled = false; }
  }
  const save = button('保存时段并跳过', async () => {
    if (player !== current) return;
    if (Object.values(inputs).some(input => input.value === '' || !input.reportValidity())) return notify('请先填写或标记广告开始和结束时间。', true);
    const start = Number(inputs.start.value), end = Number(inputs.end.value);
    if (end <= start || end - start > 600) return notify('结束时间必须晚于开始时间，每段广告最多 600 秒。', true);
    if (prefs.adRanges.length >= 20) return notify('本影片最多保存 20 个广告时段，请先删除已有时段。', true);
    await persist({ ...prefs, skipAds: true, adRanges: [...prefs.adRanges, { scope: adScope(current), start, end }] });
  }, 'button small'); form.append(save);
  toggle.addEventListener('change', () => {
    prefs.skipAds = toggle.checked;
    if (!toggle.checked) { current.adVersion = (current.adVersion || 0) + 1; current.adMetadataLoaded = false; current.adMetadataLoading = false; current.markedAdRanges = []; }
    else void loadAdMarkers(current);
    void persist({ ...prefs });
  });
  draw(); panel.append(form, list, feedback); host.insertBefore(panel, current.note); void loadAdMarkers(current);
}

function seekVideo(current, seconds) {
  if (player !== current || !current.video || current.live) return;
  const duration = playDuration(current);
  const position = Math.max(0, playPosition(current) + seconds);
  if (current.transcoded) { void startCompatibility(current, duration ? Math.min(duration - 1, position) : position); return; }
  if (!duration) return;
  current.video.currentTime = Math.min(duration, position);
}

function playerPreferences(current, host) {
  const prefs = current.preferences;
  const panel = node('div', undefined, 'player-preferences');
  const numbers = {};
  for (const [key, title] of [['introSeconds', '跳过片头（秒）'], ['outroSeconds', '跳过片尾（秒）']]) {
    const label = node('label', title); const input = node('input'); input.type = 'number'; input.min = '0'; input.max = '600'; input.step = '1'; input.value = prefs[key]; input.setAttribute('aria-label', title); label.append(input); panel.append(label); numbers[key] = input;
    input.addEventListener('input', () => { if (input.validity.valid && input.value !== '') prefs[key] = Number(input.value); });
  }
  for (const [key, title] of [['autoNext', '自动下一集'], ['danmakuEnabled', '显示弹幕']]) {
    const label = node('label', title, 'player-option'); const input = node('input'); input.type = 'checkbox'; input.checked = prefs[key]; input.setAttribute('aria-label', title); label.prepend(input); panel.append(label);
    input.addEventListener('change', () => {
      prefs[key] = input.checked;
      if (key === 'danmakuEnabled') {
        if (!input.checked) { clearDanmaku(current); clearInterval(current.danmakuTimer); current.danmakuTimer = null; }
        else { void loadDanmaku(current); startDanmakuSync(current); }
        if (current.danmakuForm) current.danmakuForm.hidden = !input.checked;
      }
    });
  }
  const save = button('保存播放偏好', async () => {
    if (player !== current) return;
    for (const input of Object.values(numbers)) if (!input.reportValidity() || input.value === '') return;
    save.disabled = true;
    try {
      const result = await api('/api/player/preferences', { method: 'PUT', body: { key: current.detail.key, ...prefs } });
      if (player !== current) return;
      Object.assign(prefs, normalizePreferences(result)); current.detail.preferencesPromise = Promise.resolve({ ...prefs }); notify('本影片播放偏好已保存');
    } catch (error) { if (player === current) notify(`偏好未保存：${error.message}`, true); }
    finally { if (player === current) save.disabled = false; }
  }, 'button small');
  panel.append(save, node('small', '片头片尾默认不跳过；片尾跳过仅在自动下一集开启时生效。', 'muted')); host.insertBefore(panel, current.note);
}

function clearDanmaku(current) {
  for (const text of current.danmaku?.active.keys() || []) clearTimeout(text.cleanupTimer);
  current.overlay?.replaceChildren(); current.danmaku?.active.clear();
}

function resetDanmaku(current) {
  if (!current.danmaku) return;
  clearDanmaku(current); current.danmaku.shown.clear();
  const index = current.danmaku.comments.findIndex(comment => comment.time >= playPosition(current) - 0.25);
  current.danmaku.cursor = index < 0 ? current.danmaku.comments.length : index;
}

function drawDanmaku(current) {
  if (player !== current || !current.preferences?.danmakuEnabled || current.video.paused || !current.danmaku) return;
  const state = current.danmaku, time = playPosition(current);
  while (state.cursor < state.comments.length && state.comments[state.cursor].time <= time) {
    const comment = state.comments[state.cursor++];
    if (comment.time < time - 1 || state.shown.has(comment.id) || state.active.size >= 12) continue;
    const lanes = Math.max(1, Math.min(12, Math.floor((current.overlay.clientHeight - 48) / 24)));
    const lane = Array.from({ length: lanes }, (_value, index) => index).find(index => ![...state.active.values()].includes(index));
    if (lane === undefined) continue;
    const text = node('span', comment.text, 'danmaku-comment'); text.style.top = `${8 + lane * 24}px`;
    if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(comment.color || '')) text.style.color = comment.color;
    current.overlay.append(text); text.style.setProperty('--distance', `${-(current.overlay.clientWidth + text.scrollWidth + 20)}px`);
    state.active.set(text, lane); state.shown.add(comment.id);
    const remove = () => { clearTimeout(text.cleanupTimer); state.active.delete(text); text.remove(); };
    text.cleanupTimer = setTimeout(remove, 8500); text.addEventListener('animationend', remove, { once: true });
  }
}

function startDanmakuSync(current) {
  if (current.danmakuTimer || player !== current || current.video.paused || !current.preferences?.danmakuEnabled) return;
  current.danmakuTimer = setInterval(() => { if (player === current && !current.video.paused) void loadDanmaku(current); }, 20000);
}

async function loadDanmaku(current) {
  if (player !== current || !current.preferences?.danmakuEnabled || !current.danmaku) return;
  if (current.danmaku.loading) return current.danmaku.loading;
  current.danmaku.loading = (async () => {
    try {
      const result = await api(`/api/danmaku?${new URLSearchParams({ key: current.detail.key, episode: current.episodeName })}`);
      if (player !== current || !current.preferences.danmakuEnabled) return;
      current.danmaku.comments = (result.comments || []).filter(comment => typeof comment.text === 'string' && Number.isFinite(comment.time) && comment.time >= 0).map(comment => ({ ...comment, id: String(comment.id), text: comment.text.slice(0, 200) })).sort((first, second) => first.time - second.time);
      const index = current.danmaku.comments.findIndex(comment => comment.time >= playPosition(current) - 1);
      current.danmaku.cursor = index < 0 ? current.danmaku.comments.length : index;
      current.danmakuStatus.textContent = (result.errors || []).map(error => typeof error === 'string' ? error : error.error || error.message || '弹幕来源暂不可用').join('；'); drawDanmaku(current);
    } catch (error) { if (player === current) current.danmakuStatus.textContent = `弹幕暂时不可用：${error.message}`; }
    finally { current.danmaku.loading = null; }
  })();
  return current.danmaku.loading;
}

function mountDanmaku(current, surface, host) {
  current.overlay = node('div', undefined, 'danmaku-overlay'); current.overlay.setAttribute('aria-hidden', 'true'); surface.append(current.overlay);
  current.danmaku = { comments: [], cursor: 0, active: new Map(), shown: new Set(), loading: null };
  const form = node('form', undefined, 'danmaku-form'); current.danmakuForm = form; form.hidden = !current.preferences.danmakuEnabled;
  const input = node('input'); input.maxLength = 200; input.placeholder = '发一句家庭弹幕'; input.setAttribute('aria-label', '家庭弹幕'); input.autocomplete = 'off';
  const send = node('button', '发送弹幕', 'button small'); send.type = 'submit'; form.append(input, send);
  current.danmakuStatus = node('small', undefined, 'danmaku-status muted'); host.insertBefore(form, current.note); host.insertBefore(current.danmakuStatus, current.note);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const text = input.value.trim(); if (!text || player !== current || !current.preferences.danmakuEnabled) return;
    send.disabled = true;
    try {
      await api('/api/danmaku', { method: 'POST', body: { key: current.detail.key, episode: current.episodeName, time: playPosition(current), text } });
      if (player !== current) return;
      input.value = ''; await loadDanmaku(current);
    } catch (error) { if (player === current) current.danmakuStatus.textContent = `弹幕未发送：${error.message}`; }
    finally { if (player === current) send.disabled = false; }
  });
  current.video.addEventListener('seeking', () => resetDanmaku(current));
  mountDanmakuBinding(current, host);
  void loadDanmaku(current);
}

function mountDanmakuBinding(current, host) {
  const panel = node('details', undefined, 'danmaku-binding'); panel.append(node('summary', '绑定本集外部弹幕'));
  panel.append(node('p', '请选择对应同一影片、同一集的版本；使用官方 B 站 XML 或明确分 P 的视频链接。家庭弹幕只保存在此播放器服务中。', 'muted'));
  const form = node('form', undefined, 'binding-form');
  const url = node('input'); url.type = 'url'; url.placeholder = 'https://comment.bilibili.com/123.xml 或 B 站视频链接'; url.setAttribute('aria-label', '外部弹幕链接'); url.autocomplete = 'off';
  const label = node('label', '偏移（秒）'); const offset = node('input'); offset.type = 'number'; offset.min = '-600'; offset.max = '600'; offset.step = '0.1'; offset.value = '0'; offset.setAttribute('aria-label', '弹幕时间偏移（秒）'); label.append(offset);
  const save = node('button', '保存本集弹幕绑定', 'button small'); save.type = 'submit';
  const clear = button('清除本集弹幕绑定', () => void writeBinding(true), 'button subtle small');
  const status = node('p', undefined, 'binding-status muted'); form.append(url, label, save, clear); panel.append(form, status); host.insertBefore(panel, current.note);
  let edited = false; url.addEventListener('input', () => { edited = true; }); offset.addEventListener('input', () => { edited = true; });
  void api(`/api/danmaku/binding?${new URLSearchParams({ key: current.detail.key, episode: current.episodeName })}`).then(value => {
    if (player !== current || edited) return;
    url.value = value.url || ''; offset.value = Number.isFinite(value.offset) ? String(value.offset) : '0';
  }).catch(error => { if (player === current) status.textContent = `绑定读取失败：${error.message}`; });
  async function writeBinding(remove = false) {
    if (player !== current || !remove && (!form.reportValidity() || offset.value === '')) return;
    const value = remove ? '' : url.value.trim();
    if (value && !httpUrl(value)) { status.textContent = '请输入有效的官方 B 站链接。'; return; }
    save.disabled = true; clear.disabled = true; edited = true;
    try {
      const result = await api('/api/danmaku/binding', { method: 'PUT', body: { key: current.detail.key, episode: current.episodeName, url: value, offset: remove ? 0 : Number(offset.value) } });
      if (player !== current) return;
      url.value = result.url ?? value; offset.value = String(result.offset ?? (remove ? 0 : Number(offset.value)));
      status.textContent = remove ? '本集外部弹幕已清除。' : '本集外部弹幕绑定已保存。';
      await current.danmaku.loading;
      if (player !== current) return;
      resetDanmaku(current); await loadDanmaku(current);
    } catch (error) { if (player === current) status.textContent = `绑定未保存：${error.message}`; }
    finally { if (player === current) { save.disabled = false; clear.disabled = false; } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void writeBinding(); });
}

function parserUrl(parser, original) {
  return httpUrl(parser ? (parser.url.includes('{url}') ? parser.url.replaceAll('{url}', encodeURIComponent(original)) : parser.url + encodeURIComponent(original)) : original);
}

function mountPlayer(current) {
  const host = $('#player-host'); if (!host) return;
  host.replaceChildren();
  const surface = node('div', undefined, 'player-surface');
  const toolbar = node('div', undefined, 'player-toolbar');
  const note = node('p', undefined, 'player-note'); current.note = note;
  host.append(surface, toolbar, note);
  current.preferences ||= { ...defaultPreferences };
  if (current.type === 'page') {
    current.mode = 'parser';
    const frame = node('iframe'); frame.title = '第三方视频解析播放器'; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation'); frame.allow = 'fullscreen; autoplay; encrypted-media; picture-in-picture'; frame.referrerPolicy = 'no-referrer'; frame.allowFullscreen = true; current.frame = frame;
    const select = node('select'); select.setAttribute('aria-label', '解析线路');
    const original = node('option', '原始视频页'); original.value = ''; select.append(original);
    const parsers = config.parsers.filter(item => item.enabled !== false);
    for (const parser of parsers) { const option = node('option', parser.name); option.value = parser.id; select.append(option); }
    select.value = parsers.some(item => item.id === current.parser) ? current.parser : parsers[0]?.id || '';
    const open = externalLink('外部打开 ↗', current.url);
    const update = () => {
      const parser = parsers.find(item => item.id === select.value); const url = parserUrl(parser, current.url);
      if (!url) return notify('解析线路地址无效，请检查资源设置。', true);
      current.parser = parser?.id || ''; frame.src = url; open.href = url; void saveHistory(current);
    };
    select.addEventListener('change', update); toolbar.append(select, open); surface.append(frame);
    note.textContent = '第三方网页可能拒绝嵌入；黑屏或无法播放时请切换解析线路或外部打开。这里只保存链接历史，无法同步网页内进度。';
    update(); return;
  }
  const video = node('video'); video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.setAttribute('aria-label', `${current.detail.title} ${current.episodeName || ''}`); current.video = video; surface.append(video);
  const backward = button('−10 秒', () => seekVideo(current, -10)); backward.setAttribute('aria-label', '快退 10 秒'); backward.disabled = Boolean(current.live);
  const forward = button('+10 秒', () => seekVideo(current, 10)); forward.setAttribute('aria-label', '快进 10 秒'); forward.disabled = Boolean(current.live);
  const speed = node('select'); speed.setAttribute('aria-label', '播放速度');
  const rates = [...new Set([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, current.preferences.speed])].sort((first, second) => first - second);
  for (const rate of rates) { const option = node('option', `${rate}×`); option.value = rate; speed.append(option); }
  speed.value = String(current.preferences.speed); video.playbackRate = current.preferences.speed;
  speed.disabled = Boolean(current.live);
  speed.addEventListener('change', () => {
    const position = playPosition(current); current.preferences.speed = Number(speed.value); video.playbackRate = current.preferences.speed;
    if (current.transcoded) void startCompatibility(current, position);
  });
  const full = button('全屏', async () => {
    try { if (video.requestFullscreen) await video.requestFullscreen(); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else notify('当前浏览器不支持全屏。'); }
    catch (error) { notify(error.message, true); }
  });
  toolbar.append(backward, forward, speed, full);
  if (current.catalog || current.live) {
    current.compatibilityButton = button(current.transcoded ? '重新兼容播放' : '兼容播放', () => void startCompatibility(current));
    current.compatibilityButton.title = '原始线路无法解码或有画面无声音时，通过服务器转换为兼容格式'; toolbar.append(current.compatibilityButton);
  }
  if (current.quarkAsset) toolbar.append(button('重试夸克播放', () => void playQuark(current, current.quarkAsset)), button('返回原线路', () => void startEpisode(current.detail, current.line, current.episode, playPosition(current))));
  if (current.catalog) {
    const next = button('下一集 →', () => void nextEpisode(current)); next.disabled = !current.detail.lines[current.line]?.episodes[current.episode + 1]; toolbar.append(next);
    playerPreferences(current, host); playerAds(current, host); mountDanmaku(current, surface, host);
  }
  if (current.proxyUrl) {
    const proxy = button('兼容转发', () => {
      if (current.transcoded) return;
      current.request = ++playVersion; current.flow = { tried: new Set([current.live ? current.line : current.detail.source]) }; current.failed = false; current.recovering = false;
      current.position = current.live ? 0 : playPosition(current); current.usedProxy = !current.usedProxy;
      proxy.textContent = current.usedProxy ? '切回直连' : '兼容转发'; proxy.classList.toggle('selected', current.usedProxy); loadMedia(current);
    }); proxy.title = '跨域或直连失败时，尝试服务器受限转发'; current.proxyButton = proxy; toolbar.append(proxy);
  }
  toolbar.append(externalLink('原链接 ↗', current.quarkAsset ? current.quarkUrl : current.originalUrl || current.url));
  const clock = node('div', undefined, 'player-clock');
  const clockText = node('span'); const timeline = node('input'); timeline.type = 'range'; timeline.min = '0'; timeline.step = '1'; timeline.setAttribute('aria-label', '原片进度');
  clock.append(clockText, timeline); host.insertBefore(clock, current.note);
  const updateClock = () => {
    const duration = playDuration(current), position = playPosition(current);
    clockText.textContent = `${current.transcoded ? `${compatibilityLabel(current)} · ` : ''}${formatTime(position)}${duration ? ` / ${formatTime(duration)}` : current.transcoded ? ' / 总时长未知' : ''}`;
    timeline.hidden = !current.transcoded || current.live || !duration; timeline.disabled = Boolean(current.transcodeLoading);
    timeline.max = String(Math.max(0, duration - 1)); if (document.activeElement !== timeline) timeline.value = String(position);
  };
  timeline.addEventListener('change', () => { if (player === current && current.transcoded) void startCompatibility(current, Number(timeline.value)); });
  current.updateClock = updateClock;
  video.addEventListener('loadedmetadata', () => {
    if (player !== current) return;
    video.playbackRate = current.preferences.speed;
    if (current.transcoded) { updateClock(); return; }
    if (current.position > 0) {
      try { video.currentTime = Number.isFinite(video.duration) ? Math.min(current.position, Math.max(0, video.duration - 1)) : current.position; }
      catch { notify('当前线路无法跳转到保存的时间，请手动选择进度。'); }
      current.position = 0;
      current.introHandled = true;
    } else if (current.catalog && !current.introHandled && Number.isFinite(video.duration)) {
      current.introHandled = true;
      if (current.preferences.introSeconds > 0) video.currentTime = Math.min(current.preferences.introSeconds, Math.max(0, video.duration - 1));
    }
  });
  video.addEventListener('pause', () => { if (player === current) { if (current.transcoded && !current.transcodeLoading) current.pausedAt = Date.now(); void saveHistory(current); clearInterval(current.danmakuTimer); current.danmakuTimer = null; current.overlay?.classList.add('paused'); } });
  video.addEventListener('play', () => {
    if (player !== current || !current.transcoded || current.transcodeLoading) return;
    if (current.pausedAt && Date.now() - current.pausedAt >= 120000 && !current.expiryRecovered) {
      current.expiryRecovered = true; void startCompatibility(current, playPosition(current));
    }
    current.pausedAt = 0;
  });
  video.addEventListener('ended', () => { if (player === current) { void saveHistory(current, true); if (current.catalog && current.preferences.autoNext && !current.nextPending) { current.nextPending = true; void nextEpisode(current); } } });
  video.addEventListener('loadeddata', () => { if (player === current) { clearTimeout(current.loadTimer); if (current.transcoded) current.transcodeReady = true; if (current.live) reportLive(current, 'ok'); else if (current.catalog) reportPlayback(current, 'ok'); updateClock(); resetDanmaku(current); } });
  video.addEventListener('playing', () => { if (player === current) { clearTimeout(current.loadTimer); note.textContent = `${current.quarkAsset ? '夸克播放 · ' : ''}${current.transcoded ? `${compatibilityLabel(current)} · ` : ''}${current.live ? `正在直播 · ${current.detail.title}` : `${current.episodeName || current.detail.title} · 进度每 10 秒自动保存`}`; note.className = 'player-note'; current.overlay?.classList.remove('paused'); if (current.catalog) { startDanmakuSync(current); drawDanmaku(current); } } });
  video.addEventListener('timeupdate', () => {
    if (player !== current) return;
    updateClock();
    if (!current.catalog) return;
    if (skipMarkedAd(current)) return;
    drawDanmaku(current);
    const outro = current.preferences.outroSeconds;
    const duration = playDuration(current);
    if (!video.paused && current.preferences.autoNext && outro > 0 && duration > 0 && playPosition(current) >= duration - outro && !current.nextPending && current.detail.lines[current.line]?.episodes[current.episode + 1]) {
      current.nextPending = true; if (current.quarkAsset) void saveHistory(current, true, true); void nextEpisode(current);
    }
  });
  video.addEventListener('waiting', () => { if (player === current) note.textContent = '正在缓冲…'; });
  video.addEventListener('error', () => { if (player === current && video.error) playbackError(current); });
  if (!current.live) current.timer = setInterval(() => {
    if (player !== current || video.paused) return;
    void saveHistory(current);
    if (current.detail.category === 'adult') {
      void api('/api/config').then(next => { if (player === current) applyConfig(next); }).catch(error => notify(`显示设置未同步：${error.message}`, true));
    }
  }, 10000);
  if (current.requiresCompatibility && !current.transcoded) void startCompatibility(current, current.position); else loadMedia(current);
  updateClock(); void saveHistory(current); if (current.catalog) mountQuark(current);
}

function playbackError(current) {
  if (player !== current || current.failed) return;
  clearTimeout(current.loadTimer);
  if (current.transcodeLoading) return;
  if (current.transcoded) {
    current.position = playPosition(current); current.failed = true;
    current.note.textContent = '兼容播放中断，请点击“重新兼容播放”重试。'; current.note.className = 'player-note error-message';
    void stopTranscode(current.transcodeId); current.transcodeId = null; return;
  }
  if (current.quarkAsset) {
    if ([3, 4].includes(current.video?.error?.code) && !current.requiresCompatibility && !current.flow.transcodeTried) { void startCompatibility(current, playPosition(current), true); return; }
    current.failed = true; current.note.textContent = '夸克播放中断。可重试夸克播放，或返回原线路；原影视源不会因此停用。'; current.note.className = 'player-note error-message'; return;
  }
  if (current.catalog) void recoverPlayback(current);
  else if (current.live) void recoverLive(current);
  else { current.note.textContent = '当前地址无法播放，请更换链接或打开原链接。'; current.note.className = 'player-note error-message'; }
}

async function recoverPlayback(current) {
  if (player !== current || current.recovering || current.failed || current.stamp !== routeVersion || current.request !== playVersion) return;
  current.recovering = true;
  current.position = playPosition(current);
  if (current.proxyUrl && !current.usedProxy) {
    current.usedProxy = true; current.recovering = false;
    if (current.proxyButton) { current.proxyButton.textContent = '切回直连'; current.proxyButton.classList.add('selected'); }
    loadMedia(current, '直连失败，正在尝试兼容转发…'); return;
  }
  if (current.started) reportPlayback(current, 'error');
  current.note.textContent = '当前地址无法播放，正在查找其他影视源…';
  const request = current.request;
  const candidates = await loadCandidates(current.detail, current.stamp);
  if (player !== current || request !== playVersion || current.stamp !== routeVersion) return;
  const candidate = current.flow.tried.size < 3 ? candidates.find(item => !current.flow.tried.has(item.source)) : null;
  if (candidate) { await switchSource(current.detail, candidate, current.flow); return; }
  if (!current.flow.transcodeTried && ['hls', 'mp4'].includes(current.type)) { current.recovering = false; await startCompatibility(current, current.position, true); return; }
  current.failed = true; current.recovering = false;
  current.note.textContent = '自动尝试已结束。请手动切换影视源、线路或剧集，也可以打开原链接。'; current.note.className = 'player-note error-message';
}

function attemptPlay(current, generation) {
  void current.video.play().catch(error => {
    if (player !== current || generation !== current.mediaVersion) return;
    if (error.name === 'NotAllowedError') { clearTimeout(current.loadTimer); current.note.textContent = '视频已准备好，浏览器需要你点击播放器的播放按钮开始。'; }
    else if (error.name !== 'AbortError') playbackError(current);
  });
}

async function loadMedia(current, message = '正在连接播放地址…') {
  if (hls) { hls.destroy(); hls = null; }
  clearTimeout(current.loadTimer);
  const generation = (current.mediaVersion || 0) + 1; current.mediaVersion = generation;
  const url = mediaUrl(current.usedProxy ? current.proxyUrl : current.url);
  if (!url) return playbackError(current);
  current.note.className = 'player-note'; current.note.textContent = message;
  const video = current.video;
  if (current.type === 'hls') {
    try { await ensureHls(); }
    catch (error) {
      if (player === current && generation === current.mediaVersion) { current.failed = true; current.note.textContent = error.message; current.note.className = 'player-note error-message'; }
      return;
    }
    if (player !== current || generation !== current.mediaVersion) return;
  }
  current.loadTimer = setTimeout(() => { if (player === current && generation === current.mediaVersion && video.readyState < 2) playbackError(current); }, 15000);
  if (current.type === 'hls' && window.Hls?.isSupported()) {
    const quality = current.live && !current.transcoded ? liveQuality(current.channel.streams[current.line]) : null;
    const selectLevel = Boolean(quality);
    hls = new window.Hls(current.transcoded ? { startPosition: 0 } : selectLevel ? { autoStartLoad: false } : {}); const instance = hls; hls.loadSource(url); hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_event, data) => { if (player === current && generation === current.mediaVersion && data.fatal) playbackError(current); });
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_event, data) => {
      if (player !== current || generation !== current.mediaVersion) return;
      if (selectLevel) {
        const levels = data?.levels || instance.levels || [];
        const index = hlsInitialLevel(levels, quality);
        if (index >= 0) instance.startLevel = index;
        instance.startLoad?.(-1);
      }
      attemptPlay(current, generation);
    });
  } else if (current.type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
    clearTimeout(current.loadTimer); playbackError(current);
  } else { video.src = url; attemptPlay(current, generation); }
}

async function nextEpisode(current) {
  if (!current.catalog) return;
  if (current.detail.lines[current.line]?.episodes[current.episode + 1]) await startEpisode(current.detail, current.line, current.episode + 1);
  else notify('已播放到这条线路的最后一集。');
}

function saveHistory(current, ended = false, completed = false) {
  if (current.live || current.started === false) return Promise.resolve();
  const record = historyRecord(current);
  library.history = [record, ...library.history.filter(item => item.key !== record.key)];
  const saved = historyQueue.catch(() => {}).then(() => api('/api/history', { method: 'POST', body: record }));
  historyQueue = saved;
  return Promise.all([saved.catch(error => { if (!current.saveFailed) { current.saveFailed = true; notify(`观看记录未保存：${error.message}`, true); } }), queueQuarkProgress(current, ended, false, completed)]);
}

function stopPlayer(invalidate = true) {
  if (invalidate) playVersion++;
  const current = player; player = null;
  if (!current) return Promise.resolve();
  const save = saveHistory(current);
  clearInterval(current.timer);
  clearInterval(current.danmakuTimer); clearDanmaku(current);
  clearTimeout(current.loadTimer);
  if (hls) { hls.destroy(); hls = null; }
  if (current.video) { current.video.pause(); current.video.removeAttribute('src'); current.video.load(); }
  if (current.frame) current.frame.src = 'about:blank';
  return Promise.all([save, stopTranscode(current.transcodeId, true)]);
}

function openLink(url, resume = false) {
  const safe = httpUrl(url); if (!safe) throw new Error('视频链接必须是有效的 HTTP 或 HTTPS 地址。');
  const parsed = new URL(safe);
  const previous = library.history.find(item => item.key === `link:${safe}`);
  const data = { key: `link:${safe}`, title: parsed.hostname, year: '', type: 'movie', poster: '', source: '', id: '' };
  const heading = section('链接播放'); heading.append(node('p', safe, 'muted'));
  const host = node('div', undefined, 'player-host'); host.id = 'player-host';
  content.replaceChildren(heading, host);
  player = { detail: data, url: safe, type: /\.m3u8$/i.test(parsed.pathname) ? 'hls' : /\.mp4$/i.test(parsed.pathname) ? 'mp4' : 'page', mode: 'direct', position: resume ? previous?.position || 0 : 0, parser: previous?.parser };
  mountPlayer(player);
}

function formatDate(value) {
  if (!value) return '尚未运行';
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '尚未运行';
}

function settingsSection(title, overview, className = '') {
  const panel = node('details', undefined, `settings-section ${className}`.trim()); panel.open = openSettingsSections.has(title);
  const summary = node('summary', undefined, 'settings-summary'); summary.tabIndex = 0; summary.append(node('h2', title), node('small', overview, 'settings-summary-info')); panel.append(summary);
  panel.addEventListener('toggle', () => { if (panel.isConnected) { if (panel.open) openSettingsSections.add(title); else openSettingsSections.delete(title); } });
  return panel;
}

function maintenancePanel(stamp) {
  const panel = settingsSection('影视源维护', '检测接口、更新订阅与发现新源'); panel.append(node('p', '服务端根据后台模式定期检测影视接口、刷新直播列表并分批探测线路，更新订阅和发现公开的新订阅。检测通过不代表所有内容都能播放，播放器只展示当前已验证可用的选项。修改配置后请先保存，再手动更新或发现订阅。', 'muted'));
  panel.append(node('p', '发现的新源通过验证后自动加入。影视源连续失败 3 次且距首次失败至少 1 小时后会自动隔离，暂停参与搜索；后台重试成功后自动恢复。隔离保留配置，不会硬删除你添加的影视源。', 'muted'));
  const actions = node('div', undefined, 'settings-actions');
  const status = node('div', '正在读取维护状态…', 'maintenance-status'); status.setAttribute('aria-live', 'polite');
  let version = 0;
  function drawState(data) {
    status.replaceChildren();
    const running = typeof data.running === 'object' && data.running ? Object.values(data.running).some(Boolean) : Boolean(data.running);
    status.append(node('p', `${running ? '维护任务正在运行 · ' : ''}最近检测：${formatDate(data.lastProbe)} · 最近订阅更新：${formatDate(data.lastUpdate)}`, 'maintenance-summary'));
    const schedule = [(data.backgroundMode || data.discovery?.backgroundMode) === 'low' ? '低负载模式' : '', Number.isFinite(data.probeIntervalMinutes) ? `后台检测每 ${data.probeIntervalMinutes} 分钟` : '', Number.isFinite(data.updateIntervalMinutes) ? `订阅更新每 ${data.updateIntervalMinutes} 分钟` : '', Number.isFinite(data.discovery?.intervalMinutes) ? `订阅发现每 ${data.discovery.intervalMinutes} 分钟` : ''].filter(Boolean);
    if (schedule.length) status.append(node('p', schedule.join(' · '), 'maintenance-summary'));
    if (data.discovery) {
      const found = data.discovery.candidates || [];
      status.append(node('p', `${data.discovery.running ? '正在发现新订阅 · ' : ''}最近发现：${formatDate(data.discovery.lastDiscovery)} · 新增 ${found.filter(item => item.added).length} 个订阅`, 'maintenance-summary'));
      if (data.discovery.retiredCount) status.append(node('p', `已撤下 ${data.discovery.retiredCount} 个持续失效的自动订阅，仍按退避复查；用户添加或修改的配置不会自动撤下。`, 'maintenance-summary'));
      for (const item of data.discovery.retired || []) status.append(node('p', `${item.name || item.id}：已撤下${item.reason ? ` · ${item.reason}` : ''}${item.retryAt ? ` · 下次复查：${formatDate(item.retryAt)}` : ''}`, 'muted'));
      for (const item of found.filter(item => item.added || item.error || item.reason || item.httpStatus)) {
        const code = Number(item.httpStatus), reason = code === 403 ? 'HTTP 403：访问受限或限流' : code === 404 ? 'HTTP 404：配置路径不存在' : code ? `HTTP ${code}` : '';
        status.append(node('p', `${item.name || item.url}：${item.added ? '验证通过，已自动加入订阅' : [reason, item.reason, item.error].filter(Boolean).join(' · ')}${item.retryAt ? ` · 下次重试：${formatDate(item.retryAt)}` : ''}`, item.error || code >= 400 ? 'maintenance-error' : 'muted'));
      }
    }
    for (const [key, title] of [['sources', '接口检测'], ['subscriptions', '订阅更新'], ['liveSources', '直播源列表']]) {
      const rows = data[key] || []; if (!rows.length) continue;
      status.append(node('h3', title)); const list = node('div', undefined, 'maintenance-list');
      for (const item of rows) {
        const row = node('div', undefined, 'maintenance-row');
        const state = item.status || (item.enabled === false ? 'disabled' : 'unknown');
        const caption = { ok: '可用', error: '失败', quarantined: '已隔离', disabled: '已停用', unknown: '未检测' }[state] || '未检测';
        const label = node('span', caption, `maintenance-state state-${['ok', 'error', 'quarantined', 'disabled', 'unknown'].includes(state) ? state : 'unknown'}`);
        row.append(node('strong', item.name || item.id), label, node('small', `${Number.isFinite(item.latencyMs) ? `${item.latencyMs} ms · ` : ''}${formatDate(key === 'subscriptions' ? item.lastUpdate || item.checkedAt : item.checkedAt)}`, 'muted'));
        if (item.error) row.append(node('p', item.error, 'maintenance-error'));
        if (item.failures || state === 'quarantined') row.append(node('p', [`连续失败 ${Number(item.failures) || 0} 次`, item.firstFailureAt ? `首次失败：${formatDate(item.firstFailureAt)}` : '', item.retryAt ? `下次重试：${formatDate(item.retryAt)}` : '', state === 'quarantined' ? '配置已保留，后台重试成功后自动恢复。' : ''].filter(Boolean).join(' · '), 'maintenance-detail muted'));
        list.append(row);
      }
      status.append(list);
    }
    if (!(data.sources?.length || data.subscriptions?.length || data.liveSources?.length)) status.append(node('p', '添加影视源、直播源或订阅后，可在这里检测和更新。', 'muted'));
  }
  async function run(action) {
    const request = ++version; probe.disabled = true; update.disabled = true; discover.disabled = true;
    status.replaceChildren(node('p', action === 'probe' ? '正在检测影视源，请稍候…' : action === 'update' ? '正在更新订阅，请稍候…' : action === 'discover' ? '正在发现并验证新订阅，请稍候…' : '正在读取维护状态…', 'muted'));
    try {
      const data = await api(action ? `/api/sources/${action}` : '/api/sources/status', action ? { method: 'POST', body: {}, timeoutMs: 150000 } : {});
      if (stamp !== routeVersion || request !== version || !status.isConnected) return;
      drawState(data);
      if (['update', 'discover'].includes(action)) {
        const latest = await api('/api/config');
        if (stamp !== routeVersion || request !== version || !status.isConnected) return;
        applyConfig(latest); updateSourceStatus(); renderSettings(); notify(action === 'discover' ? '订阅发现已完成，配置已刷新' : '订阅更新已完成，源配置已刷新');
      }
    } catch (error) { if (stamp === routeVersion && request === version && status.isConnected) status.replaceChildren(node('p', `维护状态读取失败：${error.message}`, 'error-message')); }
    finally { if (stamp === routeVersion && request === version) { probe.disabled = !((config.sources || []).length || (config.liveSources || []).length); update.disabled = ![...(config.subscriptions || []), ...(config.liveSources || [])].some(item => item.enabled !== false); discover.disabled = false; } }
  }
  const probe = button('立即检测影视源', () => void run('probe'), 'button small');
  const update = button('立即更新订阅', () => void run('update'), 'button small');
  const discover = button('发现新订阅', () => void run('discover'), 'button small');
  actions.append(probe, update, discover); panel.append(actions, status); void run(); return panel;
}

function quarkSettingsPanel(stamp) {
  const panel = settingsSection('夸克网盘', '账号连接、当前单集准备与到期清理', 'quark-settings'); panel.append(node('p', '仅为点开的影片或当前选中单集准备匹配视频，准备好后由你选择切换。自动清理只处理本应用管理、已看完且达到保留期限的文件，保留天数可改或关闭；其他目录和未看完文件不会删除。', 'muted'));
  const status = node('p', '正在读取账号状态…', 'muted'); status.setAttribute('aria-live', 'polite'); panel.append(status);
  const fields = node('div', undefined, 'quark-settings-fields'), inputs = {};
  for (const [key, label] of [['enabled', '启用夸克'], ['autoSave', '自动准备当前单集'], ['cleanupEnabled', '定期清理已看完文件']]) {
    const field = node('label', label, 'player-option'), input = node('input'); input.type = 'checkbox'; input.setAttribute('aria-label', label); field.prepend(input); fields.append(field); inputs[key] = input;
  }
  const retentionLabel = node('label', '看完后保留天数'), retention = node('input'); retention.type = 'number'; retention.min = '1'; retention.step = '1'; retention.value = '7'; retention.setAttribute('aria-label', '夸克看完后保留天数'); retentionLabel.append(retention); fields.append(retentionLabel);
  const dailyLabel = node('label', '每日最多转存次数'), dailyTransfers = node('input'); dailyTransfers.type = 'number'; dailyTransfers.min = '1'; dailyTransfers.max = '100'; dailyTransfers.step = '1'; dailyTransfers.required = true; dailyTransfers.value = '100'; dailyTransfers.setAttribute('aria-label', '每日最多转存次数'); dailyLabel.append(dailyTransfers); fields.append(dailyLabel);
  const searchLabel = node('label', '资源搜索接口（可选）'), search = node('input'); search.type = 'url'; search.placeholder = 'https://…'; search.setAttribute('aria-label', '夸克资源搜索接口'); searchLabel.append(search); fields.append(searchLabel);
  const cookieLabel = node('label', '官方网页登录 Cookie'), cookie = node('input'); cookie.type = 'password'; cookie.autocomplete = 'off'; cookie.placeholder = '留空保留已连接账号'; cookie.setAttribute('aria-label', '夸克账号 Cookie'); cookieLabel.append(cookie); fields.append(cookieLabel);
  panel.append(fields, node('p', '首次连接时，复制夸克官方网页文件列表请求 Request Headers 的 Cookie 完整值，支持 Cookie: 前缀。保存后清空此输入，账号凭证不会回填或包含在配置导出中。', 'muted'));
  const actions = node('div', undefined, 'settings-actions'); panel.append(actions);
  for (const input of [...Object.values(inputs), retention, dailyTransfers, search, cookie]) input.disabled = true;
  let data = null, version = 0;
  const valid = request => stamp === routeVersion && panel.isConnected && request === version;
  function draw(next) {
    data = next; for (const [key, input] of Object.entries(inputs)) input.checked = next[key] === true;
    for (const input of [...Object.values(inputs), retention, dailyTransfers, search, cookie]) input.disabled = false; save.disabled = false;
    retention.value = String(next.retentionDays || 7); dailyTransfers.value = String(next.maxDailyTransfers ?? 100); search.value = next.searchApi || '';
    const count = Number.isFinite(next.managedFiles) ? next.managedFiles : Array.isArray(next.managedFiles) ? next.managedFiles.length : Number.isFinite(next.managedFiles?.total) ? next.managedFiles.total : null;
    status.textContent = `${next.account?.connected ? `已连接 · ${next.account.label || '夸克账号'}` : '尚未连接夸克账号'}${count !== null ? ` · 管理 ${count} 个文件` : ''} · 最近清理：${formatDate(next.lastCleanup)}${next.lastError ? ` · ${next.lastError}` : ''}`;
    limit.textContent = `每日转存上限：${next.maxDailyTransfers ?? 100} 次 / ${fileSize(next.maxDailyBytes ?? 21474836480)}。转存保留源文件画质，不会自动提升分辨率。`;
    disconnect.disabled = !next.account?.connected; cleanup.disabled = !next.account?.connected;
  }
  async function load() {
    const request = ++version;
    try { const next = await api('/api/quark/settings'); if (valid(request)) draw(next); }
    catch (error) { if (valid(request)) status.textContent = `夸克设置暂时不可用：${error.message}`; }
  }
  const save = button('保存夸克设置', async () => {
    if (!retention.reportValidity() || !dailyTransfers.reportValidity() || !search.reportValidity() || retention.value === '') return;
    const request = ++version; save.disabled = true;
    try {
      const next = await api('/api/quark/settings', { method: 'PUT', body: { ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.checked])), retentionDays: Number(retention.value), maxDailyTransfers: Number(dailyTransfers.value), searchApi: search.value.trim(), ...(cookie.value.trim() ? { cookie: cookie.value.trim() } : {}) }, timeoutMs: 35000 });
      if (!valid(request)) return; cookie.value = ''; draw(next); notify('夸克设置已保存');
    } catch (error) { if (valid(request)) status.textContent = `夸克设置未保存：${error.message}`; }
    finally { if (valid(request)) save.disabled = false; }
  }, 'button primary small');
  save.disabled = true;
  const disconnect = button('断开夸克账号', async () => {
    disconnect.disabled = true;
    try { await api('/api/quark/account', { method: 'DELETE' }); if (stamp !== routeVersion || !panel.isConnected) return; cookie.value = ''; await load(); notify('已断开账号，云文件保持原样'); }
    catch (error) { if (stamp === routeVersion) status.textContent = `账号未断开：${error.message}`; }
    finally { if (stamp === routeVersion && panel.isConnected) disconnect.disabled = !data?.account?.connected; }
  }, 'button small');
  const cleanup = button('清理到期已看完文件', async () => {
    cleanup.disabled = true;
    try { await api('/api/quark/cleanup', { method: 'POST', body: {}, timeoutMs: 60000 }); if (stamp !== routeVersion || !panel.isConnected) return; await load(); notify('已检查到期且已看完的管理文件'); }
    catch (error) { if (stamp === routeVersion) status.textContent = `清理未完成：${error.message}`; }
    finally { if (stamp === routeVersion && panel.isConnected) cleanup.disabled = !data?.account?.connected; }
  }, 'button small');
  const limit = node('p', undefined, 'muted'); actions.append(save, disconnect, cleanup, button('刷新夸克状态', () => void load(), 'button small')); panel.append(limit); void load(); return panel;
}

function renderSettings() {
  const draft = structuredClone({ subscriptions: [], liveSources: [], ...config });
  const page = document.createDocumentFragment();
  const tools = node('div', undefined, 'settings-actions');
  const save = button('保存全部设置', async () => {
    try {
      for (const kind of ['platforms', 'parsers', 'sources', 'subscriptions', 'liveSources']) {
        const ids = new Set();
        for (const item of draft[kind]) {
          if (!item.id.trim() || !item.name.trim()) throw new Error('每项都需要填写标识和名称。');
          if (ids.has(item.id)) throw new Error(`标识重复：${item.id}`); ids.add(item.id);
          if (!(kind === 'parsers' && item.url === '') && !(item.api || item.url || '').trim()) throw new Error(`${item.name} 的地址不能为空。`);
        }
      }
      save.disabled = true; applyConfig(await api('/api/config', { method: 'PUT', body: draft })); updateSourceStatus(); renderSettings(); notify('资源设置已保存');
    } catch (error) { notify(error.message, true); }
    finally { save.disabled = false; }
  }, 'button primary');
  const exportConfig = button('导出配置', async () => {
    try {
      const latest = await api('/api/config'); const blob = new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
      const link = node('a'); link.href = url; link.download = 'vipvideo-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('配置已导出，不包含密码和观看记录');
    } catch (error) { notify(error.message, true); }
  }, 'button');
  tools.append(save); page.append(tools, node('p', `${draft.sources.length} 个影视源 · ${draft.subscriptions.length} 个订阅 · ${draft.liveSources.length} 个直播源。按需展开设置；新增、排序、停用后点击「保存全部设置」。`, 'settings-note'));
  const sections = node('div', undefined, 'settings-directory'); page.append(sections);
  const display = settingsSection('分类显示', draft.showAdult ? '三级分类已显示 · 全家庭共用' : '三级分类已隐藏 · 全家庭共用');
  const adultLabel = node('label', '显示“三级”分类', 'display-option');
  const adultCheckbox = node('input'); adultCheckbox.type = 'checkbox'; adultCheckbox.checked = draft.showAdult === true; adultCheckbox.setAttribute('aria-label', '显示“三级”分类'); adultCheckbox.addEventListener('change', () => { draft.showAdult = adultCheckbox.checked; });
  adultLabel.prepend(adultCheckbox); display.append(adultLabel, node('p', '敏感电影、电视剧和动漫集中到该分类。关闭后，相关搜索、收藏和观看记录会隐藏，重新开启后恢复显示。此设置由家庭内所有设备共用。', 'muted')); sections.append(display);
  const importer = settingsSection('导入资源配置', '导入 / 导出 JSON 配置与添加内置源'); importer.append(node('p', '支持 MoonTV / KatelyaTV 的 api_site 等影视源 JSON，以及本应用导出的配置。服务端校正常见配置格式和地址，按标识合并。', 'muted'));
  const file = node('input', undefined, 'import-file'); file.type = 'file'; file.accept = '.json,application/json'; file.setAttribute('aria-label', '选择配置 JSON 文件');
  const json = node('textarea', undefined, 'config-json'); json.rows = 5; json.spellcheck = false; json.setAttribute('aria-label', '配置 JSON'); json.placeholder = '{"api_site":{"example":{"name":"示例影视源","api":"https://example.com/api.php/provide/vod/"}}}';
  file.addEventListener('change', async () => {
    try { if (file.files[0]) { if (file.files[0].size > 1048576) throw new Error('配置文件不能超过 1 MB。'); json.value = await file.files[0].text(); } }
    catch (error) { notify(error.message, true); }
  });
  const importButton = button('校验并导入', async () => {
    try { importButton.disabled = true; acceptImport(await api('/api/config/import', { method: 'POST', body: { config: json.value } })); updateSourceStatus(); renderSettings(); notify(importWarnings.length ? `资源配置已导入，有 ${importWarnings.length} 条导入提示` : '资源配置已导入'); }
    catch (error) { notify(`导入失败：${error.message}`, true); }
    finally { importButton.disabled = false; }
  }, 'button');
  const importActions = node('div', undefined, 'settings-actions'); importActions.append(importButton, presetButton(), exportConfig);
  importer.append(file, json, importActions);
  if (importWarnings.length) {
    const warnings = node('div', undefined, 'notice import-warnings'); warnings.setAttribute('role', 'status');
    warnings.append(node('h3', `上次成功导入的提示（${importWarnings.length} 条）`));
    for (const message of importWarnings) warnings.append(node('p', message));
    importer.append(warnings);
  }
  sections.append(importer);
  sections.append(maintenancePanel(routeVersion));
  sections.append(quarkSettingsPanel(routeVersion));
  const descriptions = { sources: ['影视源', '填写 AppleCMS JSON 接口；搜索时只查询启用的源。', 'api'], subscriptions: ['影视源订阅', '填写 api_site JSON 配置订阅地址，按源标识合并。启用后服务端定期更新，也可立即手动更新。', 'url'], liveSources: ['电视直播源', '填写 M3U / M3U8 频道列表地址；频道及线路由服务端读取，播放时可手动切换。', 'url'], platforms: ['平台入口', '首页展示的视频平台链接，不作为聚合搜索源。', 'url'], parsers: ['解析线路', '填写带 ?url= 等参数的视频解析地址前缀，也支持 {url} 占位符。', 'url'] };
  for (const [kind, [title, description, urlKey]] of Object.entries(descriptions)) {
    const panel = settingsSection(title, `${draft[kind].length} 项配置 · 按需新增、编辑与排序`);
    const heading = node('div', undefined, 'section-heading'); heading.append(button('＋ 添加', () => { draft[kind].push({ id: `${kind.slice(0, -1)}-${Date.now()}`, name: '', [urlKey]: '', enabled: true, ...(kind === 'platforms' ? { category: '视频' } : {}) }); drawRows(); }, 'button small'));
    panel.append(heading, node('p', description, 'muted'));
    const list = node('div', undefined, 'config-list'); panel.append(list);
    const drawRows = () => {
      panel.querySelector('.settings-summary-info').textContent = `${draft[kind].length} 项配置 · 按需新增、编辑与排序`;
      list.replaceChildren();
      if (!draft[kind].length) { list.append(node('p', '暂无配置，点击添加或导入配置。', 'muted')); return; }
      draft[kind].forEach((item, index) => {
        const row = node('div', undefined, 'config-row'); const fields = node('div', undefined, 'config-fields');
        for (const [key, caption] of [['id', '唯一标识'], ['name', '显示名称'], [urlKey, '地址'], ...(kind === 'platforms' ? [['category', '分类']] : [])]) {
          const label = node('label', caption, 'config-field'); const input = node('input'); input.value = item[key] || ''; input.setAttribute('aria-label', `${title} ${index + 1} ${caption}`); input.addEventListener('input', () => { item[key] = input.value.trim(); }); label.append(input); fields.append(label);
        }
        const controls = node('div', undefined, 'config-controls'); const enabled = node('label', '启用'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = item.enabled !== false; checkbox.setAttribute('aria-label', `启用 ${item.name || '新配置'}`); checkbox.addEventListener('change', () => { item.enabled = checkbox.checked; }); enabled.prepend(checkbox); controls.append(enabled);
        const up = button('↑ 上移', () => { [draft[kind][index - 1], draft[kind][index]] = [draft[kind][index], draft[kind][index - 1]]; drawRows(); }, 'button subtle small'); up.disabled = index === 0;
        const down = button('↓ 下移', () => { [draft[kind][index + 1], draft[kind][index]] = [draft[kind][index], draft[kind][index + 1]]; drawRows(); }, 'button subtle small'); down.disabled = index === draft[kind].length - 1;
        controls.append(up, down, button('删除', () => { draft[kind].splice(index, 1); drawRows(); }, 'button subtle small danger')); row.append(fields, controls); list.append(row);
      });
    };
    drawRows(); sections.append(panel);
  }
  content.replaceChildren(page);
}

function updateSourceStatus() {
  $('#source-status').textContent = `${config.sources.filter(source => source.enabled !== false).length} 个影视源`;
}

async function renderRoute() {
  if ($('#app-view').hidden) return;
  const stamp = ++routeVersion; void stopPlayer(); detail = null; detailTarget = null;
  const [view, rawQuery = ''] = location.hash.slice(1).split('?'); const params = new URLSearchParams(rawQuery);
  const titles = { home: '首页', search: '搜索影片', favorites: '我的收藏', history: '观看记录', settings: '资源设置', detail: '影片详情', link: '链接播放', live: '电视直播' };
  const selectedView = titles[view] ? view : 'home'; $('#page-title').textContent = titles[selectedView]; document.title = `${titles[selectedView]} · 映家`;
  document.querySelectorAll('nav a').forEach(link => { const active = link.dataset.view === (selectedView === 'live' ? 'home' : selectedView); link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  content.setAttribute('aria-busy', 'true');
  content.replaceChildren(node('div', '正在加载…', 'loading'));
  try {
    const needsState = ['home', 'favorites', 'history', 'detail'].includes(selectedView);
    const statePromise = needsState ? historyQueue.catch(error => console.warn('等待记录保存时失败', error)).then(() => api('/api/state')).catch(error => { if (stamp === routeVersion) notify(`共享记录暂时未同步：${error.message}`, true); return null; }) : Promise.resolve(null);
    const latestConfig = await api('/api/config');
    if (stamp !== routeVersion) return;
    applyConfig(latestConfig); updateSourceStatus();
    if (stamp !== routeVersion) return;
    if (selectedView !== 'home') { const latestState = await statePromise; if (stamp !== routeVersion) return; if (latestState) library = latestState; }
    if (selectedView === 'home' && params.get('category') === 'adult' && !config.showAdult) { leaveAdultScreen(); return; }
    if (selectedView === 'home') await renderHome(params.get('category') || 'movie', params.get('source') || '', stamp, statePromise, { genre: params.get('genre'), year: params.get('year'), sort: params.get('sort') });
    else if (selectedView === 'favorites' || selectedView === 'history') renderLibrary(selectedView);
    else if (selectedView === 'settings') renderSettings();
    else if (selectedView === 'search') await renderSearch(params.get('q') || '', stamp);
    else if (selectedView === 'detail') await openDetail(params.get('source') || '', params.get('id') || '', stamp);
    else if (selectedView === 'link') openLink(params.get('url') || '', params.get('resume') === '1');
    else if (selectedView === 'live') await renderLive(params, stamp);
  } catch (error) {
    if (stamp !== routeVersion) return;
    if (error.adultHidden) leaveAdultScreen();
    else content.replaceChildren(empty('暂时无法打开', error.message, button('返回首页', () => goto('home'))));
  }
  finally { if (stamp === routeVersion) content.setAttribute('aria-busy', 'false'); }
}

function showLogin() {
  resourceSnapshots.clear();
  routeVersion++; void stopPlayer(); $('#app-view').hidden = true; $('#login-view').hidden = false; $('#password').focus({ preventScroll: true });
}

async function boot() {
  const auth = await api('/api/auth');
  if (!auth.authenticated) { showLogin(); return; }
  $('#login-view').hidden = true; $('#app-view').hidden = false; updateSourceStatus(); await renderRoute();
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = $('button', event.currentTarget); submit.disabled = true; $('#login-error').textContent = '';
  try { await api('/api/auth/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; await boot(); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await stopPlayer(); await api('/api/auth/logout', { method: 'POST', body: {} }); library = { favorites: [], history: [] }; showLogin(); }
  catch (error) { notify(error.message, true); }
});
window.addEventListener('hashchange', () => void renderRoute());
window.addEventListener('keydown', event => {
  const current = player, target = event.target;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !current?.video || !(target instanceof Element) || !$('#player-host')?.contains(target) || target.matches('input,textarea,select') || target.closest('[contenteditable="true"]')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seekVideo(current, event.key === 'ArrowRight' ? 10 : -10); }
  else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const controls = [...$('#player-host').querySelectorAll('button,a[href],video[controls],select,input')].filter(element => !element.disabled && element.getClientRects().length);
    const index = controls.indexOf(target), direction = event.key === 'ArrowDown' ? 1 : -1;
    if (controls.length) { event.preventDefault(); controls[(index + direction + controls.length) % controls.length].focus(); }
  }
});
$('.skip-link').addEventListener('click', event => { event.preventDefault(); content.focus({ preventScroll: true }); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && player) void saveHistory(player);
  else if (!document.hidden && !$('#app-view').hidden) {
    void api('/api/config').then(next => {
      const changed = Boolean(config.showAdult) !== Boolean(next.showAdult);
      const left = applyConfig(next);
      if (changed && !left && !player && !location.hash.startsWith('#detail')) void renderRoute();
    }).catch(error => notify(`显示设置未同步：${error.message}`, true));
  }
});
window.addEventListener('pagehide', () => {
  if (!player) return;
  const current = player;
  playVersion++; player = null;
  clearInterval(current.timer); clearInterval(current.danmakuTimer); clearTimeout(current.loadTimer); clearDanmaku(current);
  if (hls) { hls.destroy(); hls = null; }
  current.video?.pause();
  void stopTranscode(current.transcodeId, true); current.transcodeId = null;
  if (current.live || current.started === false) return;
  const record = historyRecord(current);
  void queueQuarkProgress(current, false, true);
  void fetch('/api/history', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record), keepalive: true }).catch(error => console.warn('离开页面时未能保存观看记录', error));
});
window.addEventListener('pageshow', event => { if (event.persisted && !$('#app-view')?.hidden) void renderRoute(); });
void boot().catch(error => { $('#login-view').hidden = false; $('#login-error').textContent = error.message; });

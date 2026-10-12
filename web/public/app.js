const $ = (selector, root = document) => root.querySelector(selector);
const content = $('#content');
let config = { platforms: [], parsers: [], sources: [] };
let library = { favorites: [], history: [] };
let lastSearch = { q: '', groups: [] };
let detail = null;
let player = null;
let hls = null;
let routeVersion = 0;
let playVersion = 0;
let toastTimer;
let historyQueue = Promise.resolve();

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
  const response = await fetch(path, {
    method: options.method || 'GET', credentials: 'same-origin', signal: AbortSignal.timeout(45000),
    headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/login')) showLogin();
    throw new Error(data.error || data.message || `请求失败（${response.status}）`);
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
  return { key: item.key, title: item.title, year: item.year || '', type: item.type || 'movie', poster: item.poster || '', source: item.source || '', id: String(item.id ?? '') };
}

function openItem(item, resume = false) {
  if (item.key?.startsWith('link:')) goto('link', { url: item.url || item.key.slice(5), resume: resume ? '1' : '0' });
  else goto('detail', { source: item.source, id: item.id, ...(resume ? { resume: '1' } : {}) });
}

function card(item, options = {}) {
  const element = node('article', undefined, 'media-card');
  const cover = button('', () => openItem(item, options.resume), 'poster-link');
  cover.setAttribute('aria-label', `${options.resume ? '继续观看' : '查看'} ${item.title}`);
  const poster = httpUrl(item.poster);
  if (poster) {
    const image = node('img');
    image.src = poster; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    cover.append(image);
  }
  cover.append(node('span', item.title, 'poster-fallback'));
  cover.append(node('span', options.resume ? `继续 · ${formatTime(item.position || 0)}` : `${item.year || '年份未知'} · ${typeLabel(item.type)}`, 'poster-tag'));
  if (item.duration > 0 && options.resume) {
    const progress = node('progress'); progress.max = item.duration; progress.value = item.position || 0;
    progress.setAttribute('aria-label', '观看进度'); cover.append(progress);
  }
  element.append(cover, node('h3', item.title, 'card-title'), node('p', options.resume ? sourceName(item.source) : `${item.items?.length || 1} 个来源`, 'card-meta'));
  if (options.remove) {
    const remove = button('×', options.remove, 'card-delete'); remove.setAttribute('aria-label', `移除 ${item.title}`); element.append(remove);
  }
  return element;
}

function grid(items, options = {}) {
  const element = node('div', undefined, 'poster-grid');
  for (const item of items) element.append(card(item, typeof options === 'function' ? options(item) : options));
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

function renderHome() {
  const page = document.createDocumentFragment();
  if (!config.sources.some(source => source.enabled !== false)) {
    const guide = node('div', '还没有影视源。导入兼容 MoonTV / KatelyaTV 的配置后，即可搜索影片。', 'notice');
    guide.append(button('导入影视源', () => goto('settings'), 'button small primary')); page.append(guide);
  }
  const recent = library.history.filter(item => !item.key.startsWith('link:')).slice(0, 6);
  const watching = section('继续观看', recent.length ? `${recent.length} 部影片` : '', externalLink('全部记录 →', `${location.origin}/#history`, 'text-link'));
  const historyLink = $('.text-link', watching); if (historyLink) { historyLink.target = '_self'; historyLink.removeAttribute('rel'); }
  watching.append(recent.length ? grid(recent, { resume: true }) : empty('从一部影片开始', '搜索并播放后，观看进度会保存在这里。', button('搜索影片', () => goto('search'), 'button primary')));
  page.append(watching, urlForm());
  const favorites = section('我的收藏', library.favorites.length ? `${library.favorites.length} 部` : '', button('查看全部 →', () => goto('favorites'), 'button subtle small'));
  favorites.append(library.favorites.length ? grid(library.favorites.slice(0, 6)) : node('p', '遇到喜欢的影片，点亮收藏按钮，留给下次观看。', 'muted')); page.append(favorites);
  const platforms = section('平台入口', '在平台找到视频页后，粘贴链接解析');
  const platformGrid = node('div', undefined, 'platform-grid');
  for (const platform of config.platforms.filter(item => item.enabled !== false && httpUrl(item.url))) {
    const link = externalLink('', platform.url, 'platform-link');
    const caption = node('div'); caption.append(node('strong', platform.name), node('small', platform.category || '视频平台'));
    link.append(node('span', platform.name.slice(0, 1), 'platform-logo'), caption, node('span', '↗', 'platform-arrow')); platformGrid.append(link);
  }
  platforms.append(platformGrid.childElementCount ? platformGrid : empty('暂无平台入口', '可在资源设置中添加平台链接。')); page.append(platforms);
  content.replaceChildren(page);
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
  const items = library[kind];
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
    const data = await api(`/api/search?${new URLSearchParams({ q: query })}`);
    if (stamp !== routeVersion) return;
    lastSearch = { q: query, groups: data.groups || [] };
    results.replaceChildren();
    if (data.failedSources?.length) {
      const failures = node('details', undefined, 'failure-list');
      failures.append(node('summary', `${data.failedSources.length} 个影视源未返回结果，其他来源不受影响`));
      for (const source of data.failedSources) failures.append(node('p', `${source.name || source.source}：${source.error}`));
      results.append(failures);
    }
    const heading = section('搜索结果', `${lastSearch.groups.length} 部影片`);
    const items = lastSearch.groups.filter(group => group.items?.length).map(group => ({ ...group, ...group.items[0], key: group.key, items: group.items }));
    heading.append(items.length ? grid(items) : empty('没有找到相关影片', '试试更短的片名，或在设置中检查影视源。')); results.append(heading);
  } catch (error) { if (stamp === routeVersion) results.replaceChildren(empty('搜索暂时不可用', error.message, button('重试', () => goto('search', { q: query }), 'button'))); }
}

function findCandidates(data) {
  return lastSearch.groups.find(group => group.key === data.key)?.items || data.candidates || [];
}

async function openDetail(source, id, stamp, resume = false) {
  content.replaceChildren(node('div', '正在读取影片与播放线路…', 'loading'));
  const data = await api(`/api/detail?${new URLSearchParams({ source, id })}`);
  if (stamp !== routeVersion) return;
  detail = data;
  const history = library.history.find(record => record.key === data.key);
  detail.selectedLine = history?.source === data.source && data.lines[history.line] ? history.line : 0;
  renderDetail(data, findCandidates(data));
  if (resume && history) {
    const line = data.lines[detail.selectedLine];
    if (line?.episodes[history.episode]) void startEpisode(data, detail.selectedLine, history.episode, history.position || 0);
  }
  if (!findCandidates(data).length) {
    try {
      const alternatives = await api(`/api/search?${new URLSearchParams({ q: data.title })}`);
      if (stamp !== routeVersion || detail !== data) return;
      const group = alternatives.groups?.find(item => item.key === data.key);
      if (group) renderSources(data, group.items);
    } catch (error) {
      if (stamp === routeVersion && detail === data) {
        const row = $('#source-row'); row?.append(node('span', `其他来源查询失败：${error.message}`, 'muted'));
      }
    }
  }
}

function renderDetail(data, candidates) {
  const summary = node('section', undefined, 'detail-summary');
  const posterUrl = httpUrl(data.poster);
  if (posterUrl) { const image = node('img', undefined, 'detail-poster'); image.src = posterUrl; image.alt = ''; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', () => image.remove(), { once: true }); summary.append(image); }
  const info = node('div', undefined, 'detail-info');
  info.append(node('h2', data.title), node('p', `${data.year || '年份未知'} · ${typeLabel(data.type)} · ${sourceName(data.source)}`, 'meta'));
  if (data.description) info.append(node('p', data.description, 'detail-description'));
  const actions = node('div', undefined, 'detail-actions');
  const history = library.history.find(record => record.key === data.key && record.source === data.source);
  const start = button(history ? `继续播放 · ${formatTime(history.position || 0)}` : '▷ 播放第一集', () => {
    const line = history && data.lines[history.line] ? history.line : 0;
    const episode = history && data.lines[line]?.episodes[history.episode] ? history.episode : 0;
    void startEpisode(data, line, episode, history?.position || 0);
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
  content.replaceChildren(summary, layout, sources);
  renderEpisodes(data); renderSources(data, candidates);
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
  const tabs = node('div', undefined, 'line-tabs');
  data.lines.forEach((line, index) => {
    const tab = button(line.name || `线路 ${index + 1}`, () => {
      const old = player;
      data.selectedLine = index; renderEpisodes(data);
      if (old?.detail === data) {
        const match = matchEpisode(line, old.episodeName, old.episode);
        if (match < 0) { void stopPlayer(); notify('这条线路没有对应剧集，请重新选集。'); }
        else void startEpisode(data, index, match, old.video?.currentTime || old.position || 0);
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
  const named = line?.episodes.findIndex(episode => episode.name.trim() === name.trim()) ?? -1;
  return named >= 0 ? named : line?.episodes[index] ? index : -1;
}

function renderSources(data, candidates) {
  const row = $('#source-row'); if (!row) return;
  data.candidates = candidates;
  row.replaceChildren(node('span', '切换影视源', 'meta'));
  const unique = candidates.filter((item, index, items) => items.findIndex(other => other.source === item.source && String(other.id) === String(item.id)) === index);
  if (!unique.some(item => item.source === data.source && String(item.id) === String(data.id))) unique.unshift(data);
  for (const candidate of unique) {
    const selected = candidate.source === data.source && String(candidate.id) === String(data.id);
    const item = button(sourceName(candidate.source), () => void switchSource(data, candidate), `button${selected ? ' selected' : ''}`);
    item.disabled = selected; item.setAttribute('aria-pressed', String(selected)); row.append(item);
  }
  if (unique.length === 1) row.append(button('查找其他来源', () => goto('search', { q: data.title }), 'button subtle'));
}

async function switchSource(oldDetail, candidate) {
  const old = player;
  const position = old?.video?.currentTime || old?.position || 0;
  const stamp = routeVersion;
  try {
    const data = await api(`/api/detail?${new URLSearchParams({ source: candidate.source, id: candidate.id })}`);
    if (stamp !== routeVersion || detail !== oldDetail) return;
    const lineName = oldDetail.lines[old?.line ?? oldDetail.selectedLine]?.name;
    data.selectedLine = Math.max(0, data.lines.findIndex(line => line.name === lineName));
    void stopPlayer(); detail = data; renderDetail(data, findCandidates(oldDetail));
    history.replaceState(null, '', `#detail?${new URLSearchParams({ source: data.source, id: data.id })}`);
    if (old) {
      const episode = matchEpisode(data.lines[data.selectedLine], old.episodeName, old.episode);
      if (episode >= 0) void startEpisode(data, data.selectedLine, episode, position);
      else notify('这个来源没有对应剧集，请重新选集。');
    }
  } catch (error) { notify(error.message, true); }
}

function formatTime(seconds) {
  const value = Math.floor(Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

async function startEpisode(data, line, episode, position = 0) {
  const selected = data.lines[line]?.episodes[episode];
  if (!selected) return notify('当前剧集不可用，请重新选集。', true);
  const request = ++playVersion;
  const stamp = routeVersion;
  void stopPlayer(false);
  const host = $('#player-host'); host.replaceChildren(node('div', '正在准备播放…', 'loading'));
  try {
    const playback = await api(`/api/playback?${new URLSearchParams({ source: data.source, id: data.id, line, episode })}`);
    if (stamp !== routeVersion || request !== playVersion) return;
    data.selectedLine = line;
    player = { detail: data, line, episode, episodeName: selected.name, url: playback.url || selected.url, type: playback.type || selected.type, proxyUrl: playback.proxyUrl, position, mode: 'direct', catalog: true };
    mountPlayer(player); renderEpisodes(data);
  } catch (error) { if (stamp === routeVersion && request === playVersion) host.replaceChildren(empty('暂时无法播放', error.message, button('重试', () => void startEpisode(data, line, episode, position)))); }
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
  const speed = node('select'); speed.setAttribute('aria-label', '播放速度');
  for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) { const option = node('option', `${rate}×`); option.value = rate; speed.append(option); }
  speed.value = '1'; speed.addEventListener('change', () => { video.playbackRate = Number(speed.value); });
  const full = button('全屏', async () => {
    try { if (video.requestFullscreen) await video.requestFullscreen(); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else notify('当前浏览器不支持全屏。'); }
    catch (error) { notify(error.message, true); }
  });
  toolbar.append(speed, full);
  if (current.catalog) {
    const next = button('下一集 →', () => void nextEpisode(current)); next.disabled = !current.detail.lines[current.line]?.episodes[current.episode + 1]; toolbar.append(next);
  }
  if (current.proxyUrl) {
    const proxy = button('兼容转发', () => {
      current.position = video.currentTime || current.position; current.usedProxy = !current.usedProxy;
      proxy.textContent = current.usedProxy ? '切回直连' : '兼容转发'; proxy.classList.toggle('selected', current.usedProxy); loadMedia(current);
    }); proxy.title = '跨域或直连失败时，尝试服务器受限转发'; toolbar.append(proxy);
  }
  toolbar.append(externalLink('原链接 ↗', current.url));
  video.addEventListener('loadedmetadata', () => {
    if (player !== current) return;
    if (current.position > 0) {
      try { video.currentTime = Number.isFinite(video.duration) ? Math.min(current.position, Math.max(0, video.duration - 1)) : current.position; }
      catch { notify('当前线路无法跳转到保存的时间，请手动选择进度。'); }
      current.position = 0;
    }
  });
  video.addEventListener('pause', () => { if (player === current) void saveHistory(current); });
  video.addEventListener('ended', () => { if (player === current) { void saveHistory(current); void nextEpisode(current); } });
  video.addEventListener('playing', () => { if (player === current) { note.textContent = `${current.episodeName || current.detail.title} · 进度每 10 秒自动保存`; note.className = 'player-note'; } });
  video.addEventListener('waiting', () => { if (player === current) note.textContent = '正在缓冲…'; });
  video.addEventListener('error', () => { if (player === current) playbackError(current); });
  current.timer = setInterval(() => { if (player === current && !video.paused) void saveHistory(current); }, 10000);
  loadMedia(current); void saveHistory(current);
}

function playbackError(current) {
  if (player !== current) return;
  current.note.textContent = current.proxyUrl && !current.usedProxy ? '直连播放失败。可以尝试「兼容转发」、换线路或换影视源。' : '当前地址无法播放，请尝试换线路、换影视源或打开原链接。';
  current.note.className = 'player-note error-message';
}

function loadMedia(current) {
  if (hls) { hls.destroy(); hls = null; }
  const url = mediaUrl(current.usedProxy ? current.proxyUrl : current.url);
  if (!url) return playbackError(current);
  current.note.className = 'player-note'; current.note.textContent = '正在连接播放地址…';
  const video = current.video;
  if (current.type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
    if (!window.Hls?.isSupported()) { current.note.textContent = '这个浏览器不支持 HLS 播放，请更换浏览器或打开原链接。'; return; }
    hls = new window.Hls(); hls.loadSource(url); hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_event, data) => { if (data.fatal) playbackError(current); });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => { if (player === current) void video.play().catch(() => { current.note.textContent = '视频已准备好，点击播放器的播放按钮开始。'; }); });
  } else { video.src = url; void video.play().catch(() => { if (player === current && !video.error) current.note.textContent = '视频已准备好，点击播放器的播放按钮开始。'; }); }
}

async function nextEpisode(current) {
  if (!current.catalog) return;
  if (current.detail.lines[current.line]?.episodes[current.episode + 1]) await startEpisode(current.detail, current.line, current.episode + 1);
  else notify('已播放到这条线路的最后一集。');
}

function saveHistory(current) {
  const record = { ...fieldsOf(current.detail), line: current.line || 0, episode: current.episode || 0, url: current.url, mode: current.mode, ...(current.mode === 'parser' ? { parser: current.parser || '' } : { position: current.video?.currentTime || current.position || 0, duration: Number.isFinite(current.video?.duration) ? current.video.duration : 0 }) };
  library.history = [record, ...library.history.filter(item => item.key !== record.key)];
  const saved = historyQueue.catch(() => {}).then(() => api('/api/history', { method: 'POST', body: record }));
  historyQueue = saved;
  return saved.catch(error => { if (!current.saveFailed) { current.saveFailed = true; notify(`观看记录未保存：${error.message}`, true); } });
}

function stopPlayer(invalidate = true) {
  if (invalidate) playVersion++;
  const current = player; player = null;
  if (!current) return Promise.resolve();
  const save = saveHistory(current);
  clearInterval(current.timer);
  if (hls) { hls.destroy(); hls = null; }
  if (current.video) { current.video.pause(); current.video.removeAttribute('src'); current.video.load(); }
  if (current.frame) current.frame.src = 'about:blank';
  return save;
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

function renderSettings() {
  const draft = structuredClone(config);
  const page = document.createDocumentFragment();
  const tools = node('div', undefined, 'settings-actions');
  const save = button('保存全部设置', async () => {
    try {
      for (const kind of ['platforms', 'parsers', 'sources']) {
        const ids = new Set();
        for (const item of draft[kind]) {
          if (!item.id.trim() || !item.name.trim()) throw new Error('每项都需要填写标识和名称。');
          if (ids.has(item.id)) throw new Error(`标识重复：${item.id}`); ids.add(item.id);
          if (!(kind === 'parsers' && item.url === '') && !httpUrl(item.api || item.url)) throw new Error(`${item.name} 的地址必须是有效的 HTTP 或 HTTPS URL。`);
        }
      }
      save.disabled = true; config = await api('/api/config', { method: 'PUT', body: draft }); updateSourceStatus(); renderSettings(); notify('资源设置已保存');
    } catch (error) { notify(error.message, true); }
    finally { save.disabled = false; }
  }, 'button primary');
  const exportConfig = button('导出配置', async () => {
    try {
      const latest = await api('/api/config'); const blob = new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
      const link = node('a'); link.href = url; link.download = 'vipvideo-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('配置已导出，不包含密码和观看记录');
    } catch (error) { notify(error.message, true); }
  }, 'button');
  tools.append(save, exportConfig); page.append(tools, node('p', '新增、排序、停用后，点击「保存全部设置」。数据由家庭内所有设备共用。', 'settings-note'));
  const importer = node('section', undefined, 'settings-section'); importer.append(node('h2', '导入资源配置'), node('p', '支持 MoonTV / KatelyaTV 的 api_site JSON，以及本应用导出的配置。按标识合并；请只导入可信的公开资源。', 'muted'));
  const file = node('input', undefined, 'import-file'); file.type = 'file'; file.accept = '.json,application/json'; file.setAttribute('aria-label', '选择配置 JSON 文件');
  const json = node('textarea', undefined, 'config-json'); json.rows = 5; json.spellcheck = false; json.setAttribute('aria-label', '配置 JSON'); json.placeholder = '{"api_site":{"example":{"name":"示例影视源","api":"https://example.com/api.php/provide/vod/"}}}';
  file.addEventListener('change', async () => {
    try { if (file.files[0]) { if (file.files[0].size > 1048576) throw new Error('配置文件不能超过 1 MB。'); json.value = await file.files[0].text(); } }
    catch (error) { notify(error.message, true); }
  });
  const importButton = button('校验并导入', async () => {
    try { importButton.disabled = true; config = await api('/api/config/import', { method: 'POST', body: { config: JSON.parse(json.value) } }); updateSourceStatus(); renderSettings(); notify('资源配置已导入'); }
    catch (error) { notify(`导入失败：${error.message}`, true); }
    finally { importButton.disabled = false; }
  }, 'button');
  importer.append(file, json, importButton); page.append(importer);
  const descriptions = { sources: ['影视源', '填写 AppleCMS JSON 接口；搜索时只查询启用的源。', 'api'], platforms: ['平台入口', '首页展示的视频平台链接，不作为聚合搜索源。', 'url'], parsers: ['解析线路', '填写带 ?url= 等参数的视频解析地址前缀，也支持 {url} 占位符。', 'url'] };
  for (const [kind, [title, description, urlKey]] of Object.entries(descriptions)) {
    const panel = node('section', undefined, 'settings-section');
    const heading = node('div', undefined, 'section-heading'); heading.append(node('h2', title), button('＋ 添加', () => { draft[kind].push({ id: `${kind.slice(0, -1)}-${Date.now()}`, name: '', [urlKey]: '', enabled: true, ...(kind === 'platforms' ? { category: '视频' } : {}) }); drawRows(); }, 'button small'));
    panel.append(heading, node('p', description, 'muted'));
    const list = node('div', undefined, 'config-list'); panel.append(list);
    const drawRows = () => {
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
    drawRows(); page.append(panel);
  }
  content.replaceChildren(page);
}

function updateSourceStatus() {
  $('#source-status').textContent = `${config.sources.filter(source => source.enabled !== false).length} 个影视源`;
}

async function renderRoute() {
  if ($('#app-view').hidden) return;
  const stamp = ++routeVersion; void stopPlayer(); detail = null;
  const [view, rawQuery = ''] = location.hash.slice(1).split('?'); const params = new URLSearchParams(rawQuery);
  const titles = { home: '首页', search: '搜索影片', favorites: '我的收藏', history: '观看记录', settings: '资源设置', detail: '影片详情', link: '链接播放' };
  const selectedView = titles[view] ? view : 'home'; $('#page-title').textContent = titles[selectedView]; document.title = `${titles[selectedView]} · 映家`;
  document.querySelectorAll('nav a').forEach(link => { const active = link.dataset.view === selectedView; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  content.setAttribute('aria-busy', 'true');
  try {
    if (['home', 'favorites', 'history', 'detail'].includes(selectedView)) {
      await historyQueue.catch(error => console.warn('等待记录保存时失败', error));
      const latest = await api('/api/state');
      if (stamp !== routeVersion) return;
      library = latest;
    }
    if (selectedView === 'home') renderHome();
    else if (selectedView === 'favorites' || selectedView === 'history') renderLibrary(selectedView);
    else if (selectedView === 'settings') renderSettings();
    else if (selectedView === 'search') await renderSearch(params.get('q') || '', stamp);
    else if (selectedView === 'detail') await openDetail(params.get('source') || '', params.get('id') || '', stamp, params.get('resume') === '1');
    else if (selectedView === 'link') openLink(params.get('url') || '', params.get('resume') === '1');
  } catch (error) { if (stamp === routeVersion) content.replaceChildren(empty('暂时无法打开', error.message, button('返回首页', () => goto('home')))); }
  finally { if (stamp === routeVersion) content.setAttribute('aria-busy', 'false'); }
}

function showLogin() {
  routeVersion++; void stopPlayer(); $('#app-view').hidden = true; $('#login-view').hidden = false; $('#password').focus({ preventScroll: true });
}

async function boot() {
  const auth = await api('/api/auth');
  if (!auth.authenticated) { showLogin(); return; }
  [config, library] = await Promise.all([api('/api/config'), api('/api/state')]);
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
document.addEventListener('visibilitychange', () => { if (document.hidden && player) void saveHistory(player); });
window.addEventListener('pagehide', () => {
  if (!player) return;
  const current = player;
  const record = { ...fieldsOf(current.detail), line: current.line || 0, episode: current.episode || 0, url: current.url, mode: current.mode, ...(current.mode === 'parser' ? { parser: current.parser || '' } : { position: current.video?.currentTime || current.position || 0, duration: Number.isFinite(current.video?.duration) ? current.video.duration : 0 }) };
  void fetch('/api/history', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record), keepalive: true }).catch(error => console.warn('离开页面时未能保存观看记录', error));
});
void boot().catch(error => { $('#login-view').hidden = false; $('#login-error').textContent = error.message; });

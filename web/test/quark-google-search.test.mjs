import assert from 'node:assert/strict';
import test from 'node:test';
import { searchGoogleQuark } from '../lib/quark-google-search.mjs';
import * as webSearch from '../lib/quark-google-search.mjs';

const title = '测试影片', time = Date.parse('2026-10-14T00:00:00Z');
const link = (url, name = title + ' 夸克资源') => `<a href="${url}"><h3>${name}</h3></a>`;
const article = content => `<html><title>${title} 资源分享</title><article>${content}</article></html>`;
function fixture(search, pages = {}) {
  const calls = [];
  const read = async (url, duration, maxBytes, deadline) => {
    calls.push({ url, duration, maxBytes, deadline });
    const value = new URL(url).hostname === 'www.google.com' ? search : pages[url];
    if (value instanceof Error || value === undefined) throw value || new Error('unknown fixture');
    return value;
  };
  return { calls, read, now: () => time };
}

test('resource identity requires the primary title or a supplied alias and separates unnamed links', () => {
  const query = { title: '一路平安', aliases: ['Safe Journey'], year: '2026' };
  for (const [label, expected] of [
    ['【电影】一路平安 (2026) 4K HDR', 'matched'], ['Safe Journey (2026) 1080p', 'matched'],
    ['一路平安 · 页面日期 2025/10/14', 'matched'], ['一路平安 (2025) 1080p', 'unrelated'],
    ['一路超平安 (2026)', 'unrelated'], ['出入平安 (2026)', 'unrelated'], ['一路平安归来 (2026)', 'unrelated'],
    ['', 'unknown'], ['网盘资源链接', 'unknown'], ['未提供资源标题', 'unknown'],
  ]) assert.equal(webSearch.classifyQuarkCandidate(label, query), expected, label);
  assert.equal(webSearch.classifyQuarkCandidate('出入平安', { title: '平安' }), 'unrelated');
  assert.equal(webSearch.classifyQuarkCandidate('VITALITY (2017)', { title: '小丑回魂', aliases: ['IT'], year: '2017' }), 'unrelated');
  assert.equal(webSearch.classifyQuarkCandidate('遮天 动画持续更新至185集 全季合集2022-2026', { title: '遮天', year: '2023' }), 'matched');
  assert.equal(webSearch.classifyQuarkCandidate('遮天更新至185集2026年', { title: '遮天', year: '2023' }), 'matched');
  assert.equal(webSearch.classifyQuarkCandidate('银翼杀手2049 (2017)', { title: '银翼杀手 2049', year: '2017' }), 'matched');
});

test('a compact Chinese title and year require independent film-year evidence before matching a translated heading', () => {
  for (const [label, expected] of [
    ['希望2026 高清资源', 'matched'], ['希望 HOPE (2026) 夸克网盘', 'matched'],
    ['2026韩国电影希望Hope！科幻动作！k: 夸克网盘分享', 'matched'],
    ['希望 HOPE (2013) 夸克网盘', 'unrelated'], ['希望 HOPE 页面日期 2026/10/13', 'unrelated'],
    ['希望 HOPE 发布于2026', 'unrelated'], ['希望 HOPE (2013) 页面发布时间2026', 'unrelated'],
    ['希望归来 (2026)', 'unrelated'], ['希望 归来 (2026)', 'unrelated'], ['希望之歌 (2026)', 'unrelated'],
    ['希望：归来 (2026)', 'unrelated'], ['希望 HOPE RETURNS (2026)', 'unrelated'],
    ['希望 HOPE (2013) (2026)', 'unrelated'], ['其他电影介绍，希望 HOPE (2026)', 'unrelated'],
  ]) assert.equal(webSearch.classifyQuarkCandidate(label, { title: '希望2026' }), expected, label);
  assert.equal(webSearch.classifyQuarkCandidate('希望 HOPE (2026)', { title: '希望2026', year: '2013' }), 'unrelated');
  for (const title of ['2012', '1917']) assert.equal(webSearch.classifyQuarkCandidate(`${title} (2009)`, { title }), 'matched');
});

test('the shared Google URL requests newest web results without imposing a publication date cutoff', () => {
  const url = new URL(webSearch.googleQueryUrl('希望2026 夸克 网盘'));
  assert.equal(url.origin, 'https://www.google.com'); assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), '希望2026 夸克 网盘');
  assert.equal(url.searchParams.get('tbs'), 'sbd:1'); assert.equal(url.searchParams.get('udm'), '14');
});

test('exact title, official aliases and release year plan bounded search variants and later result pages', () => {
  assert.deepEqual(webSearch.quarkSearchQueries({ title: '希望2026', aliases: ['Hope', '호프'], year: '2026' }), ['"希望" 2026 夸克 网盘', '"Hope" 2026 夸克 网盘', '"호프" 2026 夸克 网盘']);
  assert.equal(webSearch.quarkSearchQueries({ title: '银翼杀手 2049', year: '2017' })[0], '"银翼杀手 2049" 2017 夸克 网盘');
  assert.equal(new URL(webSearch.googleQueryUrl('test', 2)).searchParams.get('start'), '20');
  assert.equal(new URL(webSearch.bingQueryUrl('test', 2)).searchParams.get('first'), '21');
});

test('Chinese Bing only trusts result headings, unwraps safe tracking targets and ignores navigation and snippet share links', () => {
  const encode = url => 'https://www.bing.com/ck/a?u=a1' + Buffer.from(url).toString('base64url');
  const block = (url, heading) => `<li class="b_algo"><h2><a href="${encode(url)}">${heading}</a></h2><p>2026-10-14</p></li>`;
  const raw = `<nav><a href="https://nav.example/">希望 2026 夸克</a></nav><ol>` +
    block('https://posts.example/correct', '2026韩国恐怖片《希望》夸克网盘') +
    block('http://127.0.0.1/secret', '希望 (2026) 资源') +
    block('https://user:password@posts.example/secret', '希望 (2026) 资源') +
    block('https://posts.example/wrong', '希望 (2013) 网盘') + '</ol>';
  assert.deepEqual(webSearch.extractQuarkSearchResults(raw, { engine: 'Bing', title: '希望', year: '2026' }), [{ url: 'https://posts.example/correct', name: '2026韩国恐怖片《希望》夸克网盘' }]);
  const rss = '<rss><channel><item><title>希望 (2026) 夸克网盘</title><link>https://posts.example/correct</link><description>相关推荐其他电影 https://pan.quark.cn/s/unrelated1</description></item></channel></rss>';
  assert.deepEqual(webSearch.extractQuarkSearchResults(rss, { engine: 'Bing', title: '希望', year: '2026' }).map(row => row.url), ['https://posts.example/correct']);
});

test('article links at the end accept generic action labels without borrowing recommendation dates', () => {
  const html = '<title>希望 (2026) 夸克网盘</title><script type="application/ld+json">{"headline":"其他电影","datePublished":"2026-10-14"}</script>' +
    '<article><h1>希望 (2026)</h1>' + '<p>正文介绍</p>'.repeat(100) +
    '<a href="https://pan.quark.cn/s/lastlink1">点击这里获取</a> 提取码：AB12</article><nav><time datetime="2026-10-14"></time><a href="https://pan.quark.cn/s/wrong123">希望 2026</a></nav>';
  assert.deepEqual(webSearch.extractQuarkArticle(html, { url: 'https://posts.example/hope', title: '希望', year: '2026', now: time }), { matched: true, rows: [{ url: 'https://pan.quark.cn/s/lastlink1?pwd=AB12', name: '希望 (2026) 夸克网盘' }] });
});

test('rendered Tencent post headings and labeled body hyperlinks bind the expected film to the actual share href', async () => {
  const name = '2026韩国电影希望Hope！科幻动作！k: 夸克网盘分享';
  const url = 'https://pd.qq.com/post/123456789', query = { title: '希望2026', now: time };
  const search = `<a href="${url}"><span>腾讯频道</span><h3>${name}</h3></a>`;
  assert.deepEqual(webSearch.extractQuarkSearchResults(search, query), [{ url, name }]);
  const html = `<title>腾讯频道</title><meta property="article:published_time" content="2026-10-13T12:00:00+08:00"><article><p><a href="https://pan.quark.cn/s/hope2026?utm_source=post">${name}</a> 提取码：A1B2</p><h2>其他电影</h2><a href="https://pan.quark.cn/s/wrong2026">夸克下载</a></article>`;
  const expected = { rows: [{ url: 'https://pan.quark.cn/s/hope2026?pwd=A1B2', name, publishedAt: Date.parse('2026-10-13T12:00:00+08:00') }], matched: true };
  assert.deepEqual(webSearch.extractQuarkArticle(html, { ...query, url }), expected);
  const input = fixture(search, { [url]: html });
  assert.deepEqual(await searchGoogleQuark('希望2026', input), expected.rows);
  const noTitle = `<title>腾讯频道</title><article><p>2026-10-13发布</p><a href="https://pan.quark.cn/s/hope2026">夸克下载</a></article>`;
  assert.deepEqual(webSearch.extractQuarkArticle(noTitle, { ...query, url }), { rows: [], matched: false });
});

test('Tencent post datePublished metadata and generic hyperlinks work at different positions within the actual main-body structure', () => {
  const name = '2026韩国电影希望Hope！科幻动作！k：[链接] 夸克网盘分享｜影视资源库｜腾讯频道';
  const query = { title: '希望2026', year: '2026', url: 'https://pd.qq.com/g/channel/post/public-post', now: time };
  for (const before of ['', '<div class="post-banner">公开帖子</div>', '<section><div>电影说明</div><div>分享请遵守频道规则</div></section>']) {
    const html = `<title>${name}</title><meta property="og:title" content="${name}"><meta itemprop="datePublished" content="2026-09-13T11:48:46+08:00"><main>${before}<div class="feed-content"><div class="short-textcontent-container-right"><span class="feed-detail-text">2026韩国电影希望Hope！科幻动作！k：</span><span class="link-container"><object class="object-height"><a href="https://pan.quark.cn/s/public123" class="link" rel="ugc nofollow">夸克网盘分享</a></object></span></div></div><div class="feed-info__detail__time">2026-09-13</div></main>`;
    assert.deepEqual(webSearch.extractQuarkArticle(html, query), {
      rows: [{ url: 'https://pan.quark.cn/s/public123', name, publishedAt: Date.parse('2026-09-13T11:48:46+08:00') }], matched: true,
    });
  }
});

test('nested recommendations cannot supply a body title, share or publication date', () => {
  const query = { title, url: 'https://posts.example/movie', now: time };
  const recommendation = `<section class="recommendations"><section><h1>${title}</h1></section><time datetime="2026-10-14"></time>${link('https://pan.quark.cn/s/related123', '夸克下载')}</section>`;
  assert.deepEqual(webSearch.extractQuarkArticle(`<title>影视分享站</title><main>${recommendation}<p>其他电影</p></main>`, query), { rows: [], matched: false });
  assert.deepEqual(webSearch.extractQuarkArticle(article(`${recommendation}<time datetime="2026-10-12"></time>${link('https://pan.quark.cn/s/correct123', '夸克下载')}`), query), {
    rows: [{ url: 'https://pan.quark.cn/s/correct123', name: title + ' 资源分享', publishedAt: Date.parse('2026-10-12') }], matched: true,
  });
});

test('a main film article cannot lend its title to recommendations or another film plain-text share', async () => {
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': article(`
    ${link('https://pan.quark.cn/s/correct123', '夸克下载')}
    <p>其他电影：https://pan.quark.cn/s/wrong12345</p>
    <section class="related"><h2>其他电影推荐</h2>${link('https://pan.quark.cn/s/related123', '夸克下载')}</section>`),
  });
  assert.deepEqual((await searchGoogleQuark(title, input)).map(row => row.url), ['https://pan.quark.cn/s/correct123']);
});

test('web search distinguishes unindexed titles, unreadable articles and pages without share links', async () => {
  const missing = fixture('<title>Google</title><p>No matching documents</p>');
  assert.match((await searchGoogleQuark(title, missing)).reason, /未找到.*公开网页/);
  const unreadable = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': Object.assign(new Error(), { quarkPoolReason: '搜索请求超时' }) });
  assert.match((await searchGoogleQuark(title, unreadable)).reason, /资源网页.*超时/);
  const withoutLinks = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': article('<p>电影介绍</p>') });
  assert.match((await searchGoogleQuark(title, withoutLinks)).reason, /已读取.*未找到.*分享/);
  const javascript = fixture('<title>Google Search</title><noscript><a href="/httpservice/retry/enablejs">Please enable JavaScript to use Google Search.</a></noscript>');
  assert.match((await searchGoogleQuark(title, javascript)).reason, /JavaScript.*未能读取/);
});

test('Google requests newest results without a date cutoff, following only three first-level results', async () => {
  const pages = Object.fromEntries([1, 2, 3, 4].map(id => [`https://posts.example/${id}`, article(link(`https://pan.quark.cn/s/abcdef${id}`))]));
  const input = fixture([
    link('/url?q=' + encodeURIComponent('https://posts.example/1')),
    link('/url?url=' + encodeURIComponent('https://posts.example/2')),
    link('https://posts.example/3'), link('https://posts.example/4'),
  ].join(''), pages);
  const rows = await searchGoogleQuark(title, input);
  assert.equal(rows.length, 3); assert.equal(input.calls.length, 4);
  const query = new URL(input.calls[0].url);
  assert.equal(query.origin, 'https://www.google.com'); assert.equal(query.pathname, '/search');
  assert.equal(query.searchParams.get('q'), `"${title}" 夸克 网盘`); assert.equal(query.searchParams.get('tbs'), 'sbd:1'); assert.equal(query.searchParams.get('udm'), '14');
  assert.deepEqual(input.calls.slice(1).map(call => call.url), ['https://posts.example/1', 'https://posts.example/2', 'https://posts.example/3']);
  for (const call of input.calls) { assert.equal(call.maxBytes, 512 * 1024); assert.equal(call.deadline, time + 3000); assert.ok(call.duration <= 2000); }
  assert.equal(input.calls[0].duration, 1500);
});

test('Google result headings are matched independently of their site attribution and breadcrumbs', async () => {
  const input = fixture(`<a href="https://posts.example/movie"><span>电影分享站 https://posts.example / resources / 2026</span><h3>${title} (2026) 4K夸克资源</h3></a>`, { 'https://posts.example/movie': article(link('https://pan.quark.cn/s/abcdef1', '夸克下载')) });
  assert.equal((await searchGoogleQuark(title, input)).length, 1);
  assert.equal(input.calls.length, 2);
});

test('a resource article with a site-wide document title still requires a matching main heading', async () => {
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': `<title>高清影视分享站</title><main><h1>${title} (2026) 夸克网盘</h1>${link('https://pan.quark.cn/s/abcdef1', '立即转存')}</main>` });
  assert.deepEqual((await searchGoogleQuark(title, input)).map(row => row.url), ['https://pan.quark.cn/s/abcdef1']);
});

test('an explicit article Open Graph title identifies the work when the document title is generic', async () => {
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': `<title>影视分享站</title><meta property="og:title" content="${title} (2026) 4K资源"><article>${link('https://pan.quark.cn/s/abcdef1', '夸克下载')}</article>` });
  assert.equal((await searchGoogleQuark(title, input)).length, 1);
});

test('an article opening can identify the work without trusting an unrelated footer mention', async () => {
  for (const [opening, expected] of [[title + ' (2026) 4K资源', 1], ['其他电影介绍，相关推荐：' + title, 0]]) {
    const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': `<title>高清影视分享站</title><article><p>${opening}</p>${link('https://pan.quark.cn/s/abcdef1', '夸克下载')}</article>` });
    assert.equal((await searchGoogleQuark(title, input)).length, expected);
  }
});

test('an empty canonical query tries one supplied alias within the original request budget', async () => {
  const calls = [];
  const rows = await searchGoogleQuark(title, { aliases: ['Winter and Summer', 'unused alias'], now: () => time, read: async (url, duration, maxBytes, deadline) => {
    calls.push({ url, deadline });
    if (new URL(url).hostname === 'www.google.com') return new URL(url).searchParams.get('q') === '"Winter and Summer" 夸克 网盘' ? link('https://posts.example/movie', 'Winter and Summer 资源') : '<title>Google</title>';
    return '<title>Winter and Summer 资源</title><a href="https://pan.quark.cn/s/abcdef1">夸克下载</a>';
  } });
  assert.equal(rows.length, 1); assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(0, 2).map(call => new URL(call.url).searchParams.get('q')), [`"${title}" 夸克 网盘`, '"Winter and Summer" 夸克 网盘']);
  assert.ok(calls.every(call => call.deadline === time + 3000));
});

test('an empty Google title-plus-Quark query falls back to title-plus-cloud-drive within the same budget', async () => {
  const calls = [];
  const rows = await searchGoogleQuark(title, { now: () => time, read: async (url, duration, maxBytes, deadline) => {
    calls.push({ url, deadline });
    const query = new URL(url).searchParams.get('q');
    if (query) return query === `"${title}" 网盘` ? link('https://posts.example/movie') : '<title>Google</title>';
    return article(link('https://pan.quark.cn/s/abcdef1'));
  } });
  assert.equal(rows.length, 1);
  assert.deepEqual(calls.slice(0, 2).map(call => new URL(call.url).searchParams.get('q')), [`"${title}" 夸克 网盘`, `"${title}" 网盘`]);
  assert.ok(calls.every(call => call.deadline === time + 3000));
});

test('Bing searches resource articles and follows relevant first-level pages as well as direct shares', async () => {
  const calls = [];
  const rows = await webSearch.searchBingQuark('一路超平安', { now: () => time, read: async (url, duration, maxBytes, deadline) => {
    calls.push({ url, duration, maxBytes, deadline });
    if (new URL(url).hostname.endsWith('.bing.com')) return '<rss><channel><item><title><![CDATA[一路超平安 (2026) 4K资源]]></title><link>https://posts.example/movie?from=bing&amp;id=1</link></item><item><title>其他电影</title><link>https://posts.example/other</link></item></channel></rss>';
    assert.equal(url, 'https://posts.example/movie?from=bing&id=1');
    return '<title>一路超平安 (2026) 4K资源</title><article><time datetime="2026-10-13"></time><a href="https://pan.quark.cn/s/abcdef1">夸克下载</a> 提取码: A1B2</article>';
  } });
  assert.deepEqual(rows, [{ url: 'https://pan.quark.cn/s/abcdef1?pwd=A1B2', name: '一路超平安 (2026) 4K资源', publishedAt: Date.parse('2026-10-13') }]);
  assert.equal(new URL(calls[0].url).searchParams.get('q'), '"一路超平安" 夸克 网盘');
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.deadline === time + 3000));
});

test('visible resource buttons can encode a canonical Quark share without crawling redirect services', async () => {
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': article('<a href="/go?url=https%3A%2F%2Fpan.quark.cn%2Fs%2Fabcdef1%3Fpwd%3DA1B2">夸克下载</a><a href="/go?url=http%3A%2F%2F127.0.0.1%2Fprivate">查看</a>') });
  assert.deepEqual((await searchGoogleQuark(title, input)).map(row => row.url), ['https://pan.quark.cn/s/abcdef1?pwd=A1B2']);
  assert.equal(input.calls.length, 2);
});

test('short English aliases cannot match a longer unrelated title', async () => {
  const input = fixture(link('https://posts.example/movie', 'VITALITY 资源') + link('https://posts.example/it', 'IT (2017) 资源'), {
    'https://posts.example/it': '<title>IT (2017) 网盘</title><a href="https://pan.quark.cn/s/abcdef1">夸克下载</a>',
  });
  assert.equal((await searchGoogleQuark('小丑回魂', { ...input, aliases: ['IT'] })).length, 1);
  assert.deepEqual(input.calls.slice(1).map(call => call.url), ['https://posts.example/it']);
});

test('Bing bounds article reads and refuses private pages, recursive crawling and XML entities', async () => {
  const calls = [], pages = [1, 2, 3, 4].map(id => `<item><title>${title}</title><link>https://posts.example/${id}</link></item>`).join('');
  const read = async url => {
    calls.push(url);
    if (new URL(url).hostname.endsWith('.bing.com')) return `<rss><channel><item><title>${title}</title><link>http://127.0.0.1/private</link></item>${pages}</channel></rss>`;
    return article(link('https://posts.example/child') + link('https://pan.quark.cn/s/abcdef1'));
  };
  assert.equal((await webSearch.searchBingQuark(title, { read, now: () => time })).length, 1);
  assert.equal(calls.length, 4); assert.ok(calls.every(url => !/127\.0\.0\.1|\/child$/.test(url)));
  await assert.rejects(webSearch.searchBingQuark(title, { now: () => time, read: async () => '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel></channel></rss>' }), /Bing 公开搜索暂不可用/);
});

test('a release-year hint never removes matching Google resources which omit that year', async () => {
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': article(link('https://pan.quark.cn/s/abcdef1')) });
  const rows = await searchGoogleQuark(title + ' 2026', input);
  assert.equal(rows.length, 1, 'previously the strict title-plus-year filter discarded this fixture before reading the page');
  assert.equal(input.calls.length, 2);
  assert.equal(new URL(input.calls[0].url).searchParams.get('q'), `"${title}" 2026 夸克 网盘`);
});

test('clean titles discover ongoing series collections without confusing publication dates with release years', async t => {
  for (const [keyword, queryTitle, pageTitle] of [
    ['遮天 2023', '遮天', '遮天 动漫合集 更新至160集 2026'],
    ['一念永恒', '一念永恒', '一念永恒 完结季 全季合集 2026'],
    ['希望2026', '希望2026', '希望2026 高清资源'],
  ]) await t.test(keyword, async () => {
    const input = fixture(link('https://posts.example/series', pageTitle), { 'https://posts.example/series': `<title>${pageTitle}</title><article><time datetime="2026-10-13"></time>${link('https://pan.quark.cn/s/abcdef1', queryTitle + ' 夸克全集')}</article>` });
    const rows = await searchGoogleQuark(keyword, input);
    assert.equal(new URL(input.calls[0].url).searchParams.get('q'), webSearch.quarkSearchQueries({ title: queryTitle, year: /\s+((?:19|20)\d{2})$/.exec(keyword)?.[1] })[0]);
    assert.equal(rows.length, 1); assert.equal(rows[0].publishedAt, Date.parse('2026-10-13'));
  });
});

test('explicit aliases can match public page titles while unrelated titles remain excluded', async () => {
  const input = fixture(link('https://posts.example/movie', 'Test Movie 资源') + link('https://posts.example/unrelated', 'Unrelated Movie 资源'), {
    'https://posts.example/movie': '<title>Test Movie 全集</title><a href="https://pan.quark.cn/s/abcdef1">Test Movie 下载</a>',
  });
  const rows = await searchGoogleQuark(title + ' 2026', { ...input, aliases: ['Test Movie', '', null] });
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Test Movie 下载');
  assert.deepEqual(input.calls.slice(1).map(call => call.url), ['https://posts.example/movie']);
});

test('a canonical title containing a spaced year-like number is preserved without confusing its release year', async () => {
  const input = fixture(link('https://posts.example/2049', '银翼杀手 2049（2017）夸克资源') + link('https://posts.example/1982', '银翼杀手（1982）夸克资源'), {
    'https://posts.example/2049': '<title>银翼杀手 2049（2017）4K资源</title><article><a href="https://pan.quark.cn/s/abcdef1">银翼杀手2049 夸克高清</a></article>',
  });
  const rows = await searchGoogleQuark(' 银翼杀手 2049 ', { ...input, titleOnly: true });
  assert.equal(new URL(input.calls[0].url).searchParams.get('q'), '"银翼杀手 2049" 夸克 网盘');
  assert.equal(rows.length, 1); assert.equal(rows[0].name, '银翼杀手2049 夸克高清');
  assert.deepEqual(input.calls.slice(1).map(call => call.url), ['https://posts.example/2049']);
});

test('HTML entities, direct Google links, visible share text and nearby extraction codes produce canonical shares', async () => {
  const input = fixture(link('https://pan.quark.cn/s/direct1?pwd=A1B2&amp;utm_source=google') + link('https://posts.example/movie'), {
    'https://posts.example/movie': article(`<meta property="article:published_time" content="2026-10-13T12:00:00+08:00">
      <a href="https:&#x2f;&#x2f;pan.quark.cn/s/abcdef1?utm_source=post">夸克下载链接</a> 提取码：X9Y8
      <p>https://pan.quark.cn/s/abcdef2?pwd=ABCD&amp;track=1</p>
      <p>http://pan.quark.cn/s/abcdef3 提取码: E5F6</p>`),
  });
  const rows = await searchGoogleQuark(title, input);
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/direct1?pwd=A1B2', 'https://pan.quark.cn/s/abcdef1?pwd=X9Y8', 'https://pan.quark.cn/s/abcdef2?pwd=ABCD', 'https://pan.quark.cn/s/abcdef3?pwd=E5F6']);
  assert.equal(rows[0].publishedAt, undefined);
  for (const row of rows.slice(1)) assert.equal(row.publishedAt, Date.parse('2026-10-13T12:00:00+08:00'));
});

test('only explicitly published page dates are returned, never copyright years or search snippets', async t => {
  for (const [label, metadata, expected] of [
    ['time', '<time datetime="2026-10-12">最近发布</time>', Date.parse('2026-10-12')],
    ['JSON-LD', '<script type="application/ld+json">{"@graph":[{"datePublished":"2026-10-11T11:22:33Z"}]}</script>', Date.parse('2026-10-11T11:22:33Z')],
    ['datePublished metadata', '<meta itemprop="datePublished" content="2026-09-13T11:48:46+08:00">', Date.parse('2026-09-13T11:48:46+08:00')],
    ['malformed JSON-LD', '<script type="application/ld+json">{"datePublished":</script>', undefined],
    ['copyright', '<footer>Copyright 2026. 2026-10-13发布资源</footer>', undefined],
    ['impossible day', '<time datetime="2026-02-31">日期</time>', undefined],
    ['future', '<time datetime="2099-10-12">日期</time>', undefined],
  ]) await t.test(label, async () => {
    const input = fixture(link('https://posts.example/movie') + '2026-10-14', { 'https://posts.example/movie': article(metadata + link('https://pan.quark.cn/s/abcdef1')) });
    const rows = await searchGoogleQuark(title, input);
    assert.equal(rows.length, 1); assert.equal(rows[0].publishedAt, expected);
  });
});

test('navigation, account pages, URL credentials, private targets, scripts and unrelated titles are ignored', async () => {
  const search = [
    link('https://accounts.google.com/Login'), link('/search?q=' + encodeURIComponent(title)),
    link('https://webcache.googleusercontent.com/a'), link('https://127.0.0.1/a'), link('http://localhost/a'), link('http://pansou:8888/api/search'),
    link('https://user:password@posts.example/a'), link('javascript:alert(1)'),
    link('https://posts.example/a?api_key=secret'), link('https://posts.example/unrelated', '别的电影'),
    `<script>${link('https://posts.example/script')}</script>`, link('https://posts.example/movie'),
  ].join('');
  const input = fixture(search, { 'https://posts.example/movie': article(`
    <script>const url = 'https://pan.quark.cn/s/script1';</script>
    <template>${link('https://pan.quark.cn/s/hidden1')}</template>
    <!-- ${link('https://pan.quark.cn/s/comment1')} -->
    ${link('https://pan.quark.cn/s/other12', '其他电影分享')}
    ${link('https://pan.quark.cn.evil.example/s/fake123')}
    ${link('https://pan.quark.cn/s/abcdef1')}`) });
  const rows = await searchGoogleQuark(title, input);
  assert.deepEqual(input.calls.slice(1).map(call => call.url), ['https://posts.example/movie']);
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/abcdef1']);
});

test('a misleading search result cannot supply shares from an unrelated page title', async () => {
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': `<title>其他电影资源</title>${link('https://pan.quark.cn/s/abcdef1')}` });
  assert.deepEqual(await searchGoogleQuark(title, input), []);
});

test('Google CAPTCHA and transport errors fail safely without retries or exposing upstream errors', async t => {
  for (const value of ['<div class="g-recaptcha">verify</div>', 'Our systems have detected unusual traffic', new Error('Cookie=secret private-url')]) await t.test(String(value), async () => {
    const input = fixture(value);
    await assert.rejects(searchGoogleQuark(title, input), error => error.message === 'Google 公开搜索暂不可用，请稍后重试');
    assert.equal(input.calls.length, 1);
  });
  const empty = fixture('<html><title>Google</title><p>No matching documents</p></html>');
  assert.deepEqual(await searchGoogleQuark(title, empty), []);
});

test('Google preserves classified reader failures and error codes while keeping unknown messages private', async t => {
  for (const upstream of [
    Object.assign(new Error('private Cookie=secret'), { quarkPoolReason: '搜索请求超时' }),
    Object.assign(new Error('private Cookie=secret'), { code: 'ENOTFOUND' }),
    new Error('private Cookie=secret', { cause: Object.assign(new Error('private URL'), { code: 'ENETUNREACH' }) }),
    new Error('private Cookie=secret'),
  ]) await t.test(upstream.quarkPoolReason || upstream.code || upstream.cause?.code || 'unknown', async () => {
    const input = fixture(upstream);
    await assert.rejects(searchGoogleQuark(title, input), error => {
      assert.equal(error.message, 'Google 公开搜索暂不可用，请稍后重试');
      assert.equal(error.cause, upstream);
      assert.equal(error.quarkPoolReason, upstream.quarkPoolReason);
      assert.equal(/private|Cookie|secret/.test(JSON.stringify(error)), false);
      return true;
    });
    assert.equal(input.calls.length, 1);
  });
});

test('Google validation pages report a fixed reason without parsing hidden resources', async () => {
  const input = fixture('<title>安全验证</title>private Cookie=secret ' + link('https://pan.quark.cn/s/hidden1'));
  await assert.rejects(searchGoogleQuark(title, input), error => {
    assert.equal(error.quarkPoolReason, '搜索页面要求登录或人机验证，已停止自动读取');
    assert.equal(/private|Cookie|secret|hidden1/.test(JSON.stringify(error)), false);
    return true;
  });
  assert.equal(input.calls.length, 1);
});

test('a slower search page shares the original three-second budget with follow-up pages', async () => {
  let current = time;
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': article(link('https://pan.quark.cn/s/abcdef1')) });
  const rows = await searchGoogleQuark(title, { now: () => current, read: async (...args) => {
    const html = await input.read(...args);
    if (input.calls.length === 1) { assert.equal(args[1], 1500); current += 1400; }
    return html;
  } });
  assert.equal(rows.length, 1);
  assert.equal(input.calls[1].duration, 1600);
  assert.ok(input.calls.every(call => call.deadline === time + 3000));
});

test('individual public-page failures and login challenges preserve other results without recursive crawling', async () => {
  const input = fixture(link('https://posts.example/error') + link('https://posts.example/login') + link('https://posts.example/movie'), {
    'https://posts.example/error': new Error('HTTP 403'),
    'https://posts.example/login': '<title>登录才能查看</title>' + link('https://pan.quark.cn/s/hidden1'),
    'https://posts.example/movie': article(link('https://posts.example/child') + link('https://pan.quark.cn/s/abcdef1')),
  });
  assert.deepEqual((await searchGoogleQuark(title, input)).map(row => row.url), ['https://pan.quark.cn/s/abcdef1']);
  assert.equal(input.calls.length, 4); assert.equal(input.calls.some(call => call.url.endsWith('/child')), false);
});

test('a supplied deadline bounds every request and results after expiration are discarded', async () => {
  let current = time;
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': article(link('https://pan.quark.cn/s/abcdef1')) });
  const read = async (...args) => { const html = await input.read(...args); current += 600; return html; };
  const rows = await searchGoogleQuark(title, { read, now: () => current, deadline: time + 1000 });
  assert.deepEqual(rows, []); assert.equal(input.calls.length, 2);
  assert.equal(input.calls[0].duration, 1000); assert.equal(input.calls[1].duration, 400);
  assert.ok(input.calls.every(call => call.deadline === time + 1000));
  assert.deepEqual(await searchGoogleQuark(title, { read, now: () => current, deadline: time }), []);
});

test('oversized HTML cannot be parsed as a successful page', async () => {
  const huge = 'a'.repeat(512 * 1024 + 1), search = fixture(huge);
  await assert.rejects(searchGoogleQuark(title, search), /Google 公开搜索暂不可用/);
  const input = fixture(link('https://posts.example/movie'), { 'https://posts.example/movie': huge + link('https://pan.quark.cn/s/abcdef1') });
  assert.deepEqual(await searchGoogleQuark(title, input), []);
});

test('duplicates retain an extraction code and invalid inputs cause no network request', async () => {
  const input = fixture(link('https://pan.quark.cn/s/abcdef1') + link('https://pan.quark.cn/s/abcdef1?pwd=X1Y2') + link('https://posts.example/movie'), {
    'https://posts.example/movie': article('<time datetime="2026-10-13"></time>' + link('https://pan.quark.cn/s/abcdef1')),
  });
  const rows = await searchGoogleQuark(title, input);
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/abcdef1?pwd=X1Y2']);
  assert.equal(rows[0].publishedAt, Date.parse('2026-10-13'), 'a verified page date augments a duplicate direct Google link');
  input.calls.length = 0;
  for (const value of ['', '   ', '!!!', null, 'a'.repeat(1001)]) assert.deepEqual(await searchGoogleQuark(value, input), []);
  assert.equal(input.calls.length, 0);
});

test('duplicate dated pages keep the latest publication and password independently of completion order', async t => {
  for (const [label, order, olderDate, olderPwd, newerPwd, expectedPwd] of [
    ['older then newer, both protected', ['old', 'new'], '2026-10-12', 'OLD1', 'NEW2', 'NEW2'],
    ['newer then older, both protected', ['new', 'old'], '2026-10-12', 'OLD1', 'NEW2', 'NEW2'],
    ['newer without password retains old code', ['old', 'new'], '2026-10-12', 'OLD1', '', 'OLD1'],
    ['older password fills latest unprotected link', ['new', 'old'], '2026-10-12', 'OLD1', '', 'OLD1'],
    ['dated code replaces unverified code', ['old', 'new'], '', 'OLD1', 'NEW2', 'NEW2'],
    ['unverified code cannot replace dated code', ['new', 'old'], '', 'OLD1', 'NEW2', 'NEW2'],
  ]) await t.test(label, async () => {
    const page = (date, pwd, name) => article((date ? `<time datetime="${date}"></time>` : '') + link(`https://pan.quark.cn/s/abcdef1${pwd ? '?pwd=' + pwd : ''}`, name));
    const input = fixture(order.map(key => link('https://posts.example/' + key)).join(''), {
      'https://posts.example/old': page(olderDate, olderPwd, title + ' 旧资源'),
      'https://posts.example/new': page('2026-10-13', newerPwd, title + ' 新资源'),
    });
    const rows = await searchGoogleQuark(title, input);
    assert.equal(rows.length, 1); assert.equal(rows[0].publishedAt, Date.parse('2026-10-13'));
    assert.equal(rows[0].url, 'https://pan.quark.cn/s/abcdef1?pwd=' + expectedPwd);
    assert.equal(rows[0].name, title + ' 新资源');
  });
});

test('a newer password is compared with the password own date instead of a later unprotected post', async () => {
  const page = (date, pwd) => article(`<time datetime="${date}"></time>` + link('https://pan.quark.cn/s/abcdef1' + (pwd ? '?pwd=' + pwd : ''), title + ' ' + date));
  const input = fixture(['old', 'latest', 'middle'].map(key => link('https://posts.example/' + key)).join(''), {
    'https://posts.example/old': page('2026-10-11', 'OLD1'),
    'https://posts.example/latest': page('2026-10-13', ''),
    'https://posts.example/middle': page('2026-10-12', 'NEW2'),
  });
  const rows = await searchGoogleQuark(title, input);
  assert.deepEqual(rows, [{ url: 'https://pan.quark.cn/s/abcdef1?pwd=NEW2', name: title + ' 2026-10-13', publishedAt: Date.parse('2026-10-13') }]);
});

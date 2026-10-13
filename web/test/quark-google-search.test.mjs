import assert from 'node:assert/strict';
import test from 'node:test';
import { searchGoogleQuark } from '../lib/quark-google-search.mjs';

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

test('Google requests the title plus Quark and best-effort date order, following only three first-level results', async () => {
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
  assert.equal(query.searchParams.get('q'), title + ' 夸克'); assert.equal(query.searchParams.get('tbs'), 'sbd:1');
  assert.deepEqual(input.calls.slice(1).map(call => call.url), ['https://posts.example/1', 'https://posts.example/2', 'https://posts.example/3']);
  for (const call of input.calls) { assert.equal(call.maxBytes, 512 * 1024); assert.equal(call.deadline, time + 3000); assert.ok(call.duration <= 1800); }
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

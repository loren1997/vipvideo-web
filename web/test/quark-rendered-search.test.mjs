import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuarkRenderedSearch } from '../lib/quark-rendered-search.mjs';
import { createQuarkBrowserSearch } from '../lib/quark-browser-client.mjs';
import { createBrowserWorker } from '../browser-worker.mjs';
import http from 'node:http';

const query = { title: '希望2026', year: '2026', aliases: [] };
const article = (id, date, position = 0) => `<html><head><meta property="og:title" content="2026韩国电影希望Hope！科幻动作！"><meta itemprop="datePublished" content="${date}"></head><body><main><p>2026韩国电影希望Hope！科幻动作！</p>${'<p>正文介绍</p>'.repeat(position)}<div><span><a href="https://pan.quark.cn/s/${id}">夸克网盘分享</a></span></div></main><aside><a href="https://pan.quark.cn/s/other0000">无关资源</a></aside></body></html>`;
const serp = '<a href="https://public.example/older"><h3>希望 HOPE (2026) 夸克</h3></a><a href="https://public.example/newer"><h3>2026韩国电影希望Hope！夸克网盘分享</h3></a><a href="https://public.example/wrong"><h3>希望 (2013) 夸克网盘</h3></a>';
const bingSerp = '<ol><li class="b_algo"><h2><a href="https://public.example/older">希望 HOPE (2026) 夸克网盘</a></h2></li><li class="b_algo"><h2><a href="https://public.example/newer">2026韩国电影希望Hope！夸克网盘分享</a></h2></li></ol>';

test('Google verification cools down across films and pages while Bing continues, then a ready search resets backoff', async () => {
  let clock = 1000, googleCalls = 0, bingCalls = 0, verified = false;
  const search = createQuarkRenderedSearch({ now: () => clock,
    render: async url => {
      assert.ok(url.includes('google.com/search')); googleCalls++;
      return { url, html: verified ? '<a href="https://pan.quark.cn/s/google26"><h3>希望 (2026) 夸克网盘</h3></a>' : '<title>安全验证</title><div class="g-recaptcha"></div>' };
    },
    read: async url => {
      assert.ok(url.includes('bing.com/search')); bingCalls++;
      const other = new URL(url).searchParams.get('q').includes('八仙');
      return { url, html: `<rss><channel><item><title>${other ? '八仙！' : '希望'} (2026) 夸克网盘</title><link>https://pan.quark.cn/s/${other ? 'bing0002' : 'bing0001'}</link></item></channel></rss>` };
    },
  });
  assert.ok((await search(query)).some(row => row.url.endsWith('bing0001')));
  const initialBingCalls = bingCalls;
  assert.ok((await search({ title: '八仙！', year: '2026', page: 1 })).some(row => row.url.endsWith('bing0002')));
  assert.equal(googleCalls, 1); assert.ok(bingCalls > initialBingCalls);
  clock += 59999;
  await search({ ...query, page: 2 }); assert.equal(googleCalls, 1);
  clock++; verified = true;
  assert.ok((await search(query)).some(row => row.url.endsWith('google26'))); assert.equal(googleCalls, 2);
  verified = false;
  await search(query); assert.equal(googleCalls, 3);
  clock += 60000;
  await search(query); assert.equal(googleCalls, 4, 'a ready SERP resets the next pause to one minute');
});

test('a concurrent film skips busy Google and continues Bing, and cancellation releases the Google slot', async () => {
  let googleCalls = 0;
  const controller = new AbortController();
  const search = createQuarkRenderedSearch({
    render: async (url, { signal }) => {
      assert.ok(url.includes('google.com/search')); googleCalls++;
      if (googleCalls === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { url, html: '<a href="https://pan.quark.cn/s/ready026"><h3>希望 (2026) 夸克网盘</h3></a>' };
    },
    read: async url => ({ url, html: '<rss><channel><item><title>八仙！ (2026) 夸克网盘</title><link>https://pan.quark.cn/s/busy0026</link></item></channel></rss>' }),
  });
  const first = search(query, { signal: controller.signal });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const second = await search({ title: '八仙！', year: '2026' });
    assert.deepEqual(second.map(row => row.url), ['https://pan.quark.cn/s/busy0026']); assert.equal(googleCalls, 1);
    controller.abort(new Error('cancel first Google search'));
    await assert.rejects(first, /cancel first Google search/);
    assert.ok((await search(query)).some(row => row.url.endsWith('ready026'))); assert.equal(googleCalls, 2);
  } finally { controller.abort(); await first.catch(() => {}); }
});

test('article verification and Google JavaScript, timeout or browser-busy responses never create rate-limit cooldown', async t => {
  for (const kind of ['article403', 'javascript', 'timeout', 'busy']) await t.test(kind, async () => {
    let googleCalls = 0, articleCalls = 0;
    const search = createQuarkRenderedSearch({
      render: async url => {
        if (!url.includes('google.com/search')) throw Object.assign(new Error('article HTTP 403'), { quarkPoolReason: 'browserBlocked' });
        googleCalls++;
        if (kind === 'timeout' || kind === 'busy') throw Object.assign(new Error('temporary failure'), { quarkPoolReason: kind === 'timeout' ? 'browserTimeout' : 'browserBusy' });
        return { url, html: kind === 'javascript' ? '<title>Google Search</title><a href="/httpservice/retry/enablejs">Please enable JavaScript to use Google Search.</a>' : '<a href="https://public.example/denied"><h3>希望 (2026) 夸克网盘</h3></a>' };
      },
      read: async url => {
        if (url.includes('bing.com')) return { url, html: '<rss><channel></channel></rss>' };
        articleCalls++; throw Object.assign(new Error('article HTTP 403'), { status: 403 });
      },
    });
    await search(query); await search(query);
    assert.equal(googleCalls, 2, 'only a blocked Google SERP may pause the next search');
    if (kind === 'article403') assert.equal(articleCalls, 2);
  });
});

test('Google SERP browser-blocked and HTTP 403 or 429 failures pause later films without exposing upstream details', async t => {
  for (const fields of [{ quarkPoolReason: 'browserBlocked' }, { httpStatus: 403 }, { httpStatus: 429 }]) await t.test(JSON.stringify(fields), async () => {
    let googleCalls = 0;
    const search = createQuarkRenderedSearch({
      render: async url => { assert.ok(url.includes('google.com/search')); googleCalls++; throw Object.assign(new Error('private upstream detail'), fields); },
      read: async url => ({ url, html: '<rss><channel></channel></rss>' }),
    });
    const first = await search(query), second = await search({ title: '八仙！', year: '2026' });
    assert.equal(googleCalls, 1); assert.match(first.reason, /暂缓重试/); assert.match(second.reason, /暂缓重试/);
    assert.doesNotMatch(first.reason + second.reason, /private upstream detail/);
  });
});

test('rendered search resolves a matching roundup block without borrowing neighbouring films or Baidu passwords', async () => {
  const articleUrl = 'https://www.sina.cn/news/detail/1234567890123456.html', calls = [];
  const html = '<title>多部影片合集</title><article>🔥其他影片 (2026)<br/>夸克：http://t.cn/Other001<br/><br/>🔥八仙！ (2026)（1080P）<br/>百度：http://t.cn/Baidu001 提取码:8888<br/>夸克：http://t.cn/Quark001<br/><br/>🔥奥德赛<br/>夸克：http://t.cn/Other002<br/><br/></article>';
  const search = createQuarkRenderedSearch({
    render: async url => {
      assert.ok(url.includes('google.com/search'), 'successful static article resolution needs no article browser');
      return { url, html: '<a href="' + articleUrl + '"><h3>🔥其他影片 (2026) 夸克 🔥八仙！ (2026)</h3></a>' };
    },
    read: async (url, options) => {
      calls.push({ url, deadline: options.deadline });
      if (url.includes('bing.com/search')) return { url, html: '<rss><channel></channel></rss>' };
      if (url === articleUrl) return { url, html };
      assert.equal(url, 'http://t.cn/Quark001'); return { url: 'https://pan.quark.cn/s/dynamic26', html: '' };
    },
  });
  const rows = await search({ title: '八仙！', year: '2026', aliases: [] });
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/dynamic26']);
  assert.equal(rows[0].url.includes('8888'), false);
  assert.deepEqual(calls.filter(row => row.url.includes('t.cn')).map(row => row.url), ['http://t.cn/Quark001']);
});

test('a dynamic roundup readiness callback stays synchronous while short-link network resolution happens afterwards', async () => {
  const articleUrl = 'https://public.example/roundup', calls = [];
  const html = '<article>🔥八仙！ (2026)<br/>夸克：http://t.cn/Quark001<br/><br/>🔥其他影片<br/>夸克：http://t.cn/Other001<br/><br/></article>';
  let ready = false;
  const search = createQuarkRenderedSearch({
    render: async (url, options) => {
      if (url.includes('google.com/search')) return { url, html: '<a href="' + articleUrl + '"><h3>八仙！ (2026) 夸克网盘</h3></a>' };
      assert.equal(url, articleUrl);
      const result = { url, html };
      const readiness = options.waitForShare(result);
      assert.equal(typeof readiness, 'boolean'); assert.equal(readiness, true);
      assert.equal(calls.some(value => value.includes('t.cn')), false);
      ready = true; return result;
    },
    read: async url => {
      calls.push(url);
      if (url.includes('bing.com/search')) return { url, html: '<rss><channel></channel></rss>' };
      if (url === articleUrl) return { url, html: '<script>app()</script>' };
      assert.equal(ready, true); assert.equal(url, 'http://t.cn/Quark001');
      return { url: 'https://pan.quark.cn/s/rendered26', html: '' };
    },
  });
  assert.deepEqual((await search({ title: '八仙！', year: '2026', aliases: [] })).map(row => row.url), ['https://pan.quark.cn/s/rendered26']);
});

test('a failed roundup short link is reported safely by the rendered search', async () => {
  const articleUrl = 'https://public.example/roundup';
  const html = '<article>🔥八仙！ (2026)<br/>夸克：http://t.cn/Quark001<br/><br/>🔥其他影片<br/>夸克：http://t.cn/Other001<br/><br/></article>';
  const search = createQuarkRenderedSearch({
    render: async (url, options) => url.includes('google.com/search')
      ? { url, html: '<a href="' + articleUrl + '"><h3>八仙！ (2026) 夸克网盘</h3></a>' }
      : { url, html },
    read: async url => {
      if (url.includes('bing.com/search')) return { url, html: '<rss><channel></channel></rss>' };
      if (url === articleUrl) return { url, html };
      throw Error('sensitive upstream message');
    },
  });
  const found = await search({ title: '八仙！', year: '2026', aliases: [] });
  assert.equal(found.length, 0); assert.ok(found.reason.includes('公开短链接暂时无法读取'));
  assert.ok(!found.reason.includes('sensitive upstream message'));
});

test('advanced Google search opens matching articles, extracts anchors at any position, and sorts by actual publication time', async () => {
  const calls = [];
  const search = createQuarkRenderedSearch({ render: async url => {
    calls.push(url);
    return { url, html: url.includes('google.com/search') ? serp : article(url.endsWith('older') ? 'older0000' : 'newer0000', url.endsWith('older') ? '2026-09-01' : '2026-10-01', url.endsWith('older') ? 0 : 20) };
  } });
  const rows = await search(query);
  assert.equal(new URL(calls[0]).searchParams.get('q'), '希望 2026 夸克 网盘');
  assert.equal(new URL(calls[0]).searchParams.get('tbs'), 'sbd:1');
  assert.equal(new URL(calls[0]).searchParams.has('udm'), false); assert.equal(new URL(calls[0]).searchParams.has('num'), false);
  assert.deepEqual(rows.map(row => new URL(row.url).pathname), ['/s/newer0000', '/s/older0000']);
  assert.equal(calls.length, 3); assert.ok(!calls.some(url => url.endsWith('wrong')));
});

test('Google opaque result jumps use the reader final article URL and recheck the film year', async () => {
  const jump = 'https://www.google.com/goto?url=' + 'D'.repeat(40), calls = [];
  const google = `<div class="MjjYud"><a class="zReHs" href="${jump}"><h3 class="LC20lb">【韩影】《希望HOPE (2026)》【1080P】【内嵌/内封中字】</h3><cite>腾讯频道 https://pd.qq.com › post</cite></a></div>`;
  const search = createQuarkRenderedSearch({ read: async url => {
    calls.push(url);
    if (url === jump) return { url: 'https://pd.qq.com/g/public-channel/post/hope', html: article('jump2026', '2026-10-01') };
    assert.notEqual(new URL(url).hostname, 'www.google.com');
    return { url, html: '<rss><channel></channel></rss>' };
  }, render: async url => { assert.ok(url.includes('google.com/search')); return { url, html: google }; } });
  const rows = await search({ title: '希望', aliases: ['HOPE', '호프'], year: '2026' });
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/jump2026']);
  assert.equal(calls.filter(url => url === jump).length, 1);
  assert.ok(rows.every(row => !row.googleRedirect && !row.url.includes('/goto')));
});

test('Google jump readers cannot substitute Google, private, login, undated or wrong-year article results', async () => {
  const jump = 'https://www.google.com/goto?url=' + 'E'.repeat(40);
  const google = `<a href="${jump}"><h3>希望 HOPE (2026) 夸克网盘</h3></a>`;
  const content = article('blocked1', '2026-10-01');
  for (const result of [
    { url: jump, html: content }, { html: content }, { url: 'https://accounts.google.com/login', html: content },
    { url: 'http://127.0.0.1/post', html: content }, { url: 'https://public.example/post', html: '<title>登录</title>' + content },
    { url: 'https://public.example/post', html: content.replace(/2026韩国电影希望Hope！科幻动作！/g, '希望 HOPE (2013)') },
    { url: 'https://public.example/post', html: content.replace(/2026韩国电影希望Hope！科幻动作！/g, '希望 夸克网盘') },
  ]) {
    const search = createQuarkRenderedSearch({ read: async url => url === jump ? result : { url, html: '<rss><channel></channel></rss>' }, render: async url => url.includes('google.com/search') ? { url, html: google } : result });
    assert.deepEqual((await search({ title: '希望', aliases: ['HOPE'], year: '2026' })).map(row => row.url), []);
  }
});

test('Google renders once without HTTP preflight while article reads render only incomplete pages', async () => {
  let renders = 0;
  const search = createQuarkRenderedSearch({ read: async url => { assert.ok(!url.includes('google')); return { url, html: url.includes('bing') ? '<rss><channel></channel></rss>' : article('http0000', '2026-09-13', 10) }; }, render: async url => { renders++; assert.ok(url.includes('google')); return { url, html: serp }; } });
  assert.equal((await search(query)).length, 1); assert.equal(renders, 1); renders = 0;
  const fallback = createQuarkRenderedSearch({ read: async url => { assert.ok(!url.includes('google')); return { url, html: url.includes('bing') ? bingSerp : '' }; }, render: async url => { renders++; assert.ok(!url.includes('bing')); return { url, html: url.includes('google') ? serp : article('jslink00', '2026-09-13') }; } });
  assert.equal((await fallback(query)).length, 1); assert.equal(renders, 2);
});

test('article prefetch reads later static shares before rendering no-link pages and never exceeds two reads', async () => {
  const urls = ['first', 'second', 'third', 'fourth', 'fifth'], calls = new Map();
  let active = 0, maximum = 0, renders = 0;
  const search = createQuarkRenderedSearch({
    read: async url => {
      if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
      const key = new URL(url).pathname.slice(1);
      calls.set(key, (calls.get(key) || 0) + 1); maximum = Math.max(maximum, ++active);
      try {
        await new Promise(resolve => setTimeout(resolve, key === 'first' ? 40 : 5));
        return { url, html: key === 'fourth' ? article('fourth26', '2026-10-14') : key === 'fifth' ? article('fifth026', '2026-10-13') : '<title>希望 (2026)</title><article>只有影片介绍，没有网盘链接。</article>' };
      } finally { active--; }
    },
    render: async url => {
      renders++; assert.ok(url.includes('google.com/search'));
      return { url, html: urls.map(key => `<a href="https://public.example/${key}"><h3>希望 (2026) 夸克网盘</h3></a>`).join('') };
    },
  });
  const rows = await search(query);
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/fourth26', 'https://pan.quark.cn/s/fifth026']);
  assert.equal(maximum, 2); assert.equal(active, 0); assert.equal(renders, 1);
  assert.deepEqual([...calls], urls.map(key => [key, 1]));
});

test('article prefetch reaches the ninth matched result when earlier articles fail or contain no share', async () => {
  const reads = []; let active = 0, maximum = 0;
  const search = createQuarkRenderedSearch({
    render: async url => {
      assert.ok(url.includes('google.com/search'), '已找到后续静态分享后不额外渲染文章');
      return { url, html: Array.from({ length: 9 }, (_, index) => `<a href="https://public.example/article-${index + 1}"><h3>希望 (2026) 夸克网盘</h3></a>`).join('') };
    },
    read: async (url, { deadline }) => {
      if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
      reads.push({ url, deadline, startedAt: Date.now() }); maximum = Math.max(maximum, ++active);
      try {
        await new Promise(resolve => setImmediate(resolve));
        const index = Number(/article-(\d+)$/.exec(url)?.[1]);
        if (index < 9 && index % 2) throw Object.assign(new Error('public article unavailable'), { status: 403 });
        return { url, html: index === 9 ? article('ninth026', '2026-10-01') : '<title>希望 (2026)</title><article>影片介绍，没有分享。</article>' };
      } finally { active--; }
    },
  });
  const rows = await search(query);
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/ninth026']);
  assert.equal(reads.length, 9); assert.equal(maximum, 2); assert.equal(active, 0);
  assert.equal(new Set(reads.map(call => call.deadline)).size, 1, '所有文章仍共享同一读取截止时间');
  assert.ok(reads[0].deadline <= reads[0].startedAt + 8000, '增加候选数不能扩大8秒文章读取预算');
});

test('prefetched script shells render first without repeating reads or rendering complete no-link pages afterward', async () => {
  const calls = [], rendered = [];
  const search = createQuarkRenderedSearch({
    read: async url => {
      if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
      calls.push(new URL(url).pathname);
      return { url, html: url.endsWith('shell') ? '<script>setTimeout(()=>location.reload(),1200)</script>' : '<title>希望 (2026)</title><article>完整的影片介绍，但资源入口仍未加载。</article>' };
    },
    render: async url => {
      if (url.includes('google.com/search')) return { url, html: '<a href="https://public.example/full"><h3>希望 (2026) 夸克网盘</h3></a><a href="https://public.example/shell"><h3>希望 (2026) 夸克网盘</h3></a>' };
      rendered.push(new URL(url).pathname); assert.ok(url.endsWith('shell'));
      return { url, html: article('shell026', '2026-10-01') };
    },
  });
  assert.deepEqual((await search(query)).map(row => row.url), ['https://pan.quark.cn/s/shell026']);
  assert.deepEqual(calls, ['/full', '/shell']); assert.deepEqual(rendered, ['/shell']);
});

test('complete article introductions can still load public shares dynamically after the static pass', async () => {
  let reads = 0, renders = 0;
  const search = createQuarkRenderedSearch({
    read: async url => {
      if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
      reads++;
      return { url, html: '<title>希望 (2026)</title><article>' + '这是完整的电影介绍。'.repeat(40) + '<a href="">查看资源下载页</a></article>' };
    },
    render: async (url, options) => {
      if (url.includes('google.com/search')) return { url, html: '<a href="https://public.example/dynamic"><h3>希望 (2026) 夸克网盘</h3></a>' };
      const html = article('dynamic26', '2026-10-01');
      assert.equal(typeof options.waitForShare, 'function'); assert.equal(options.waitForShare({ url, html }), true);
      assert.equal(options.waitForShare({ url, html: '<title>其他电影 (2026)</title><main><a href="https://pan.quark.cn/s/unrelated26">分享</a></main>' }), false);
      renders++; return { url, html };
    },
  });
  assert.deepEqual((await search(query)).map(row => row.url), ['https://pan.quark.cn/s/dynamic26']);
  assert.equal(reads, 1); assert.equal(renders, 1);
});

test('all article prefetch lanes share one eight-second deadline', async () => {
  let clock = 1000;
  const deadlines = [];
  const search = createQuarkRenderedSearch({ now: () => clock,
    read: async (url, { deadline }) => {
      if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
      deadlines.push(deadline);
      clock += 4000; await new Promise(resolve => setImmediate(resolve));
      return { url, html: '<title>希望 (2026)</title><article>影片介绍。</article>' };
    },
    render: async url => ({ url, html: url.includes('google.com/search') ? ['one', 'two', 'three', 'four', 'five'].map(key => `<a href="https://public.example/${key}"><h3>希望 (2026) 夸克网盘</h3></a>`).join('') : article('bounded26', '2026-10-01') }),
  });
  assert.equal((await search(query)).length, 1);
  assert.deepEqual(deadlines, [9000, 9000]);
});

test('a stalled read cannot discard an already found share or write late results after the shared deadline', async () => {
  let late;
  const started = Date.now();
  const search = createQuarkRenderedSearch({
    read: async url => {
      if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
      if (url.endsWith('valid')) return { url, html: article('ready026', '2026-10-01') };
      return await new Promise(resolve => { late = () => resolve({ url, html: article('late0026', '2026-10-02') }); });
    },
    render: async url => {
      assert.ok(url.includes('google.com/search'));
      return { url, html: '<a href="https://public.example/valid"><h3>希望 (2026) 夸克网盘</h3></a><a href="https://public.example/stalled"><h3>希望 (2026) 夸克网盘</h3></a>' };
    },
  });
  const rows = await search(query, { deadline: started + 3000 });
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/ready026']);
  assert.ok(Date.now() - started < 3000);
  late(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/ready026']);
});

test('Google JavaScript rendering has time for NAS startup and still leaves an article budget', async () => {
  let clock = 1000, googleDeadline, articleDeadline;
  const search = createQuarkRenderedSearch({ now: () => clock,
    read: async url => {
      assert.ok(!url.includes('google'));
      if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
      return { url, html: '' };
    },
    render: async (url, { deadline }) => {
      if (url.includes('google')) {
        googleDeadline = deadline;
        clock += 16000;
        assert.ok(clock < deadline);
        return { url, html: serp };
      }
      articleDeadline = deadline;
      return { url, html: article('nas00000', '2026-09-13') };
    },
  });
  assert.equal((await search(query, { deadline: 46000 })).length, 1);
  assert.equal(googleDeadline, 21000);
  assert.ok(articleDeadline > clock && articleDeadline <= 46000);
});

test('a shared deadline shortened by the API still reserves Google rendering and one article read', async () => {
  let clock = 1000, googleDeadline, articleBudget;
  const search = createQuarkRenderedSearch({ now: () => clock,
    read: async (url, { deadline }) => {
      assert.ok(!url.includes('google'));
      if (url.includes('bing')) { clock = Math.max(clock, deadline); return { url, html: '<rss><channel></channel></rss>' }; }
      articleBudget = deadline - clock;
      return { url, html: article('shared00', '2026-09-13') };
    },
    render: async (url, { deadline }) => {
      googleDeadline = deadline;
      clock += 16000;
      assert.ok(clock < deadline);
      return { url, html: serp };
    },
  });
  assert.equal((await search(query, { deadline: 35000 })).length, 1);
  assert.equal(googleDeadline, 21000);
  assert.ok(articleBudget >= 8000);
});

test('compact title uses separate year, retries an exact alias and never claims an unrelated article', async () => {
  const words = [];
  const search = createQuarkRenderedSearch({ render: async url => {
    if (url.includes('google')) { const word = new URL(url).searchParams.get('q'); words.push(word); return { url, html: word === '希望 2026 夸克 网盘' ? '' : serp }; }
    return { url, html: '<main><h1>其他电影 (2026)</h1><a href="https://pan.quark.cn/s/unrelated">分享</a></main>' };
  } });
  assert.equal((await search({ ...query, aliases: ['Hope'] })).length, 0);
  assert.deepEqual(words, ['希望 2026 夸克 网盘', 'Hope 2026 夸克 网盘']);
});

test('one failed article does not hide other results, cancellation and deadline stop new requests', async () => {
  const search = createQuarkRenderedSearch({ render: async url => { if (url.endsWith('older')) throw new Error('unavailable'); return { url, html: url.includes('google') ? serp : article('valid0000', '2026-09-13') }; } });
  assert.equal((await search(query)).length, 1);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(search(query, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(await search(query, { deadline: Date.now() - 1 }), []);
});

test('cloud search companion only receives title metadata through a fixed endpoint', async () => {
  let captured;
  const search = createQuarkBrowserSearch({ fetch: async (url, options) => { captured = { url, options }; return new Response(JSON.stringify({ results: [] }), { status: 200 }); } });
  await search({ ...query, cookie: 'must-never-leave-main-app' });
  assert.equal(captured.url, 'http://quark-browser:3020/search');
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(Object.keys(JSON.parse(captured.options.body)), ['title', 'aliases', 'year', 'page', 'budgetMs']);
  assert.ok(!captured.options.body.includes('must-never-leave-main-app'));
  const missing = createQuarkBrowserSearch({ fetch: async () => { throw new Error('ENOTFOUND'); } });
  assert.match((await missing(query)).reason, /更新部署配置/);
});

test('isolated worker rejects URL and credential input without launching browser and has no account routes', async t => {
  let renders = 0, closed = false;
  const app = createBrowserWorker({ browser: { render: async () => { renders++; }, close: async () => { closed = true; } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); assert.equal(closed, true); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  assert.equal((await fetch(base + '/health')).status, 200);
  for (const extra of [{ url: 'http://127.0.0.1' }, { cookie: 'private' }, ...[-1, 3, 1.5, '1'].map(page => ({ page }))]) {
    const response = await fetch(base + '/search', { method: 'POST', body: JSON.stringify({ ...query, budgetMs: 1000, ...extra }) });
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(base + '/api/quark/settings')).status, 404);
  assert.equal(renders, 0);
});

test('worker executes title to Google to article to share end to end and only returns matched public links', async t => {
  const calls = [];
  const app = createBrowserWorker({ browser: { render: async url => { calls.push(url); assert.ok(url.includes('google.com/search')); return { url, html: serp }; }, close: async () => {} },
    read: async url => { assert.ok(!url.includes('google')); calls.push(url); return { url, html: url.includes('bing') ? '<rss><channel></channel></rss>' : article('worker00', '2026-09-13', 15) }; } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/search', { method: 'POST', body: JSON.stringify({ ...query, budgetMs: 5000 }) });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://pan.quark.cn/s/worker00');
  assert.equal(calls.filter(url => url.startsWith('https://public.example/')).length, 2); assert.ok(calls.length <= 8); assert.ok(!JSON.stringify(result).includes('<html>'));
});

test('Bing RSS can supply articles when Google asks for verification', async () => {
  let renders = 0;
  const search = createQuarkRenderedSearch({ read: async url => ({ url, html: url.includes('bing') ? '<rss><channel><item><title>希望 HOPE (2026) 夸克</title><link>https://public.example/newer</link></item></channel></rss>' : url.includes('google') ? '<title>安全验证</title><div class="g-recaptcha"></div>' : article('bing0000', '2026-09-13') }),
    render: async () => { renders++; throw Object.assign(new Error('verification'), { quarkPoolReason: 'browserBlocked' }); } });
  assert.equal((await search(query)).length, 1);
  assert.equal(renders, 1);
});

test('generic RSS candidates cannot suppress a later broad Bing HTML resource result or fill its bounded article slots', async () => {
  const reads = [], htmlQueries = [];
  const generic = '<rss><channel>' + Array.from({ length: 12 }, (_, index) => `<item><title>希望 (2026) 电影介绍 ${index}</title><link>https://public.example/generic-${index}</link><pubDate>2026-11-01</pubDate></item>`).join('') + '</channel></rss>';
  const search = createQuarkRenderedSearch({
    render: async url => { assert.ok(url.includes('google.com/search'), '静态匹配分享已找到后不能再渲染普通介绍页'); throw Object.assign(new Error('Google verification'), { quarkPoolReason: 'browserBlocked' }); },
    read: async url => {
      const target = new URL(url);
      if (target.hostname.includes('bing')) {
        if (target.searchParams.get('format') === 'rss') return { url, html: generic };
        const term = target.searchParams.get('q'); htmlQueries.push(term);
        return { url, html: term.includes('2026') ? '<main>暂无资源文章</main>' : [1, 2].map(index => `<li class="b_algo"><h2><a href="https://public.example/resource-${index}">希望 (2026) 夸克网盘资源 ${index}</a></h2><time datetime="2026-01-01"></time></li>`).join('') };
      }
      reads.push(target.pathname);
      return { url, html: target.pathname.startsWith('/resource-') ? article(target.pathname.endsWith('1') ? 'broad001' : 'broad002', '2026-01-01') : '<title>希望 (2026)</title><main>电影介绍，没有分享。</main>' };
    },
  });
  const rows = await search(query);
  assert.ok(htmlQueries.some(term => !term.includes('2026')), 'generic RSS不能抑制后续宽查询HTML');
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/broad001', 'https://pan.quark.cn/s/broad002']);
  assert.deepEqual(reads.slice(0, 2), ['/resource-1', '/resource-2'], '有资源线索的较早文章优先于较新的普通介绍');
  assert.equal(reads.length, 10, '保留12候选收集和10文章读取上限');
});

test('a matched generic Google page still permits the existing broad resource query within its budget', async () => {
  const googleQueries = [];
  const search = createQuarkRenderedSearch({
    render: async url => {
      assert.ok(url.includes('google.com/search'));
      const term = new URL(url).searchParams.get('q'); googleQueries.push(term);
      return { url, html: term.includes('2026') ? '<a href="https://public.example/encyclopedia"><h3>希望 HOPE (2026) 电影介绍</h3></a>' : '<a href="https://public.example/resource"><h3>希望 HOPE (2026) 夸克资源</h3></a>' };
    },
    read: async url => ({ url, html: url.includes('bing') ? '<rss><channel></channel></rss>' : url.endsWith('/resource') ? article('broadgg1', '2026-10-01') : '<title>希望 (2026)</title><main>电影介绍，没有分享。</main>' }),
  });
  const rows = await search({ title: '希望', aliases: ['HOPE'], year: '2026' });
  assert.ok(googleQueries.some(term => !term.includes('2026')), '首轮只出现百科介绍时仍尝试已有宽查询');
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/broadgg1']);
});

test('Bing RSS does not wait for a slow Google render to exhaust its independent search deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let rssCalls = 0;
  const search = createQuarkRenderedSearch({
    render: async () => {
      await new Promise(resolve => setTimeout(resolve, 20000));
      throw Object.assign(new Error('slow Google'), { quarkPoolReason: 'browserTimeout' });
    },
    read: async url => {
      if (url.includes('bing')) {
        if (new URL(url).searchParams.get('format') !== 'rss') return { url, html: '<main>暂无搜索结果</main>' };
        rssCalls++;
        return { url, html: '<rss><channel><item><title>希望 HOPE (2026) 夸克</title><link>https://public.example/rss</link></item></channel></rss>' };
      }
      return { url, html: article('bingrss26', '2026-09-13') };
    },
  });
  const pending = search(query);
  await new Promise(resolve => setImmediate(resolve));
  const rssStartedBeforeGoogleFinished = rssCalls > 0;
  t.mock.timers.tick(20000);
  const rows = await pending;
  assert.equal(rssStartedBeforeGoogleFinished, true, 'Bing HTML为空时RSS必须在Google仍等待时开始');
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/bingrss26']);
});

test('a short Bing budget still requests RSS before an HTML read can consume the whole channel deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let rssCalls = 0;
  const search = createQuarkRenderedSearch({
    render: async () => { throw Object.assign(new Error('Google verification'), { quarkPoolReason: 'browserBlocked' }); },
    read: async (url, { deadline }) => {
      if (url.includes('bing')) {
        if (new URL(url).searchParams.get('format') === 'rss') {
          rssCalls++;
          return { url, html: '<rss><channel><item><title>希望 HOPE (2026) 夸克</title><link>https://public.example/rss</link></item></channel></rss>' };
        }
        await new Promise(resolve => setTimeout(resolve, deadline - Date.now()));
        throw Object.assign(new Error('Bing HTML deadline'), { name: 'TimeoutError' });
      }
      return { url, html: article('rssshort26', '2026-09-13') };
    },
  });
  const pending = search(query, { deadline: Date.now() + 3000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const rows = await pending;
  assert.equal(rssCalls, 1, 'HTML超时不能令独立RSS机会消失');
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/rssshort26']);
});

test('Google JavaScript shells stop after one render while Chinese Bing independently finds exact official aliases', async () => {
  const calls = [];
  const search = createQuarkRenderedSearch({ render: async (url, { deadline }) => { calls.push({ url, deadline }); return { url, html: '<title>Google Search</title><a href="/httpservice/retry/enablejs">Please enable JavaScript to use Google Search.</a>' }; }, read: async (url, { deadline }) => {
    calls.push({ url, deadline });
    assert.ok(!url.includes('google'));
    if (url.includes('bing')) return { url, html: new URL(url).searchParams.get('q').startsWith('"호프"') ? '<ol><li class="b_algo"><h2><a href="https://public.example/hope">호프 (2026) 夸克网盘</a></h2></li></ol>' : '<rss><channel></channel></rss>' };
    return { url, html: '<title>호프 (2026) 夸克网盘</title><main><a href="https://pan.quark.cn/s/korean001">点击获取</a></main>' };
  } });
  const started = Date.now();
  const rows = await search({ title: '希望', aliases: ['Hope', '호프'], year: '2026' });
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/korean001']);
  assert.equal(calls.filter(call => call.url.includes('google')).length, 1);
  assert.ok(calls.filter(call => call.url.includes('bing')).every(call => call.deadline <= started + 12000));
});

test('worker accepts page two and sends bounded later-page offsets to each public search channel', async t => {
  const urls = [];
  const app = createBrowserWorker({ browser: { render: async url => { urls.push(new URL(url)); return { url, html: '<title>Google Search</title>' }; }, close: async () => {} },
    read: async url => { assert.ok(!url.includes('google')); urls.push(new URL(url)); return { url, html: '<rss><channel></channel></rss>' }; } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/search', { method: 'POST', body: JSON.stringify({ ...query, page: 2, budgetMs: 3000 }) });
  assert.equal(response.status, 200);
  assert.ok(urls.some(url => url.hostname === 'www.google.com' && url.searchParams.get('start') === '20'));
  assert.ok(urls.some(url => url.hostname === 'cn.bing.com' && url.searchParams.get('first') === '21'));
  assert.ok(urls.length <= 6);
});

test('a bounded Google render starts without preflight and supplies matched articles independently of other channels', async () => {
  const renders = [], reads = [];
  const started = Date.now();
  const search = createQuarkRenderedSearch({ read: async url => {
    reads.push(url);
    return { url, html: url.includes('google') ? '<title>Google Search</title><a href="/httpservice/retry/enablejs">Please enable JavaScript to use Google Search.</a>' : url.includes('bing') ? '<rss><channel></channel></rss>' : article('rendered1', '2026-10-01') };
  }, render: async (url, { deadline }) => { renders.push({ url, deadline }); return { url, html: serp }; } });
  const rows = await search(query);
  assert.equal(rows.length, 1); assert.equal(renders.length, 1);
  assert.ok(renders[0].url.includes('google.com/search')); assert.ok(renders[0].deadline <= started + 20100);
  assert.equal(reads.filter(url => url.includes('google')).length, 0);
});

test('a slow unmatched Google search still tries the official alias and reserves an article budget', async () => {
  for (const end of [35000, 46000]) {
    let clock = 1000;
    const google = [];
    const search = createQuarkRenderedSearch({ now: () => clock,
      read: async (url, { deadline }) => {
        if (url.includes('bing')) return { url, html: '<rss><channel></channel></rss>' };
        assert.ok(deadline <= end);
        assert.ok(end - clock >= 12000);
        return { url, html: article('alias2026', '2026-10-01') };
      },
      render: async (url, { deadline }) => {
        const term = new URL(url).searchParams.get('q');
        google.push(term);
        if (google.length === 1) {
          clock += 16000;
          assert.ok(clock < deadline);
          return { url, html: '<title>Google Search</title><h3>不相关影片 (2026)</h3>' };
        }
        assert.equal(term, 'HOPE 2026 夸克 网盘');
        assert.equal(deadline, Math.min(end - 12000, clock + 20000));
        clock += 1000;
        return { url, html: serp };
      },
    });
    const rows = await search({ title: '希望', aliases: ['HOPE'], year: '2026' }, { deadline: end });
    assert.deepEqual(google, ['希望 2026 夸克 网盘', 'HOPE 2026 夸克 网盘']);
    assert.equal(rows.length, 1);
  }
});

test('Google verification stops after one render without HTTP retries', async () => {
  for (const shell of [false, true]) {
    let renders = 0;
    const search = createQuarkRenderedSearch({ read: async url => ({ url, html: url.includes('google') ? shell ? 'Please enable JavaScript to use Google Search.' : '<title>安全验证</title>' : '<rss><channel></channel></rss>' }),
      render: async () => { renders++; throw Object.assign(new Error('verification'), { quarkPoolReason: 'browserBlocked' }); } });
    const rows = await search(query);
    assert.equal(rows.length, 0); assert.equal(renders, 1); assert.match(rows.reason, /验证/);
  }
});

test('reply-locked articles do not launch a browser or hide another public article, while readable shares remain usable', async () => {
  for (const marker of ['本帖含有特定内容，请回复后再查看', '<div class="kehua-hidden-block--locked">仅回复可见</div>']) {
    for (const readable of [false, true]) {
      const renders = [];
      const search = createQuarkRenderedSearch({
        read: async url => ({ url, html: url.includes('bing') ? '<rss><channel></channel></rss>' : url.endsWith('older') ? marker + (readable ? article('readable1', '2026-09-01') : '') : article('public001', '2026-10-01') }),
        render: async url => { renders.push(url); assert.ok(url.includes('google.com/search')); return { url, html: serp }; },
      });
      const rows = await search(query);
      assert.deepEqual(rows.map(row => row.url), readable ? ['https://pan.quark.cn/s/public001', 'https://pan.quark.cn/s/readable1'] : ['https://pan.quark.cn/s/public001']);
      assert.equal(renders.length, 1);
    }
  }
});

test('an exact human-verification page title is excluded before dynamic article rendering', async () => {
  let renders = 0;
  const search = createQuarkRenderedSearch({
    read: async url => ({ url, html: url.includes('bing') ? '<rss><channel></channel></rss>' : '<title>人机验证</title><body>完成验证后继续访问。</body>' }),
    render: async url => {
      renders++; assert.ok(url.includes('google.com/search'));
      return { url, html: '<a href="https://public.example/challenge"><h3>希望 (2026) 夸克网盘</h3></a>' };
    },
  });
  const rows = await search(query);
  assert.equal(rows.length, 0); assert.equal(renders, 1); assert.match(rows.reason, /验证/);
});

test('Bing articles without a share cannot suppress the one Google render', async () => {
  let googleRenders = 0;
  const search = createQuarkRenderedSearch({ read: async url => ({ url, html: url.includes('google') ? 'Please enable JavaScript to use Google Search.' : url.includes('bing') ? '<li class="b_algo"><h2><a href="https://public.example/no-share">希望 (2026) 夸克网盘</a></h2></li>' : url.endsWith('no-share') ? '<title>希望 (2026)</title><article>只有介绍，没有分享</article>' : article('google001', '2026-10-01') }),
    render: async url => { if (url.includes('google')) { googleRenders++; return { url, html: serp }; } throw new Error('no dynamic article'); } });
  const result = await search(query);
  assert.equal(googleRenders, 1); assert.equal(result.length, 1); assert.equal(result[0].url, 'https://pan.quark.cn/s/google001');
});

test('worker decodes Chinese titles split across HTTP chunks and aborts its entire search at the supplied budget', async t => {
  let title;
  const wait = signal => new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const app = createBrowserWorker({ browser: { render: async (url, { signal }) => { title = new URL(url).searchParams.get('q'); await wait(signal); }, close: async () => {} }, read: async (url, { signal }) => { assert.ok(!url.includes('google')); await wait(signal); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const body = Buffer.from(JSON.stringify({ ...query, budgetMs: 1100 }));
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path: '/search', method: 'POST' }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(data) }));
    });
    req.on('error', reject);
    (async () => { for (const byte of body) { req.write(Buffer.from([byte])); await new Promise(done => setImmediate(done)); } req.end(); })().catch(reject);
  });
  assert.equal(title, '希望 2026 夸克 网盘');
  assert.equal(result.status, 504); assert.equal(result.value.reason, 'browserTimeout');
});

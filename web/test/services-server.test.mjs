import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';

const empty = { showAdult: false, sources: [], platforms: [], parsers: [], subscriptions: [], liveSources: [] };
const movie = { key: '普通影片|2025|movie', source: 'demo', id: '1', title: '普通影片', year: '2025', type: 'movie', category: 'movie',
  lines: [{ name: '线路', episodes: [{ name: '正片', url: 'https://media.example/film.m3u8?token=trusted', type: 'hls' }] }] };
const stream = { url: 'https://tv.example/second.m3u8?token=trusted', type: 'hls' };
const channels = [{ id: 'trusted-channel', name: '公共频道', streams: [{ url: 'https://tv.example/first.mp4', type: 'mp4' }, stream] }];
const configured = { ...empty, liveSources: [{ id: 'fixture', name: '公开频道表', url: 'https://tv.example/list.m3u', enabled: true }] };
const ratingResult = { douban: { score: 8, url: 'https://movie.douban.com/subject/12345/', attribution: '中性测试样例' }, tmdb: null, configured: true, errors: [] };
const catalog = { async detail() { return movie; }, async search() { return { groups: [], failedSources: [] }; } };
const maintenance = { status() { return { sources: [] }; }, async probe() { return { sources: [] }; }, async update() { return { sources: [] }; } };
const live = { async list() { return { channels }; }, status() { return []; } };
const preferences = { key: movie.key, introSeconds: 0, outroSeconds: 0, autoNext: true, danmakuEnabled: true, skipAds: false, adRanges: [], speed: 1 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function running(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-services-'));
  let app, base;
  const open = async () => {
    app = createApp({ password: 'service-test-password', dataDir, initialConfig: empty, catalog, maintenance, live,
      discovery: { status: () => ({ running: false, lastDiscovery: 0, candidates: [] }), discover: async () => {}, stop: () => {} },
      transcoder: { status: () => ({ available: false, enabled: false, running: false }), close: () => {} },
      ratings: { async get() { return ratingResult; } }, ...options });
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  await open();
  t.after(async () => {
    await app.close();
    const target = resolve(dataDir), parent = resolve(tmpdir());
    assert.ok(target.startsWith(parent + sep) && target.split(sep).at(-1).startsWith('vipvideo-services-'));
    await rm(target, { recursive: true, force: true });
  });
  const call = (path, body, cookie, method = body === undefined ? 'GET' : 'POST', headers = {}) => fetch(base + path, {
    method, headers: { Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async () => {
    const response = await call('/api/auth/login', { password: 'service-test-password' });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { get app() { return app; }, get base() { return base; }, call, login, dataDir,
    async restart() { await app.close(); await open(); } };
}

test('new service endpoints require authentication before reading request JSON or calling providers', async t => {
  let calls = 0;
  const mark = () => { calls++; return {}; };
  const instance = await running(t, {
    maintenance: { status: mark, probe: mark, update: mark }, live: { list: mark, status: mark, report: mark },
    ratings: { get: mark }, danmaku: { list: mark, send: mark, binding: mark, bind: mark },
  });
  for (const [path, method] of [
    ['/api/sources/status', 'GET'], ['/api/sources/probe', 'POST'], ['/api/sources/update', 'POST'],
    ['/api/sources/discover', 'POST'], ['/api/live/probe', 'POST'], ['/api/playability?source=demo&id=1', 'GET'], ['/api/playability/report', 'POST'],
    ['/api/transcode/status','GET'], ['/api/transcode/start','POST'], ['/api/transcode/stop','POST'], ['/api/transcode/task/index.m3u8','GET'],
    ['/api/live/playback?id=trusted-channel', 'GET'], ['/api/live/report', 'POST'], ['/api/ratings?source=demo&id=1', 'GET'],
    ['/api/player/preferences?key=film', 'GET'], ['/api/player/preferences', 'PUT'],
    ['/api/danmaku?key=film&episode=0', 'GET'], ['/api/danmaku', 'POST'],
    ['/api/danmaku/binding?key=film&episode=0', 'GET'], ['/api/danmaku/binding', 'PUT'],
  ]) {
    const response = await fetch(instance.base + path, { method, headers: { Connection: 'close', 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: '{broken-json' }) });
    assert.equal(response.status, 401, path);
  }
  assert.equal(calls, 0);
});

test('all new write routes reject cross-site requests and allow same-origin maintenance calls', async t => {
  let calls = 0;
  const mark = () => { calls++; return {}; };
  const instance = await running(t, { maintenance: { status: mark, probe: mark, update: mark },
    live: { list: async () => ({ channels: [] }), status: () => [] }, danmaku: { send: mark, bind: mark } });
  const cookie = await instance.login();
  for (const [path, method] of [['/api/sources/probe','POST'], ['/api/sources/update','POST'], ['/api/live/report','POST'],
    ['/api/sources/discover','POST'], ['/api/live/probe','POST'], ['/api/playability/report','POST'],
    ['/api/transcode/start','POST'], ['/api/transcode/stop','POST'],
    ['/api/player/preferences','PUT'], ['/api/danmaku','POST'], ['/api/danmaku/binding','PUT']]) {
    assert.equal((await instance.call(path, {}, cookie, method, { Origin: 'https://other.example' })).status, 403, path);
    assert.equal((await instance.call(path, {}, cookie, method, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, path);
  }
  assert.equal(calls, 0);
  assert.equal((await instance.call('/api/sources/probe', {}, cookie, 'POST', { Origin: instance.base })).status, 200);
  assert.equal(calls, 1);
});

test('Quark folder recovery requires login, same origin and an empty body, then invalidates existing media leases', async t => {
  let repairs = 0, invalidations = 0, retainedValid;
  const settings = { configured: true, enabled: true, managedFiles: 2 };
  const poolStatus = { healthy: 1 };
  const instance = await running(t, {
    quark: { async repairFolder({ valid }) { assert.equal(valid(), true); retainedValid = valid; repairs++; return settings; } },
    quarkMedia: { invalidate() { invalidations++; } },
    quarkSearchPool: { status: () => poolStatus },
  });
  const path = '/api/quark/folder/repair';
  assert.equal((await instance.call(path, {})).status, 401);
  const cookie = await instance.login();
  for (const headers of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await instance.call(path, {}, cookie, 'POST', headers)).status, 403);
  }
  for (const body of [{ fid: 'untrusted-folder' }, null, [], '']) {
    assert.equal((await instance.call(path, body, cookie)).status, 400);
  }
  assert.equal(repairs, 0); assert.equal(invalidations, 0);
  const response = await instance.call(path, {}, cookie, 'POST', { Origin: instance.base });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ...settings, searchPool: poolStatus });
  assert.equal(repairs, 1); assert.equal(invalidations, 1);
  assert.equal((await instance.call('/api/auth/logout', {}, cookie)).status, 200);
  assert.throws(() => retainedValid(), error => error.status === 401, '后台恢复操作必须持续核验家庭会话');
});

test('compatibility playback status, trusted selection, assets and stop use the authenticated service contract', async t => {
  const calls=[];
  const initialConfig={...configured,sources:[{id:'demo',name:'可信源',api:'https://api.example/vod',enabled:true}]};
  const result={id:'safe-task',url:'/api/transcode/safe-task/index.m3u8',type:'hls',transcoded:true,startPosition:37,duration:300,acceleration:'software'};
  const serviceStatus={available:true,enabled:true,acceleration:'auto',running:false};
  const instance=await running(t,{initialConfig,transcoder:{status:async()=>serviceStatus,
    async start(input){calls.push(input);assert.equal(input.valid(),true);return result;},
    async cancel(id,owner){assert.match(owner,/^[a-f\d]{64}$/);calls.push({id});return true;},
    async serve(req,res,id,file){calls.push({id,file,method:req.method});res.end('#EXTM3U');},close:()=>{},
  }}),cookie=await instance.login();
  assert.deepEqual(await(await instance.call('/api/transcode/status',undefined,cookie)).json(),serviceStatus);
  const started=await instance.call('/api/transcode/start',{source:'demo',id:'1',line:0,episode:0,position:37,speed:1.5,url:'http://127.0.0.1/untrusted'},cookie);
  assert.equal(started.status,200);
  assert.deepEqual(await started.json(),result);
  assert.equal(calls[0].episode,movie.lines[0].episodes[0]);assert.equal(calls[0].position,37);assert.equal(calls[0].speed,1.5);
  assert.match(calls[0].owner,/^[a-f\d]{64}$/);
  const liveStarted=await instance.call('/api/transcode/start',{liveId:'trusted-channel',line:1,url:'file:///etc/passwd'},cookie);
  assert.equal(liveStarted.status,200);assert.equal(calls[1].episode,stream);
  assert.equal(await(await instance.call(result.url,undefined,cookie)).text(),'#EXTM3U');
  assert.deepEqual(await(await instance.call('/api/transcode/stop',{id:result.id},cookie)).json(),{stopped:true});
  instance.app.store.setConfig({...initialConfig,sources:[]});assert.equal(calls[0].valid(),false);
});

test('compatibility playback rejects unconfigured URLs, pages and invalid indices, positions or rates before spawning', async t => {
  let starts=0;
  const initialConfig={...configured,sources:[{id:'demo',name:'可信源',api:'https://api.example/vod',enabled:true}]};
  const instance=await running(t,{initialConfig,transcoder:{async start(){starts++;},close:()=>{}}}),cookie=await instance.login();
  const base={source:'demo',id:'1',line:0,episode:0,position:0,speed:1};
  const invalid=[{url:stream.url},{...base,source:'unknown'},{...base,line:999},{...base,line:'0'},{...base,episode:-1},
    ...[-1,86401,Infinity,'20'].map(position=>({...base,position})),...['1',4,0].map(speed=>({...base,speed})),
    {liveId:'missing',line:0},{liveId:'trusted-channel',line:1,position:20},{liveId:'trusted-channel',speed:2}];
  for(const body of invalid)assert.equal((await instance.call('/api/transcode/start',body,cookie)).status,400,JSON.stringify(body));
  const page={...movie,lines:[{name:'网页',episodes:[{name:'正片',url:'https://parser.example/watch',type:'page'}]}]};
  const pageInstance=await running(t,{initialConfig,catalog:{...catalog,detail:async()=>page},transcoder:{async start(){starts++;},close:()=>{}}});
  assert.equal((await pageInstance.call('/api/transcode/start',base,await pageInstance.login())).status,400);
  assert.equal(starts,0);
});

test('pending compatibility playback respects configuration, adult visibility and logout changes', async t => {
  for(const stage of ['detail','adult','logout'])await t.test(stage,async sub=>{
    const entered=deferred(),release=deferred();let starts=0,cancelled=0;
    const initialConfig={...empty,showAdult:true,sources:[{id:'demo',name:'可信源',api:'https://api.example/vod',enabled:true}]};
    const instance=await running(sub,{initialConfig,catalog:{...catalog,async detail(){
      if(stage==='detail'){entered.resolve();await release.promise;}
      return stage==='adult'?{...movie,category:'adult'}:movie;
    }},transcoder:{async start(){starts++;entered.resolve();await release.promise;return{id:'pending'};},
      async cancel(id){assert.equal(id,'pending');cancelled++;return true;},close:()=>{}}});
    const cookie=await instance.login(),pending=instance.call('/api/transcode/start',{source:'demo',id:'1'},cookie);
    try{
      await entered.promise;
      if(stage==='logout')assert.equal((await instance.call('/api/auth/logout',{},cookie)).status,200);
      else instance.app.store.setConfig(stage==='detail'?{...initialConfig,sources:[]}:{...initialConfig,showAdult:false});
    }finally{release.resolve();}
    assert.equal((await pending).status,stage==='adult'?403:409);
    assert.equal(starts,stage==='detail'?0:1);assert.equal(cancelled,stage==='detail'?0:1);
  });
});

test('source status, probe and update combine trusted service results and refresh configured live sources', async t => {
  const events = [];
  const instance = await running(t, { initialConfig: configured,
    maintenance: { status: () => ({ sources: [{ id: 'vod', available: true }] }),
      async probe() { events.push('source-probe'); return { probed: true }; }, async update() { events.push('source-update'); return { updated: true }; } },
    live: { status: config => [{ id: config.liveSources[0].id, available: true }],
      async probe(config) { events.push(['live-probe', config.liveSources[0].url]); },
      async list(config, options) { events.push(['live-list', config.liveSources[0].url, options]); return { channels }; } },
  });
  const cookie = await instance.login();
  assert.deepEqual(await (await instance.call('/api/sources/status', undefined, cookie)).json(), {
    sources: [{ id: 'vod', available: true }], liveSources: [{ id: 'fixture', available: true }],
    discovery: { running: false, lastDiscovery: 0, candidates: [] },
  });
  assert.equal((await instance.call('/api/sources/probe', { url: 'http://127.0.0.1/arbitrary' }, cookie)).status, 200);
  assert.equal((await instance.call('/api/sources/update', { url: 'http://127.0.0.1/arbitrary' }, cookie)).status, 200);
  assert.deepEqual(events, ['source-probe', ['live-probe','https://tv.example/list.m3u'], 'source-update', ['live-list','https://tv.example/list.m3u',{ refresh:true }]]);
});

test('discovery and live probe endpoints operate on the latest stored configuration', async t => {
  const events = [], discoveryStatus = { running: false, lastDiscovery: 123, candidates: [] };
  let instance;
  instance = await running(t, { initialConfig: configured,
    discovery: { status: () => discoveryStatus, async discover() {
      events.push('discover');
      instance.app.store.setConfig({ ...instance.app.store.config(), liveSources: [{ ...configured.liveSources[0], url: 'https://tv.example/new.m3u' }] });
    } },
    live: { status: () => [], async probe(config) { events.push(['probe', config.liveSources[0].url]); },
      async list(config) { events.push(['list', config.liveSources[0].url]); return { channels }; } },
  });
  const cookie = await instance.login();
  const discovered = await instance.call('/api/sources/discover', { url: 'http://127.0.0.1/untrusted' }, cookie);
  assert.equal(discovered.status, 200);
  assert.deepEqual((await discovered.json()).discovery, discoveryStatus);
  assert.deepEqual(await (await instance.call('/api/live/probe', {}, cookie)).json(), { channels });
  assert.deepEqual(events, ['discover', ['probe','https://tv.example/new.m3u'], ['probe','https://tv.example/new.m3u'], ['list','https://tv.example/new.m3u']]);
});

test('playability checks and feedback accept only episodes returned by a configured source', async t => {
  const received = [];
  const initialConfig = { ...empty, sources: [{ id:'demo', name:'可信源', api:'https://api.example/vod', enabled:true }] };
  const instance = await running(t, { initialConfig, playability: {
    async check(value) { received.push(['check',value]); return { playable:true,checkedAt:1 }; },
    report(value, success) { received.push(['report',value,success]); return { playable:success,checkedAt:2 }; },
  } });
  const cookie = await instance.login();
  const response = await instance.call('/api/playability?source=demo&id=1&line=0&episode=0&url=http%3A%2F%2F127.0.0.1%2Ffake', undefined, cookie);
  assert.deepEqual(await response.json(), { playable:true,checkedAt:1 });
  const report = await instance.call('/api/playability/report', { source:'demo',id:'1',line:0,episode:0,status:'error',url:'http://127.0.0.1/fake' }, cookie);
  assert.deepEqual(await report.json(), { playable:false,checkedAt:2 });
  assert.deepEqual(received, [['check',movie.lines[0].episodes[0]], ['report',movie.lines[0].episodes[0],false]]);
  for(const query of ['url=https://media.example/fake.m3u8','source=missing&id=1','source=demo&id=1&line=99','source=demo&id=1&episode=-1','source=demo&id=1&episode=0.5']) {
    assert.equal((await instance.call('/api/playability?'+query,undefined,cookie)).status,400,query);
  }
  assert.equal((await instance.call('/api/playability/report',{source:'demo',id:'1',status:'unknown'},cookie)).status,400);
  assert.equal(received.length,2);
});

test('playability rejects configuration changes and hidden adult details across pending checks', async t => {
  for(const stage of ['detail','check','adult']) await t.test(stage,async sub => {
    const entered=deferred(),release=deferred();let checks=0;
    const initialConfig={...empty,showAdult:true,sources:[{id:'demo',name:'可信源',api:'https://api.example/vod',enabled:true}]};
    const instance=await running(sub,{initialConfig,catalog:{...catalog,async detail(){
      if(stage==='detail'){entered.resolve();await release.promise;}
      return stage==='adult'?{...movie,category:'adult'}:movie;
    }},playability:{async check(){checks++;if(stage!=='detail'){entered.resolve();await release.promise;}return{playable:true};}}});
    const cookie=await instance.login(),pending=instance.call('/api/playability?source=demo&id=1',undefined,cookie);
    try{
      await entered.promise;
      instance.app.store.setConfig(stage==='adult'?{...initialConfig,showAdult:false}:{...initialConfig,sources:[]});
    }finally{release.resolve();}
    assert.equal((await pending).status,stage==='adult'?403:409);
    assert.equal(checks,stage==='detail'?0:1);
  });
});

test('raw JSONC import returns repair warnings without persisting warnings or changing data after errors', async t => {
  const instance=await running(t),cookie=await instance.login();
  const response=await instance.call('/api/config/import',{config:'```jsonc\n{ // compatible public API\n"sites": [{"key":"new","name":"测试源","type":1,"api":"example.com:8443/vod?x=1&amp;y=2",},],}\n```'},cookie);
  assert.equal(response.status,200);
  const imported=await response.json();
  assert.equal(imported.sources[0].api,'https://example.com:8443/vod?x=1&y=2');
  assert.ok(imported.importWarnings.length>0);
  const saved=instance.app.store.config();
  assert.equal(Object.hasOwn(saved,'importWarnings'),false);
  for(const config of ['{bad',{api_site:{unsafe:'http://127.0.0.1/api'}},{api_site:[{id:'same',api:'https://example.com/a'},{id:'same',api:'https://example.com/b'}]}]){
    assert.ok([400,403].includes((await instance.call('/api/config/import',{config},cookie)).status));
    assert.deepEqual(instance.app.store.config(),saved);
  }
});

test('live playback and reports use a selected configured stream and ignore client-supplied addresses', async t => {
  const reported = [];
  const instance = await running(t, { initialConfig: configured, live: { ...live, report: (...value) => reported.push(value) } });
  const cookie = await instance.login();
  const response = await instance.call('/api/live/playback?id=trusted-channel&line=1&url=http%3A%2F%2F127.0.0.1%2Fevil', undefined, cookie);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.url, stream.url);
  assert.equal(result.type, 'hls');
  assert.match(result.proxyUrl, /^\/api\/media\?token=/);
  assert.equal((await instance.call('/api/live/report', { id:'trusted-channel', line:1, status:'ok', url:'http://127.0.0.1/evil' }, cookie)).status, 200);
  assert.deepEqual(reported, [[stream.url, 'ok']]);
});

test('live playback and reports reject unknown IDs, arbitrary URL-only selection and invalid line indices', async t => {
  let playbackCalls = 0, reportCalls = 0;
  const instance = await running(t, { initialConfig: configured, media: { playback() { playbackCalls++; return {}; } },
    live: { ...live, report() { reportCalls++; } } });
  const cookie = await instance.login();
  for (const query of ['url=https%3A%2F%2Ftv.example%2Ffake.m3u8', 'id=missing', 'id=trusted-channel&line=-1',
    'id=trusted-channel&line=0.5', 'id=trusted-channel&line=Infinity', 'id=trusted-channel&line=999', 'id=trusted-channel&line=constructor']) {
    assert.equal((await instance.call('/api/live/playback?' + query, undefined, cookie)).status, 400, query);
  }
  for (const body of [{ url:stream.url, status:'ok', line:0 }, { id:'missing', line:0, status:'ok' },
    ...[-1,0.5,999,'0','constructor'].map(line => ({ id:'trusted-channel', line, status:'ok' })), { id:'trusted-channel', line:0, status:'unknown' }]) {
    assert.equal((await instance.call('/api/live/report', body, cookie)).status, 400, JSON.stringify(body));
  }
  assert.equal(playbackCalls, 0);
  assert.equal(reportCalls, 0);
});

test('live playback and reports reject a source configuration changed while the channel lookup was pending', async t => {
  for (const route of ['playback','report']) await t.test(route, async sub => {
    const entered = deferred(), release = deferred(); let actions = 0;
    const instance = await running(sub, { initialConfig: configured, media: { playback() { actions++; return {}; } },
      live: { async list() { entered.resolve(); await release.promise; return { channels }; }, report() { actions++; } } });
    const cookie = await instance.login();
    const pending = route === 'playback' ? instance.call('/api/live/playback?id=trusted-channel&line=1', undefined, cookie)
      : instance.call('/api/live/report', { id:'trusted-channel', line:1, status:'error' }, cookie);
    try { await entered.promise; instance.app.store.setConfig({ ...instance.app.store.config(), liveSources: [] }); }
    finally { release.resolve(); }
    assert.equal((await pending).status, 409);
    assert.equal(actions, 0);
  });
});

test('ratings look up the selected detail and pass only the trusted detail to the provider', async t => {
  const received = [];
  const instance = await running(t, { catalog: { ...catalog, async detail(config, source, id) { received.push([source,id,config.showAdult]); return movie; } },
    ratings: { async get(detail) { assert.equal(detail, movie); return ratingResult; } } });
  const cookie = await instance.login();
  const response = await instance.call('/api/ratings?source=demo&id=1&url=http%3A%2F%2F127.0.0.1%2Farbitrary', undefined, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ratingResult);
  assert.deepEqual(received, [['demo','1',false]]);
});

test('ratings enforce the latest adult visibility before provider lookup and after a pending lookup', async t => {
  const adult = { ...movie, category: 'adult' };
  for (const stage of ['detail','rating']) await t.test(stage, async sub => {
    const entered = deferred(), release = deferred(); let calls = 0;
    const instance = await running(sub, { initialConfig: { ...empty, showAdult:true },
      catalog: { ...catalog, async detail() { if(stage==='detail'){entered.resolve();await release.promise;} return adult; } },
      ratings: { async get() { calls++; if(stage==='rating'){entered.resolve();await release.promise;} return ratingResult; } } });
    const cookie = await instance.login();
    const pending = instance.call('/api/ratings?source=demo&id=1', undefined, cookie);
    try { await entered.promise; instance.app.store.setConfig({ ...instance.app.store.config(), showAdult:false }); }
    finally { release.resolve(); }
    assert.equal((await pending).status, 403);
    assert.equal(calls, stage==='detail'?0:1);
  });
});

test('player preferences are per-film and the latest save is shared across household sessions', async t => {
  const instance = await running(t), first = await instance.login(), second = await instance.login();
  const path = '/api/player/preferences?key=' + encodeURIComponent(movie.key);
  assert.deepEqual(await (await instance.call(path, undefined, first)).json(), preferences);
  const saved = { ...preferences, introSeconds:90, outroSeconds:30, autoNext:false, danmakuEnabled:false, speed:1.5 };
  assert.equal((await instance.call('/api/player/preferences', saved, first, 'PUT')).status, 200);
  let read = await (await instance.call(path, undefined, second)).json();
  assert.deepEqual(Object.fromEntries(Object.keys(saved).map(key => [key,read[key]])), saved);
  assert.equal((await instance.call('/api/player/preferences', { ...saved, speed:2 }, second, 'PUT')).status, 200);
  read = await (await instance.call(path, undefined, first)).json();
  assert.equal(read.speed, 2);
  const other = await (await instance.call('/api/player/preferences?key=another-film', undefined, first)).json();
  assert.deepEqual(other, { ...preferences, key:'another-film' });
});

test('player preferences persist across application restart without invalidating unchanged household sessions', async t => {
  const instance = await running(t), cookie = await instance.login();
  const saved = { ...preferences, introSeconds:15, outroSeconds:45, speed:0.75 };
  assert.equal((await instance.call('/api/player/preferences', saved, cookie, 'PUT')).status, 200);
  await instance.restart();
  const response = await instance.call('/api/player/preferences?key='+encodeURIComponent(movie.key), undefined, cookie);
  assert.equal(response.status, 200);
  const body = await response.json();
  for(const [key,value] of Object.entries(saved))assert.deepEqual(body[key],value);
});

test('player preference validation rejects malformed values without replacing an existing save', async t => {
  const instance = await running(t), cookie = await instance.login();
  const saved = { ...preferences, introSeconds:12, speed:1.25 };
  await instance.call('/api/player/preferences', saved, cookie, 'PUT');
  for(const patch of [{ key:'' }, { introSeconds:-1 }, { introSeconds:0.5 }, { outroSeconds:601 }, { autoNext:'true' }, { danmakuEnabled:0 }, { speed:1.1 }, { speed:'2' }]) {
    assert.equal((await instance.call('/api/player/preferences', { ...saved, ...patch }, cookie, 'PUT')).status, 400, JSON.stringify(patch));
  }
  assert.equal((await instance.call('/api/player/preferences', [], cookie, 'PUT')).status, 400);
  assert.equal((await instance.call('/api/player/preferences', null, cookie, 'PUT')).status, 400);
  assert.equal((await instance.call('/api/player/preferences', undefined, cookie)).status, 400);
  const body = await (await instance.call('/api/player/preferences?key='+encodeURIComponent(movie.key), undefined, cookie)).json();
  for(const [key,value] of Object.entries(saved))assert.deepEqual(body[key],value);
});

test('danmaku endpoints use the agreed selection, comment and binding service contracts', async t => {
  const received = [], selection = { key:movie.key, episode:2 };
  const instance = await running(t, { danmaku: {
    async list(value) { received.push(['list',value]); return { comments:[], updated:1, errors:[] }; },
    send(value) { received.push(['send',value]); return { ...value, id:'family:fixture', origin:'family' }; },
    binding(value) { received.push(['binding',value]); return { url:'',offset:0 }; },
    async bind(value) { received.push(['bind',value]); return { url:value.url,offset:value.offset }; },
  } });
  const cookie = await instance.login(), query = '?key='+encodeURIComponent(movie.key)+'&episode=2';
  assert.deepEqual(await (await instance.call('/api/danmaku'+query, undefined, cookie)).json(), { comments:[],updated:1,errors:[] });
  const comment = { ...selection, time:12, text:'中性测试弹幕', color:'#ffffff' };
  assert.equal((await instance.call('/api/danmaku', comment, cookie)).status, 200);
  assert.deepEqual(await (await instance.call('/api/danmaku/binding'+query, undefined, cookie)).json(), { url:'',offset:0 });
  const binding = { ...selection, url:'https://comment.bilibili.com/12345.xml',offset:-2 };
  assert.deepEqual(await (await instance.call('/api/danmaku/binding', binding, cookie, 'PUT')).json(), { url:binding.url,offset:-2 });
  assert.deepEqual(received, [['list',selection],['send',comment],['binding',selection],['bind',binding]]);
});

test('real danmaku storage shares family comments and persists explicit episode binding across restart', async t => {
  const instance = await running(t), first = await instance.login(), second = await instance.login();
  const selection = { key:movie.key,episode:0 }, query='?key='+encodeURIComponent(movie.key)+'&episode=0';
  const response = await instance.call('/api/danmaku', { ...selection,time:4,text:'家庭共享测试',color:'#00ccff',origin:'bilibili' }, first);
  assert.equal(response.status, 200);
  const sent = await response.json(); assert.equal(sent.origin,'family');
  const shared = await (await instance.call('/api/danmaku'+query, undefined, second)).json();
  assert.deepEqual(shared.comments,[sent]);
  assert.deepEqual((await (await instance.call('/api/danmaku?key=another-film&episode=0',undefined,second)).json()).comments,[]);
  assert.deepEqual((await (await instance.call('/api/danmaku?key='+encodeURIComponent(movie.key)+'&episode=1',undefined,second)).json()).comments,[]);
  assert.equal((await instance.call('/api/danmaku/binding',{ ...selection,url:'12345',offset:2 },first,'PUT')).status,200);
  await instance.restart();
  const binding=await (await instance.call('/api/danmaku/binding'+query,undefined,second)).json();
  assert.deepEqual(binding,{ url:'https://comment.bilibili.com/12345.xml',offset:2 });
  assert.equal((await instance.call('/api/danmaku/binding',{ ...selection,url:'',offset:0 },second,'PUT')).status,200);
  assert.deepEqual((await (await instance.call('/api/danmaku'+query,undefined,first)).json()).comments,[sent]);
});

test('real danmaku routes reject invalid scopes, unsafe comments and arbitrary external URLs', async t => {
  const instance = await running(t), cookie=await instance.login(), selection={ key:movie.key,episode:0 };
  for(const query of ['?episode=0','?key=film&episode=-1','?key=film&episode=0.5','?key=film&episode=','?key=film&episode=%0A','?key=film&episode='+('a'.repeat(501))]) {
    assert.equal((await instance.call('/api/danmaku'+query,undefined,cookie)).status,400,query);
    assert.equal((await instance.call('/api/danmaku/binding'+query,undefined,cookie)).status,400,query);
  }
  for(const patch of [{ text:'<script>unsafe</script>' },{ text:'字'.repeat(201) },{ time:-1 },{ color:'url(https://other.example/)' },{ episode:{} }]) {
    assert.equal((await instance.call('/api/danmaku',{ ...selection,time:0,text:'中性文字',color:'#ffffff',...patch },cookie)).status,400);
  }
  for(const url of ['http://127.0.0.1/private','https://other.example/comments.xml','https://user:pass@comment.bilibili.com/12345.xml','javascript:alert(1)']) {
    const response=await instance.call('/api/danmaku/binding',{ ...selection,url },cookie,'PUT');
    assert.ok([400,403].includes(response.status),url);
  }
  assert.equal((await instance.call('/api/danmaku/binding',{ ...selection,url:'12345',offset:601 },cookie,'PUT')).status,400);
  const longKey='影片'.repeat(1000);
  assert.equal((await instance.call('/api/danmaku',{ key:longKey,episode:0,time:0,text:'合法长标识',color:'#ffffff' },cookie)).status,200);
});

test('named episode comments and explicit bindings survive changing source episode order', async t => {
  const episodeOne={ name:'第01集',url:'https://media.example/one.m3u8',type:'hls' };
  const episodeTwo={ name:'第02集',url:'https://media.example/two.m3u8',type:'hls' };
  const instance=await running(t,{ catalog:{ ...catalog,async detail(config,source) {
    return{ ...movie,type:'series',source,lines:[{ name:'来源线路',episodes:source==='first'?[episodeOne,episodeTwo]:[episodeTwo,episodeOne] }] };
  } } });
  const cookie=await instance.login();
  const first=await (await instance.call('/api/detail?source=first&id=1',undefined,cookie)).json();
  const selection={ key:movie.key,episode:first.lines[0].episodes[1].name };
  const sent=await (await instance.call('/api/danmaku',{ ...selection,time:3,text:'同名剧集共享',color:'#ffffff' },cookie)).json();
  assert.equal((await instance.call('/api/danmaku/binding',{ ...selection,url:'12345',offset:3 },cookie,'PUT')).status,200);
  const second=await (await instance.call('/api/detail?source=second&id=1',undefined,cookie)).json();
  assert.equal(second.lines[0].episodes[0].name,selection.episode);
  const query='?key='+encodeURIComponent(movie.key)+'&episode='+encodeURIComponent(second.lines[0].episodes[0].name);
  assert.deepEqual(await (await instance.call('/api/danmaku/binding'+query,undefined,cookie)).json(),{ url:'https://comment.bilibili.com/12345.xml',offset:3 });
  assert.equal((await instance.call('/api/danmaku/binding',{ ...selection,url:'',offset:0 },cookie,'PUT')).status,200);
  assert.deepEqual((await (await instance.call('/api/danmaku'+query,undefined,cookie)).json()).comments,[sent]);
  const different='?key='+encodeURIComponent(movie.key)+'&episode='+encodeURIComponent('第01集');
  assert.deepEqual((await (await instance.call('/api/danmaku'+different,undefined,cookie)).json()).comments,[]);
  const legacy={ key:movie.key,episode:'0' };
  const numeric=await (await instance.call('/api/danmaku',{ ...legacy,time:1,text:'旧数字集号兼容',color:'#ffffff' },cookie)).json();
  assert.deepEqual((await (await instance.call('/api/danmaku?key='+encodeURIComponent(movie.key)+'&episode=0',undefined,cookie)).json()).comments,[numeric]);
});

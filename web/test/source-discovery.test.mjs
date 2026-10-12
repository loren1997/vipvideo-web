import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSourceDiscovery } from '../lib/source-discovery.mjs';
import { createStore } from '../lib/store.mjs';

const empty={showAdult:false,sources:[],platforms:[],parsers:[],subscriptions:[],liveSources:[]};
const directory='https://raw.githubusercontent.com/loren1997/vipvideo-web/main/web/subscription-presets.json';
const forkUrl='https://raw.githubusercontent.com/ResearchUser/PublicConfig/main/config.json';
const payload=(api='https://catalog.example/api.php/provide/vod')=>({api_site:{neutral:{name:'中性影视源',api}}});
const playlist='#EXTM3U\n#EXTINF:-1,公共频道\nhttp://127.0.0.1/private.m3u8\n#EXTINF:-1,普通频道\nhttps://tv.example/dead.m3u8\n#EXTINF:-1,普通频道二\nhttps://tv.example/live.m3u8?token=a%24b';
const xml=items=>'<rss><channel>'+items.map(([url,title='公开配置'])=>'<item><title>'+title+'</title><link>'+url.replaceAll('&','&amp;')+'</link></item>').join('')+'</channel></rss>';
const repo=(full_name,extra={})=>({full_name,default_branch:'main',fork:true,archived:false,private:false,...extra});
const response=(body,statusCode=200,url='')=>Object.assign(Readable.from([typeof body==='string'?body:JSON.stringify(body)]),{statusCode,headers:{},finalUrl:url});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function memoryStore(initial=empty){
  let config=structuredClone(initial);const metadata=new Map();
  return{metadata,config:()=>config,setConfig(value){config=structuredClone(value);return config;},meta:key=>metadata.get(key),setMeta:(key,value)=>metadata.set(key,value)};
}
function fixture({store=memoryStore(),files=new Map(),curated={subscriptions:[],liveSources:[]},forks=[],searchVod=[],searchTv=[],rssVod=[],rssTv=[],verify,play,override,now=()=>1000}={}){
  const seen=[],verified=[],played=[],errors=[];let updates=0,active=0,maxActive=0;
  const request=async(input,options)=>{
    const url=String(input),parsed=new URL(url);seen.push(url);assert.equal(options.timeout,8000);assert.equal(options.headers.Authorization,undefined);
    active++;maxActive=Math.max(maxActive,active);await new Promise(done=>setImmediate(done));active--;
    const custom=await override?.(url,options);if(custom)return custom;
    if(url===directory)return response(curated,200,url);
    if(parsed.hostname==='api.github.com'&&parsed.pathname.endsWith('/forks'))return response(forks,200,url);
    if(parsed.hostname==='api.github.com'&&parsed.pathname==='/search/repositories')return response({items:parsed.searchParams.get('q').includes('IPTV')?searchTv:searchVod},200,url);
    if(parsed.hostname==='www.bing.com')return response(xml(parsed.searchParams.get('q').includes('IPTV')?rssTv:rssVod),200,url);
    if(files.has(url))return response(files.get(url),200,url);
    return response('not found',404,url);
  };
  const maintenance={status:()=>({sources:[]}),async verify(source){verified.push(source);return verify?verify(source):{api:source.api,status:'ok',checkedAt:now()};},async update(){updates++;}};
  const playability={async check(episode){played.push(episode);return play?play(episode):{playable:episode.url.includes('/live.m3u8'),checkedAt:now()};}};
  const service=createSourceDiscovery({store,maintenance,playability,request,now,logger:{error:(...value)=>errors.push(value)}});
  return{service,store,seen,verified,played,errors,maintenance,playability,request,get updates(){return updates;},get maxActive(){return maxActive;}};
}

test('unconfigured public forks are verified before automatic subscription and share a concurrent discovery cycle',async()=>{
  const f=fixture({forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,payload()]])});
  assert.equal(f.seen.length,0);
  const first=f.service.discover(),same=f.service.discover();assert.equal(first,same);
  assert.equal(f.service.status().running,true);
  const result=await first;
  assert.equal(result.running,false);assert.equal(result.lastDiscovery,1000);
  assert.equal(f.store.config().subscriptions.length,1);
  assert.equal(f.store.config().subscriptions[0].url,forkUrl);assert.match(f.store.config().subscriptions[0].id,/^discover-[0-9a-f]{16}$/);
  assert.equal(f.verified.length,1);assert.equal(f.updates,1);assert.ok(f.maxActive<=2);
  assert.equal(result.candidates.find(row=>row.url===forkUrl).added,true);
  await f.service.stop();
});

test('independent curated VOD and TV subscriptions join only after API and playable stream verification',async()=>{
  const json='https://config.example/independent.json',m3u='https://tv.example/channels.m3u';
  const f=fixture({curated:{subscriptions:[{name:'独立公开配置',url:json}],liveSources:[{name:'独立电视列表',url:m3u}]},files:new Map([[json,payload()],[m3u,playlist]])});
  const result=await f.service.discover();
  assert.equal(f.store.config().subscriptions[0].url,json);assert.equal(f.store.config().liveSources[0].url,m3u);
  assert.equal(f.played.length,2);assert.ok(f.played.every(row=>row.url.startsWith('https://tv.example/')));
  assert.ok(result.candidates.filter(row=>row.added).every(row=>['vod','live'].includes(row.kind)));assert.equal(f.updates,1);
  await f.service.stop();
});

test('Bing RSS finds direct GitHub blobs and one-hop HTML subscription links without scripts or recursive navigation',async()=>{
  const blob='https://github.com/OutsideUser/Independent/blob/main/public.json',raw='https://raw.githubusercontent.com/OutsideUser/Independent/main/public.json';
  const page='https://directory.example/links.html',second='https://directory.example/another.html';
  const a='https://config.example/a.json?part=1&token=public',b='https://config.example/b.json',tv='https://tv.example/web.m3u';
  const f=fixture({rssVod:[[blob],[page],[second]],files:new Map([[raw,payload()],[page,'<script>const x="<a href=\'https://config.example/script.json\'>"</script><a href="'+a.replaceAll('&','&amp;')+'">配置</a><a href="'+tv+'">电视</a><a href="/nested.html">递归页</a><a href="http://127.0.0.1/private.json">无效</a>'],[second,'<a href="'+b+'">备用</a>'],[a,payload()],[b,payload()],[tv,playlist]])});
  await f.service.discover();
  assert.equal(f.store.config().subscriptions.length+f.store.config().liveSources.length,4);
  assert.ok(f.seen.includes(raw)&&f.seen.includes(a)&&f.seen.includes(tv));
  assert.ok(!f.seen.some(url=>/script\.json|nested\.html|127\.0\.0\.1/.test(url)));
  assert.ok(f.maxActive<=2);assert.ok(f.seen.length<=24);await f.service.stop();
});

test('general GitHub repository search validates metadata and uses the actual default branch',async()=>{
  const json='https://raw.githubusercontent.com/Independent/FilmConfig/master/config.json',m3u='https://raw.githubusercontent.com/Independent/PublicTV/main/index.m3u';
  const f=fixture({searchVod:[repo('Independent/FilmConfig',{fork:false,default_branch:'master'}),repo('Unsafe/Repo',{default_branch:'../private'})],searchTv:[repo('Independent/PublicTV',{fork:false})],files:new Map([[json,payload()],[m3u,playlist]])});
  await f.service.discover();assert.ok(f.store.config().subscriptions.some(row=>row.url===json));assert.ok(f.store.config().liveSources.some(row=>row.url===m3u));
  assert.ok(!f.seen.some(url=>url.includes('/Unsafe/')));await f.service.stop();
});

test('format repair supports simple address presentation and API aliases before the same validation boundary',async()=>{
  const url='https://config.example/repaired.json';
  const f=fixture({curated:{subscriptions:[{name:'修复配置',url:'config.example/repaired.json'}],liveSources:[]},files:new Map([[url,{api_site:{simple:'catalog.example/api.php/provide/vod',alias:{name:'地址别名',url:'https://catalog.example/another'}}}]])});
  const result=await f.service.discover();assert.equal(f.store.config().subscriptions[0].url,url);
  assert.equal(f.verified[0].api,'https://catalog.example/api.php/provide/vod');assert.ok(result.candidates.find(row=>row.url===url).warnings.length);
  await f.service.stop();
});

test('an existing GitHub blob presentation matches its repaired raw URL without being duplicated or reactivated',async()=>{
  const raw='https://raw.githubusercontent.com/ExistingUser/Config/main/public.json',blob='https://github.com/ExistingUser/Config/blob/main/public.json';
  const store=memoryStore({...empty,subscriptions:[{id:'manual',name:'用户停用',url:blob,enabled:false}]});
  const f=fixture({store,curated:{subscriptions:[{name:'同一公开地址',url:raw}],liveSources:[]},files:new Map([[raw,payload()]])});
  const result=await f.service.discover();assert.equal(store.config().subscriptions.length,1);assert.equal(store.config().subscriptions[0].enabled,false);
  assert.equal(result.candidates.find(row=>row.url===raw).status,'disabled');assert.ok(!f.seen.includes(raw));await f.service.stop();
});

test('private, authenticated, reserved and malformed raw configurations never enter verification or subscriptions',async t=>{
  for(const body of [payload('http://127.0.0.1/private'),payload('https://user:password@catalog.example/api'),'{bad-json',
    '{"api_site":{"__proto__":{"name":"无效标识","api":"https://catalog.example/api"}}}'])await t.test(String(body).slice(0,40),async()=>{
    const f=fixture({forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,body]])});
    const result=await f.service.discover();assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.verified.length,0);
    assert.equal(result.candidates.find(row=>row.url===forkUrl).status,'error');await f.service.stop();
  });
});

test('failed or mismatched API validation and unplayable TV segments prevent automatic import',async()=>{
  const json='https://config.example/unverified.json',tv='https://tv.example/unverified.m3u';
  const f=fixture({curated:{subscriptions:[{name:'未验证',url:json}],liveSources:[{name:'不可播放',url:tv}]},files:new Map([[json,payload()],[tv,playlist]]),verify:source=>({api:source.api+'/different',status:'ok'}),play:()=>({playable:false,error:'分片不可访问'})});
  await f.service.discover();assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.store.config().liveSources.length,0);assert.equal(f.updates,0);await f.service.stop();
});

test('duplicates and household capacity limits prevent more than four new rows or twenty subscriptions per kind',async()=>{
  const initial={...empty,subscriptions:Array.from({length:18},(_,i)=>({id:'vod-'+i,name:'现有订阅',url:'https://existing.example/'+i+'.json',enabled:true})),liveSources:Array.from({length:18},(_,i)=>({id:'tv-'+i,name:'现有电视',url:'https://existing.example/'+i+'.m3u',enabled:true}))};
  const subscriptions=Array.from({length:5},(_,i)=>({name:'发现影视',url:'https://config.example/'+i+'.json'}));
  const liveSources=Array.from({length:5},(_,i)=>({name:'发现电视',url:'https://tv.example/'+i+'.m3u'}));
  const files=new Map([...subscriptions.map(row=>[row.url,payload()]),...liveSources.map(row=>[row.url,playlist])]);
  const f=fixture({store:memoryStore(initial),curated:{subscriptions:[...subscriptions,subscriptions[0]],liveSources},files});
  const result=await f.service.discover();assert.equal(f.store.config().subscriptions.length,20);assert.equal(f.store.config().liveSources.length,20);
  assert.equal(result.candidates.filter(row=>row.added).length,4);assert.equal(f.seen.filter(url=>url===subscriptions[0].url).length,1);assert.equal(f.verified.length,1);await f.service.stop();
});

test('deleted, disabled and URL-edited managed subscriptions remain tombstoned after discovery restart',async()=>{
  const json='https://config.example/managed.json',tv='https://tv.example/managed.m3u',store=memoryStore();
  const options={store,curated:{subscriptions:[{name:'管理影视',url:json}],liveSources:[{name:'管理电视',url:tv}]},files:new Map([[json,payload()],[tv,playlist]])};
  const first=fixture(options);await first.service.discover();await first.service.stop();
  store.setConfig({...store.config(),subscriptions:[{...store.config().subscriptions[0],url:'https://user.example/changed.json'}],liveSources:store.config().liveSources.map(row=>({...row,enabled:false}))});
  const next=fixture(options);await next.service.discover();assert.equal(store.config().subscriptions.length,1);assert.equal(store.config().subscriptions[0].url,'https://user.example/changed.json');assert.equal(store.config().liveSources[0].enabled,false);
  assert.ok(!next.seen.includes(json)&&!next.seen.includes(tv));await next.service.stop();
  store.setConfig({...store.config(),subscriptions:[],liveSources:[]});
  const deleted=fixture(options);await deleted.service.discover();assert.equal(store.config().subscriptions.length+store.config().liveSources.length,0);assert.ok(!deleted.seen.includes(json)&&!deleted.seen.includes(tv));await deleted.service.stop();
});

test('before-write configuration races preserve household edits and do not recreate newly disabled URLs',async t=>{
  for(const disabled of [false,true])await t.test(disabled?'user disabled':'unrelated edit',async()=>{
    const entered=deferred(),release=deferred(),url='https://config.example/race.json';
    const f=fixture({curated:{subscriptions:[{name:'竞态配置',url}],liveSources:[]},files:new Map([[url,payload()]]),verify:async source=>{entered.resolve();await release.promise;return{api:source.api,status:'ok'};}});
    const pending=f.service.discover();await entered.promise;
    f.store.setConfig({...f.store.config(),showAdult:true,platforms:[{id:'household',name:'家庭自定义',url:'https://platform.example/',category:'video',enabled:true}],...(disabled?{subscriptions:[{id:'manual',name:'手动停用',url,enabled:false}]}:{})});release.resolve();
    await pending;assert.equal(f.store.config().showAdult,true);assert.equal(f.store.config().platforms[0].id,'household');assert.equal(f.store.config().subscriptions.length,1);
    assert.equal(f.store.config().subscriptions[0].enabled,!disabled);await f.service.stop();
  });
});

test('the configured VOD and TV baseline is registered before provider fetches so deletion during discovery stays deleted',async()=>{
  const entered=deferred(),release=deferred(),tv='https://tv.example/baseline.m3u';
  const store=memoryStore({...empty,subscriptions:[{id:'existing-vod',name:'既有影视',url:forkUrl,enabled:true}],liveSources:[{id:'existing-tv',name:'既有电视',url:tv,enabled:true}]});
  const f=fixture({store,forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,payload()],[tv,playlist]]),override:async url=>{
    if(url===directory){entered.resolve();await release.promise;return response({subscriptions:[],liveSources:[{name:'发现电视',url:tv}]},200,url);}
  }});
  const pending=f.service.discover();await entered.promise;store.setConfig({...store.config(),subscriptions:[],liveSources:[]});release.resolve();await pending;
  assert.equal(store.config().subscriptions.length+store.config().liveSources.length,0);
  assert.ok(!f.seen.includes(forkUrl)&&!f.seen.includes(tv));await f.service.stop();
});

test('public provider rate limits and CAPTCHA failures preserve configured sources and expose bounded status',async()=>{
  const initial={...empty,sources:[{id:'kept',name:'保留源',api:'https://catalog.example/kept',enabled:true}],subscriptions:[{id:'kept',name:'保留订阅',url:'https://kept.example/config.json',enabled:true}]};
  const f=fixture({store:memoryStore(initial),override:async url=>url.includes('api.github.com')?response('rate limited',429,url):url.includes('bing.com')?response('<html>captcha</html>',200,url):undefined});
  const result=await f.service.discover();assert.deepEqual(f.store.config(),initial);assert.ok(result.candidates.filter(row=>row.kind==='provider'&&row.status==='error').length>=4);assert.ok(result.candidates.length<=20);await f.service.stop();
});

test('unsafe RSS declarations and malformed GitHub metadata cannot create or fetch discovered addresses',async()=>{
  const unsafe=repo('Unsafe/Repo',{default_branch:'branch/unsafe'}),archived=repo('Archived/Repo',{archived:true});
  const f=fixture({forks:[unsafe,archived,repo('../private'),repo('NotFork/Repo',{fork:false})],override:async url=>url.includes('bing.com')?response('<!DOCTYPE rss [<!ENTITY x SYSTEM "http://127.0.0.1/secret">]><rss><channel/></rss>',200,url):undefined});
  await f.service.discover();assert.ok(!f.seen.some(url=>/127\.0\.0\.1|\/Unsafe\/|\/Archived\/|\/NotFork\//.test(url)));assert.equal(f.store.config().subscriptions.length,0);await f.service.stop();
});

test('persisted discovery cursor reaches later usable candidates after a failed prefix and restart',async()=>{
  const store=memoryStore();
  const subscriptions=Array.from({length:20},(_,index)=>({name:'长期失效配置'+index,url:'https://config.example/dead-'+index+'.json'}));
  const options={store,curated:{subscriptions,liveSources:[]},forks:[repo('ResearchUser/PublicConfig')],files:new Map([[forkUrl,payload()]])};
  let f=fixture(options);
  const first=await f.service.discover();
  assert.equal(store.config().subscriptions.length,0);assert.ok(!f.seen.includes(forkUrl));
  assert.ok(JSON.parse(store.meta('source-discovery-v1')).discoveryCursor>0);
  assert.ok(first.candidates.length<=20);assert.ok(f.seen.length<=24);await f.service.stop();
  f=fixture(options);
  const second=await f.service.discover();
  assert.ok(f.seen.includes(forkUrl));assert.equal(store.config().subscriptions[0].url,forkUrl);
  assert.ok(second.candidates.some(row=>row.url===forkUrl&&row.added));
  assert.ok(second.candidates.length<=20);assert.ok(f.seen.length<=24);assert.ok(f.maxActive<=2);await f.service.stop();
});

test('discovery bounds every cycle to twenty-four fetches and two simultaneous HTTP requests',async()=>{
  const subscriptions=Array.from({length:20},(_,i)=>({name:'边界配置'+i,url:'https://config.example/budget-'+i+'.json'}));
  const f=fixture({curated:{subscriptions,liveSources:[]},files:new Map(subscriptions.map(row=>[row.url,payload()])),verify:source=>({api:source.api,status:'error'})});
  const result=await f.service.discover();assert.equal(f.seen.length,24);assert.ok(f.maxActive<=2);assert.ok(result.candidates.some(row=>/次数已达到上限/.test(row.error||'')));assert.equal(f.store.config().subscriptions.length,0);await f.service.stop();
});

test('eight-second deadlines cover response headers and the complete provider response body',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const hung=Object.assign(new Readable({read(){}}),{statusCode:200,headers:{}});
  const f=fixture({override:async url=>{
    if(url.includes('/repos/Stardm0/MoonTV/forks'))return new Promise(()=>{});
    if(url.includes('/repos/katelya77/KatelyaTV/forks'))return hung;
  }});
  const pending=f.service.discover();for(let i=0;i<4;i++)await new Promise(done=>setImmediate(done));
  t.mock.timers.tick(8000);for(let i=0;i<20;i++)await new Promise(done=>setImmediate(done));
  const result=await pending;assert.equal(hung.destroyed,true);assert.equal(result.candidates.filter(row=>row.kind==='provider'&&/超时/.test(row.error||'')).length,2);await f.service.stop();
});

test('JSON, RSS and one-hop HTML response limits reject oversized bodies before import',async()=>{
  const url='https://config.example/oversized.json',page='https://directory.example/oversized.html';
  const f=fixture({curated:{subscriptions:[{name:'过大配置',url}],liveSources:[]},rssTv:[[page]],files:new Map([[url,'x'.repeat(1024*1024+1)],[page,'x'.repeat(256*1024+1)]]),override:async value=>{
    if(value.includes('bing.com')&&!new URL(value).searchParams.get('q').includes('IPTV'))return response('x'.repeat(512*1024+1),200,value);
  }});
  const result=await f.service.discover();assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.verified.length,0);
  assert.equal(result.candidates.filter(row=>/过大/.test(row.error||'')).length,3);await f.service.stop();
});

test('known healthy identical APIs can back a new subscription without redundant API requests',async()=>{
  const store=memoryStore({...empty,sources:[{id:'kept',name:'已验证影视',api:'https://catalog.example/api.php/provide/vod',enabled:true}]}),url='https://config.example/backup.json';
  const f=fixture({store,curated:{subscriptions:[{name:'备用公开配置',url}],liveSources:[]},files:new Map([[url,payload()]])});
  f.maintenance.status=()=>({sources:[{api:'https://catalog.example/api.php/provide/vod',status:'ok',checkedAt:1000}]});
  await f.service.discover();assert.equal(f.verified.length,0);assert.equal(store.config().subscriptions.length,1);await f.service.stop();
});

test('stop waits for the two active provider requests and prevents queued or candidate requests',async()=>{
  const wait=deferred();const f=fixture({override:async url=>{await wait.promise;return response('stopped',503,url);}});
  const pending=f.service.discover();await new Promise(done=>setImmediate(done));
  let stopped=false;const stopping=f.service.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);wait.resolve();
  await stopping;await pending;assert.equal(f.seen.length,2);assert.equal(f.updates,0);assert.equal(f.store.config().subscriptions.length,0);assert.equal(f.service.status().running,false);
});

test('startup and fifteen-minute scheduling are idempotent, persist status and leave no timer after stopping',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});const store=memoryStore(),f=fixture({store,now:Date.now});
  const flush=async()=>{for(let i=0;i<25;i++)await new Promise(done=>setImmediate(done));};
  assert.equal(f.seen.length,0);f.service.start();f.service.start();t.mock.timers.tick(0);await flush();
  const first=f.seen.length;assert.ok(first>0);assert.equal(f.service.status().lastDiscovery,1000);
  t.mock.timers.tick(15*60_000);await flush();assert.equal(f.seen.length,first*2);await f.service.stop();
  t.mock.timers.tick(60*60_000);await flush();assert.equal(f.seen.length,first*2);
  const restarted=fixture({store,now:Date.now});assert.equal(restarted.service.status().lastDiscovery,901000);restarted.service.start();t.mock.timers.tick(0);await flush();assert.ok(restarted.seen.length>0);await restarted.service.stop();
});

test('actual SQLite discovery status and deleted-subscription tombstones persist across reopening',async()=>{
  const directoryPath=await mkdtemp(join(tmpdir(),'vipvideo-discovery-'));let store,service;
  try{
    store=createStore(directoryPath,empty);const options={curated:{subscriptions:[{name:'公开配置',url:forkUrl}],liveSources:[]},files:new Map([[forkUrl,payload()]])};
    let f=fixture({...options,store});service=f.service;await service.discover();await service.stop();store.setConfig({...store.config(),subscriptions:[]});store.close();
    store=createStore(directoryPath,empty);f=fixture({...options,store});service=f.service;assert.equal(service.status().lastDiscovery,1000);await service.discover();assert.equal(store.config().subscriptions.length,0);assert.ok(!f.seen.includes(forkUrl));
  }finally{await service?.stop();store?.close();const target=resolve(directoryPath),root=resolve(tmpdir());assert.ok(target.startsWith(root+sep)&&target.split(sep).at(-1).startsWith('vipvideo-discovery-'));await rm(target,{recursive:true,force:true});}
});

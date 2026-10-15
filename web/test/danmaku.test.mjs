import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createDanmaku } from '../lib/danmaku.mjs';
import { createStore } from '../lib/store.mjs';

const selection={key:'neutral-film-2024',episode:0};

test('automatic sources merge with family messages only when trusted title metadata is supplied',async()=>{
  let calls=0;const auto={list:async()=>{calls++;return{comments:[{id:'external:1',time:3,text:'自动弹幕',color:'#ffffff',origin:'腾讯视频'}],errors:[],sources:[{platform:'腾讯视频',count:1,mode:'auto'}]};}};
  const service=createDanmaku({store:memoryStore(),auto});
  service.send({...selection,time:1,text:'家庭弹幕'});
  assert.equal((await service.list(selection)).comments.length,1);assert.equal(calls,0);
  const result=await service.list({...selection,title:'影片',type:'movie',year:2024});
  assert.equal(result.comments.length,2);assert.equal(calls,1);assert.equal(result.sources[0].platform,'腾讯视频');
});

test('manual binding takes precedence and a new binding suppresses an in-flight automatic match',async()=>{
  let ready,resolve;const started=new Promise(done=>ready=done),waiting=new Promise(done=>resolve=done);
  const service=createDanmaku({store:memoryStore(),request:async()=>response('<i></i>'),auto:{list:async()=>{ready();await waiting;return{comments:[{id:'external:1',time:1,text:'旧自动',color:'#ffffff',origin:'腾讯视频'}],sources:[{platform:'腾讯视频',count:1}],errors:[]};}}});
  const pending=service.list({...selection,title:'影片',type:'movie'});await started;
  await service.bind({...selection,url:'123'});resolve();const result=await pending;
  assert.equal(result.comments.length,0);assert.deepEqual(result.sources,[]);
});

test('Bilibili automatic fallback uses only matching licensed season episodes, never UGC search',async()=>{
  const urls=[];const service=createDanmaku({store:memoryStore(),autoRequest:async()=>{throw new Error('companion unavailable');},request:async url=>{
    urls.push(url);
    if(url.includes('/search/type'))return response(JSON.stringify({code:0,data:{result:[{title:'正片动画',season_id:12},{title:'正片动画剪辑',season_id:13}]}}));
    if(url.includes('/pgc/view/web/season'))return response(JSON.stringify({code:0,result:{title:'正片动画',publish:{pub_time:'2024-01-01'},episodes:[{title:'1',cid:100},{title:'2',cid:101},{title:'2',cid:102,long_title:'预告'}]}}));
    return response('<i><d p="2,1,25,16777215,0,0,0,1">真正第二集</d></i>');
  }});
  const result=await service.list({...selection,title:'正片动画',year:2024,type:'anime',episodeName:'第2集'});
  assert.equal(result.comments.length,1);assert.equal(result.sources[0].platform,'哔哩哔哩');
  assert.ok(urls.includes('https://comment.bilibili.com/101.xml'));assert.ok(!urls.some(url=>new URL(url).searchParams.get('search_type')==='video'));
});
function memoryStore() {
  const meta=new Map(),entries=new Map();let sequence=0;
  return {entries,meta:key=>meta.get(key),setMeta:(key,value)=>meta.set(key,value),list:kind=>[...(entries.get(kind)?.values()||[])].sort((a,b)=>b.updated-a.updated).map(row=>({...row})),save:(kind,row)=>{if(!entries.has(kind))entries.set(kind,new Map());const value={...row,updated:++sequence};entries.get(kind).set(row.key,value);return value;},remove:(kind,key)=>{if(key===null)entries.delete(kind);else entries.get(kind)?.delete(key);}};
}
function response(body,statusCode=200,headers={},finalUrl) {return Object.assign(Readable.from([Buffer.isBuffer(body)?body:Buffer.from(body)]),{statusCode,headers,finalUrl});}
function comment(time=1,text='晴空与海岸',color=16777215,id=1,mode=1) {return `<d p="${time},${mode},25,${color},1700000000,0,ignored,${id}">${text}</d>`;}
const xml=body=>`<?xml version="1.0" encoding="UTF-8"?><i>${body}</i>`;

test('family messages are shared across instances and isolated by film and episode',async()=>{
  const store=memoryStore(),a=createDanmaku({store}),b=createDanmaku({store});
  const sent=a.send({...selection,time:12.5,text:'  晴空  ',color:'#FFAA00'});
  assert.equal(sent.origin,'family');assert.equal(sent.color,'#ffaa00');
  assert.deepEqual((await b.list(selection)).comments,[sent]);
  assert.equal((await b.list({...selection,episode:1})).comments.length,0);
  assert.equal((await b.list({...selection,key:'another-film'})).comments.length,0);
});

test('named episode scopes remain shared across providers and numeric HTTP queries match saved indices', async()=>{
  const service=createDanmaku({store:memoryStore()});
  const sent=service.send({...selection,episode:'第1集',time:3,text:'同一集'});
  assert.deepEqual((await service.list({...selection,episode:' 第1集 '})).comments,[sent]);
  assert.equal((await service.list({...selection,episode:'第2集'})).comments.length,0);
  const numeric=service.send({...selection,time:1,text:'序号兼容'});
  assert.deepEqual((await service.list({...selection,episode:'00'})).comments,[numeric]);
  for(const episode of ['', ' ', '\u0000集', '字'.repeat(501), '-1', '0.5', {}]) assert.throws(()=>service.binding({...selection,episode}),{status:400});
});

test('invalid family text, script markup, times, colors and scope are rejected',()=>{
  const service=createDanmaku({store:memoryStore()});
  for(const value of [null,[],1,'film']) assert.throws(()=>service.send(value),{status:400});
  for(const patch of [{text:''},{text:'字'.repeat(201)},{text:'<script>alert(1)</script>'},{text:'javascript:alert(1)'},{time:-1},{time:Infinity},{color:'red;url(x)'},{color:'#fff'},{episode:-1},{episode:0.5},{key:''}])assert.throws(()=>service.send({...selection,time:1,text:'正常文字',color:'#ffffff',...patch}),{status:400});
});

test('official CID bindings canonicalize and clear without changing family messages',async()=>{
  const service=createDanmaku({store:memoryStore()});
  assert.deepEqual(service.binding(selection),{url:'',offset:0});
  assert.deepEqual(await service.bind({...selection,url:'123456',offset:2}),{url:'https://comment.bilibili.com/123456.xml',offset:2});
  assert.deepEqual(service.binding(selection),{url:'https://comment.bilibili.com/123456.xml',offset:2});
  service.send({...selection,time:1,text:'家庭文字'});
  await service.bind({...selection,url:''});
  assert.deepEqual(service.binding(selection),{url:'',offset:0});
  assert.equal((await service.list(selection)).comments.length,1);
});

test('binding rejects arbitrary URLs, credentials, private addresses and unsupported providers before requests',async()=>{
  let requests=0;const service=createDanmaku({store:memoryStore(),request:async()=>{requests++;throw new Error('unexpected request');}});
  for(const url of ['https://evil.example/123.xml','file:///secret','http://127.0.0.1/1.xml','https://user:password@comment.bilibili.com/1.xml','https://comment.bilibili.com.evil.example/1.xml','https://comment.bilibili.com/1.xml?url=https://evil.example/','https://comment.bilibili.com/0.xml','https://api.dandanplay.net/api/v2/comment/1'])await assert.rejects(service.bind({...selection,url}),error=>[400,403].includes(error.status));
  for(const offset of [-601,601,Infinity,'1'])await assert.rejects(service.bind({...selection,url:'1',offset}),{status:400});
  assert.equal(requests,0);
});

test('BV links resolve only official pagelist and demand an explicit part for multiple pages',async()=>{
  const urls=[];const service=createDanmaku({store:memoryStore(),request:async(url,options)=>{urls.push(url);assert.equal(options.timeout,8000);return response(JSON.stringify({code:0,data:[{page:1,cid:101},{page:2,cid:102}]}));}});
  await assert.rejects(service.bind({...selection,url:'https://www.bilibili.com/video/BV1gp4y1v7xB/'}),error=>error.status===400&&/多个分 P/.test(error.message));
  assert.deepEqual(await service.bind({...selection,url:'https://www.bilibili.com/video/BV1gp4y1v7xB/?p=2',offset:-3}),{url:'https://comment.bilibili.com/102.xml',offset:-3});
  assert.ok(urls.every(url=>new URL(url).origin==='https://api.bilibili.com'));
  await assert.rejects(service.bind({...selection,url:'https://www.bilibili.com/video/BV1gp4y1v7xB/?p=3'}),{status:400});
});

test('a single-page BV identifier binds without guessing another episode',async()=>{
  const service=createDanmaku({store:memoryStore(),request:async()=>response('{"code":0,"data":[{"page":1,"cid":100}]}')});
  assert.equal((await service.bind({...selection,url:'BV1gp4y1v7xB'})).url,'https://comment.bilibili.com/100.xml');
  assert.deepEqual(service.binding({...selection,episode:1}),{url:'',offset:0});
});

test('external XML normalizes entities, color, time and offset without uploading family messages',async()=>{
  const urls=[],service=createDanmaku({store:memoryStore(),request:async url=>{urls.push(url);return response(xml(comment(1,'海岸 &amp; 晴空 &#x4f60;&#22909;',0xffaa00)));}});
  await service.bind({...selection,url:'123',offset:2});
  service.send({...selection,time:1,text:'家庭文字'});
  const result=await service.list(selection);
  assert.equal(result.comments.length,2);assert.equal(result.comments[1].origin,'bilibili');
  assert.equal(result.comments[1].time,3);assert.equal(result.comments[1].color,'#ffaa00');assert.equal(result.comments[1].text,'海岸 & 晴空 你好');
  assert.deepEqual(urls,['https://comment.bilibili.com/123.xml']);
});

test('official raw deflate and ordinary zlib XML both decode within the bounded reader',async()=>{
  for(const compress of [deflateRawSync,deflateSync]){
    const service=createDanmaku({store:memoryStore(),request:async()=>response(compress(xml(comment())),200,{'content-encoding':'deflate'})});
    await service.bind({...selection,url:'123'});assert.equal((await service.list(selection)).comments.length,1);
  }
});

test('unsafe XML, advanced script modes and HTML comments never become executable messages',async()=>{
  for(const body of ['<!DOCTYPE i [<!ENTITY x SYSTEM "file:///secret">]><i></i>','<html><script>x()</script></html>','<?xml-stylesheet href="http://127.0.0.1/"?><i></i>']){
    const service=createDanmaku({store:memoryStore(),request:async()=>response(body)});await service.bind({...selection,url:'123'});
    const result=await service.list(selection);assert.equal(result.comments.length,0);assert.ok(result.errors.length);
  }
  const service=createDanmaku({store:memoryStore(),request:async()=>response(xml(comment(1,'&lt;script&gt;x()&lt;/script&gt;')+comment(2,'code',0xffffff,2,8)+'<!--'+comment(3)+'-->'+comment(4,'保留安全文字',0xffffff,4)))});
  await service.bind({...selection,url:'123'});const result=await service.list(selection);
  assert.equal(result.comments.length,1);assert.equal(result.comments[0].text,'保留安全文字');
});

test('invalid or duplicated external rows are discarded and negative offsets do not invent time zero',async()=>{
  const repeated=comment(1,'相同文字',0xffffff,1);
  const service=createDanmaku({store:memoryStore(),request:async()=>response(xml(repeated+repeated+comment(-1)+comment(2,'字'.repeat(201))+comment(3,'保留',0xffffff,3)))});
  await service.bind({...selection,url:'123',offset:-2});const result=await service.list(selection);
  assert.equal(result.comments.length,1);assert.equal(result.comments[0].time,1);
});

test('external cache persists, expires after five minutes and invalidates on rebinding',async()=>{
  const store=memoryStore();let time=1800000000000,calls=0;
  const request=async()=>{calls++;return response(xml(comment()));};
  let service=createDanmaku({store,request,now:()=>time});await service.bind({...selection,url:'123'});await service.list(selection);
  service=createDanmaku({store,request,now:()=>time});await service.list(selection);assert.equal(calls,1);
  time+=5*60*1000;await service.list(selection);assert.equal(calls,2);
  await service.bind({...selection,url:'456'});await service.list(selection);assert.equal(calls,3);
});

test('concurrent callers deduplicate a CID and cap outbound requests at two',async()=>{
  let calls=0,active=0,maximum=0;
  const service=createDanmaku({store:memoryStore(),request:async()=>{calls++;active++;maximum=Math.max(maximum,active);await new Promise(ok=>setTimeout(ok,8));active--;return response(xml(comment()));}});
  await service.bind({...selection,url:'123'});await Promise.all(Array.from({length:5},()=>service.list(selection)));assert.equal(calls,1);
  for(let episode=1;episode<=4;episode++)await service.bind({...selection,episode,url:String(1000+episode)});
  await Promise.all([1,2,3,4].map(episode=>service.list({...selection,episode})));assert.equal(maximum,2);
});

test('provider failure and redirects retain family messages and expose friendly errors',async()=>{
  for(const mode of ['403','redirect','network']){
    const service=createDanmaku({store:memoryStore(),request:async url=>{if(mode==='network')throw new Error('fixture unavailable');return response(xml(comment()),mode==='403'?403:200,{},mode==='redirect'?'https://evil.example/d.xml':url);}});
    await service.bind({...selection,url:'123'});service.send({...selection,time:1,text:'保留家庭文字'});
    const result=await service.list(selection);assert.equal(result.comments.length,1);assert.equal(result.comments[0].origin,'family');assert.ok(result.errors.length);
  }
});

test('oversized compressed and expanded responses remain bounded',async()=>{
  for(const body of [Buffer.alloc(4*1024*1024+1),deflateRawSync('x'.repeat(4*1024*1024+1))]){
    const service=createDanmaku({store:memoryStore(),request:async()=>response(body,200,{'content-encoding':'deflate'})});await service.bind({...selection,url:'123'});
    const result=await service.list(selection);assert.equal(result.comments.length,0);assert.ok(result.errors.length);
  }
});

test('combined per-episode comments never exceed 5000, preserving new family messages',async()=>{
  const store=memoryStore();const service=createDanmaku({store,request:async()=>response(xml(Array.from({length:5001},(_,i)=>comment(i,'外部'+i,0xffffff,i)).join('')))});
  service.send({...selection,time:0,text:'家庭优先'});await service.bind({...selection,url:'123'});
  assert.equal((await service.list(selection)).comments.length,5000);
  const kind=[...store.entries.keys()].find(key=>key.startsWith('danmaku-family:'));
  for(let i=0;i<5000;i++)store.save(kind,{key:'seed:'+i,id:'family:'+i,time:0,text:'已有文字',color:'#ffffff',origin:'family'});
  const latest=service.send({...selection,time:1,text:'最新文字'});
  const result=await service.list(selection);assert.equal(result.comments.length,5000);assert.ok(result.comments.some(comment=>comment.id===latest.id));
});

test('an in-flight request cannot return comments from a replaced binding',async()=>{
  let release;const service=createDanmaku({store:memoryStore(),request:async()=>new Promise(ok=>{release=()=>ok(response(xml(comment())));})});
  await service.bind({...selection,url:'123'});const inFlight=service.list(selection);
  await service.bind({...selection,url:'456'});release();const result=await inFlight;
  assert.equal(result.comments.length,0);assert.ok(result.errors.length);
});

test('bindings and family messages survive SQLite close and reopen',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vipvideo-danmaku-'));
  t.after(async()=>{const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('vipvideo-danmaku-'));await rm(target,{recursive:true,force:true});});
  let store=createStore(directory,{sources:[]});let service=createDanmaku({store,request:async()=>response(xml(comment()))});
  await service.bind({...selection,url:'123',offset:1});service.send({...selection,time:1,text:'家庭记录'});await service.list(selection);store.close();
  store=createStore(directory,{sources:[]});
  try{service=createDanmaku({store,request:async()=>{throw new Error('cache should survive');}});assert.equal(service.binding(selection).offset,1);assert.equal((await service.list(selection)).comments.length,2);}finally{store.close();}
});

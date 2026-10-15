import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createAutoDanmaku, createDanmakuApiRequest } from '../lib/danmaku-auto.mjs';

const response=(value,statusCode=200)=>Object.assign(Readable.from([JSON.stringify(value)]),{statusCode,headers:{}});
const info={title:'庆余年第二季',year:2024,type:'tv',episodeName:'第2集'};
const episode=(episodeId,url='https://v.qq.com/x/cover/film/part.html',episodeTitle='第2集')=>({episodeId,url,episodeTitle});
const anime=(episodes,title='庆余年第二季 (2024)【腾讯视频】')=>({animeTitle:title,typeDescription:'电视剧',episodes});
const comments=(text='正片弹幕')=>({comments:[{p:'2.5,1,16777215,user',m:text}]});

test('automatically matches the exact work and episode across two real platform identities',async()=>{
  const calls=[];
  const service=createAutoDanmaku({request:async url=>{
    calls.push(new URL(url));
    if(url.includes('/search/'))return response({success:true,animes:[anime([episode(11)]),anime([episode(12,'https://www.iqiyi.com/v_abc.html')])]});
    return response(comments(url.includes('/11?')?'腾讯弹幕':'爱奇艺弹幕'));
  }});
  const result=await service.list(info);
  assert.equal(result.comments.length,2);assert.deepEqual(result.sources.map(row=>row.platform).sort(),['爱奇艺','腾讯视频']);
  assert.equal(calls[0].searchParams.get('anime'),info.title);assert.equal(calls[0].searchParams.get('episode'),'2');
  assert.ok(calls.every(url=>url.origin==='http://danmaku:9321'));
});

test('rejects another season, wrong release year, previews, unrelated titles and untrusted URLs',async()=>{
  const calls=[];const service=createAutoDanmaku({request:async url=>{calls.push(url);return response({success:true,animes:[
    anime([episode(11)],'庆余年第一季 (2024)'),anime([episode(12)],'庆余年第二季 (2019)'),anime([episode(13,'https://v.qq.com/x/cover/film/part.html','第2集 预告')]),
    anime([episode(14,'https://evil.example/film')]),anime([episode(15,'https://v.qq.com.evil.example/film')]),anime([episode(16)],'庆余年第二季 解说'),anime([episode(17,undefined,'第3集')])
  ]});}});
  assert.equal((await service.list(info)).comments.length,0);assert.equal(calls.length,1);
});

test('retains valid platform comments when another platform fails and deduplicates comments',async()=>{
  const service=createAutoDanmaku({request:async url=>url.includes('/search/')?response({success:true,animes:[anime([episode(1),episode(2,'https://www.iqiyi.com/v_abc.html')])]}):url.includes('/1?')?response({comments:[...comments().comments,...comments().comments,{p:'5,1,16777215,user',m:'<script>bad</script>'}]}):response({},503)});
  const result=await service.list(info);assert.equal(result.comments.length,1);assert.equal(result.sources[0].platform,'腾讯视频');assert.equal(result.errors.length,1);
});

test('successful and empty results cache while concurrent identical lookups share work',async()=>{
  let clock=1000,calls=0;const service=createAutoDanmaku({now:()=>clock,request:async()=>{calls++;await new Promise(resolve=>setImmediate(resolve));return response({success:true,animes:[]});}});
  await Promise.all([service.list(info),service.list(info)]);await service.list(info);assert.equal(calls,1);
  clock+=30001;await service.list(info);assert.equal(calls,2);
});

test('missing or ambiguous episode metadata starts no network search',async()=>{
  let calls=0;const service=createAutoDanmaku({request:async()=>{calls++;throw new Error('unexpected');}});
  for(const value of [{},{title:'电影'},{...info,episodeName:'选集'}, {...info,episodeName:'0'}])assert.equal((await service.list(value)).comments.length,0);
  assert.equal(calls,0);
});

test('numeric indices, Chinese episode names, aliases and movies retain exact matching',async()=>{
  const service=createAutoDanmaku({request:async url=>url.includes('/search/')?response({success:true,animes:[anime([episode(1,undefined,'第二集')],'庆余年2 (2024)')]}):response(comments())});
  assert.equal((await service.list({...info,aliases:['庆余年2'],episodeName:'第二集'})).comments.length,1);
  const movie=createAutoDanmaku({request:async url=>url.includes('/search/')?response({success:true,animes:[{animeTitle:'星际穿越 (2014)',typeDescription:'电影',episodes:[episode(2,undefined,'正片')]}]}):response(comments())});
  assert.equal((await movie.list({title:'星际穿越',year:2014,type:'movie',episode:0})).comments.length,1);
});

test('service failure uses a bounded public fallback and does not cache one work as another',async()=>{
  let calls=0;const service=createAutoDanmaku({request:async()=>{throw new Error('DNS');},fallback:async meta=>{calls++;return {comments:[{id:'b',time:1,text:meta.title,color:'#ffffff',origin:'bilibili'}],sources:[{platform:'哔哩哔哩',count:1,mode:'auto'}]};}});
  const first=await service.list(info),other=await service.list({...info,title:'另一部影片'});assert.equal(calls,2);assert.notEqual(first.comments[0].text,other.comments[0].text);
});

test('configured companion transport only allows fixed read APIs and sends no viewer headers',async()=>{
  let calls=0,headers;
  const transport=createDanmakuApiRequest('http://danmaku:9321', {httpRequest:(url,options,done)=>{
    calls++;headers=options.headers;const req=new EventEmitter();req.end=()=>queueMicrotask(()=>done(response({success:true,animes:[]})));req.destroy=error=>req.emit('error',error);return req;
  }});
  await transport('http://danmaku:9321/api/v2/search/episodes?anime=x');assert.equal(calls,1);assert.equal(headers.cookie,undefined);
  for(const url of ['http://danmaku:9321/api/config','http://evil.example/api/v2/comment/1','http://danmaku:9321/api/v2/comment/1#bad','http://user:pass@danmaku:9321/api/v2/comment/1'])await assert.rejects(transport(url));
  assert.equal(calls,1);
});

test('oversized and malformed comment payloads never become trusted comments',async()=>{
  for(const value of ['broken',{comments:[{p:'NaN,1,16777215',m:'bad'},{p:'1,1,-1',m:'bad'},{p:' ,1,',m:'bad'}]}]) {
    const service=createAutoDanmaku({request:async url=>url.includes('/search/')?response({success:true,animes:[anime([episode(1)])]}):response(value)});
    assert.equal((await service.list(info)).comments.length,0);
  }
});

test('actual companion typed source suffix and official episode labels preserve exact identity',async()=>{
  const service=createAutoDanmaku({request:async url=>url.includes('/search/')?response({success:true,animes:[
    anime([episode(1,undefined,'【qq】 庆余年第二季_02')],'庆余年第二季(2024)【电视剧】from tencent'),
    anime([episode(2)],'庆余年第二季(2024)【电视剧】from unknown'),anime([episode(3)],'庆余年第二季【电视剧】from 360')
  ]}):response(comments())});
  assert.equal((await service.list(info)).comments.length,1);
});

test('empty first platforms fall through to the fifth supported platform within the same budget',async()=>{
  const ids=[];const urls=['https://v.qq.com/x/cover/a/a.html','https://www.iqiyi.com/v_a.html','https://v.youku.com/v_show/id_a.html','https://www.mgtv.com/b/1/2.html','https://www.bilibili.com/bangumi/play/ep1'];
  const service=createAutoDanmaku({request:async url=>{
    if(url.includes('/search/'))return response({success:true,animes:[anime(urls.map((url,index)=>episode(index+1,url)))]});
    const id=Number(new URL(url).pathname.split('/').pop());ids.push(id);return response(id===5?comments():{comments:[]});
  }});
  const result=await service.list(info);assert.equal(result.comments.length,1);assert.deepEqual(ids,[1,2,3,4,5]);assert.ok(result.sources.some(row=>row.platform==='哔哩哔哩'&&row.count===1));
});

test('global request queue stays at two active plus sixteen waiting searches',async()=>{
  let release,active=0,maximum=0,calls=0;const gate=new Promise(resolve=>release=resolve);
  const service=createAutoDanmaku({request:async()=>{calls++;active++;maximum=Math.max(maximum,active);await gate;active--;return response({success:true,animes:[]});}});
  const jobs=Array.from({length:24},(_,index)=>service.list({...info,title:'影片'+index}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(maximum,2);release();
  const results=await Promise.all(jobs);assert.equal(calls,18);assert.equal(results.filter(row=>row.errors.length>0).length,6);
});

test('source counts reflect final cross-platform deduplication and combined limit',async()=>{
  const many=Array.from({length:5000},(_,index)=>({p:`${index},1,16777215,user`,m:'相同内容'+index}));
  const service=createAutoDanmaku({request:async url=>url.includes('/search/')?response({success:true,animes:[anime([episode(1),episode(2,'https://www.iqiyi.com/v_a.html')])]}):response({comments:many})});
  const result=await service.list(info);assert.equal(result.comments.length,5000);assert.equal(result.sources.reduce((sum,source)=>sum+source.count,0),result.comments.length);
});

test('a year within the actual film title is retained separately from its release year',async()=>{
  const service=createAutoDanmaku({request:async url=>url.includes('/search/')?response({success:true,animes:[{animeTitle:'2001太空漫游(1968)【电影】from bilibili',typeDescription:'电影',episodes:[episode(1,undefined,'正片')]}]}):response(comments())});
  assert.equal((await service.list({title:'2001太空漫游',year:1968,type:'movie',episodeName:'正片'})).comments.length,1);
});

test('an unqualified alias cannot downgrade S02E01 into a first-season episode',async()=>{
  const requested=[];const service=createAutoDanmaku({request:async url=>{
    if(url.includes('/search/'))return response({success:true,animes:[
      anime([episode(1,undefined,'S01E01')],'某剧(2024)【电视剧】from tencent'),
      anime([episode(2,undefined,'S02E01')],'某剧第二季(2024)【电视剧】from tencent')
    ]});
    requested.push(new URL(url).pathname);return response(comments());
  }});
  const result=await service.list({title:'某剧第二季',aliases:['某剧'],year:2024,type:'tv',episodeName:'S02E01'});
  assert.equal(result.comments.length,1);assert.deepEqual(requested,['/api/v2/comment/2']);
  assert.equal((await service.list({title:'某剧第二季',year:2024,type:'tv',episodeName:'S01E01'})).comments.length,0);
  assert.equal((await service.list({title:'某剧第二季',year:2024,type:'tv',episodeName:'Show_S01E01.1080p.mkv'})).comments.length,0);
  assert.equal((await service.list({title:'某剧第二季',year:2024,type:'tv',episodeName:'Show_S02E01.1080p.mkv'})).comments.length,1);
  assert.equal((await service.list({title:'某剧第二季',year:2024,type:'tv',episodeName:'ShowS02E01.1080p.mkv'})).comments.length,0);
});

test('movie comments require a full-film label or the exact film name and reject clips and previews',async()=>{
  const requested=[];const service=createAutoDanmaku({request:async url=>{
    if(url.includes('/search/'))return response({success:true,animes:[{animeTitle:'电影(2024)【电影】from tencent',typeDescription:'电影',episodes:[episode(1,undefined,'【qq】电影_正片试看'),episode(2,undefined,'【qq】电影片段'),episode(3,undefined,'【qq】随便内容'),episode(4,undefined,'【qq】电影')]}]});
    requested.push(new URL(url).pathname);return response(comments());
  }});
  assert.equal((await service.list({title:'电影',year:2024,type:'movie',episodeName:'正片'})).comments.length,1);
  assert.deepEqual(requested,['/api/v2/comment/4']);
});

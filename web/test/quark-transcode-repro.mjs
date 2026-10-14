// Run with FFMPEG_PATH / FFPROBE_PATH, or inside the application image: node test/quark-transcode-repro.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { createMedia } from '../lib/media.mjs';
import { createQuarkMedia } from '../lib/quark-media.mjs';
import { createRequest } from '../lib/network.mjs';
import { createTranscoder } from '../lib/transcode.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
const root = await mkdtemp(join(tmpdir(), 'vipvideo-quark-repro-'));
const fixtures = join(root, 'fixtures'), jobs = join(root, 'jobs');
const selected = process.argv.slice(2);
assert(selected.every(value => ['seek-range', 'seek-range-slow', 'seek-no-range', 'seek-no-range-slow', 'hevc-main10'].includes(value)), 'Unknown repro case');
const cases = selected.length ? selected : ['seek-range', 'seek-range-slow', 'seek-no-range-slow', 'hevc-main10'];
const requests = [], diagnostics = [], agents = new Set();
let server, cloud, transcoder, activeCase;

async function run(program, args, timeout = 45000) {
  const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-16384); });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    if (code !== 0) throw new Error(`${basename(program)} failed (${code}): ${error}`);
    return output;
  } finally { clearTimeout(timer); }
}
const probe = file => run(ffprobe, ['-v', 'error', '-show_entries',
  'format=duration:stream=codec_name,codec_type,profile,pix_fmt,width,height,r_frame_rate,channels', '-of', 'json', file]).then(JSON.parse);

async function checkOutput(task, label) {
  const directories = await readdir(jobs);
  assert.equal(directories.length, 1);
  const directory = join(jobs, directories[0]), playlist = await readFile(join(directory, 'index.m3u8'), 'utf8');
  const segment = playlist.split(/\r?\n/).find(line => /^segment\d+\.ts$/.test(line));
  assert(segment, `${label}: no complete segment`);
  const media = await probe(join(directory, segment));
  const video = media.streams.find(stream => stream.codec_type === 'video'), audio = media.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264'); assert(video.width <= 1280 && video.height <= 720);
  assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(video.r_frame_rate, '30/1');
  assert.equal(audio?.codec_name, 'aac'); assert.equal(audio.channels, 2);
  await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', join(directory, segment), '-f', 'null', '-']);
  assert.equal(await transcoder.cancel(task.id, 'repro'), true);
  assert.deepEqual(await readdir(jobs), []);
  return { video: video.codec_name, audio: audio.codec_name, width: video.width, height: video.height };
}

try {
  await mkdir(fixtures); await mkdir(jobs);
  const version = (await run(ffmpeg, ['-version'])).split(/\r?\n/)[0];
  console.log(JSON.stringify({ event: 'environment', version, startupTimeout: 20000, cases }));
  if (cases.some(value => value.startsWith('seek-'))) {
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-threads', '1', '-g', '20', '-c:a', 'eac3', '-ac', '6', '-b:a', '384k', join(fixtures, 'short.mkv')]);
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-stream_loop', '-1',
      '-i', join(fixtures, 'short.mkv'), '-t', '300', '-map', '0', '-c', 'copy', '-cues_to_front', '0', join(fixtures, 'long.mkv')]);
    assert(Math.abs(Number((await probe(join(fixtures, 'long.mkv'))).format.duration) - 300) < 0.2);
  }
  if (cases.includes('hevc-main10')) {
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=3840x2160:r=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '0.5', '-map', '0:v:0', '-map', '1:a:0', '-map', '1:a:0', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p10le', '-x265-params', 'pools=1:frame-threads=1:keyint=120:min-keyint=120:scenecut=0',
      '-threads', '1', '-c:a:0', 'dca', '-b:a:0', '768k', '-c:a:1', 'eac3', '-b:a:1', '384k', '-strict', '-2', '-ac', '6', join(fixtures, 'main10-seed.mkv')], 60000);
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-stream_loop', '-1',
      '-i', join(fixtures, 'main10-seed.mkv'), '-t', '4', '-map', '0', '-c', 'copy', join(fixtures, 'main10.mkv')]);
    const original = await probe(join(fixtures, 'main10.mkv'));
    const video = original.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'hevc'); assert.equal(video.profile, 'Main 10'); assert.equal(video.pix_fmt, 'yuv420p10le');
    assert.equal(video.width, 3840); assert.equal(video.height, 2160); assert.equal(video.r_frame_rate, '60/1');
    for (const codec of ['eac3', 'dts']) assert(original.streams.some(stream => stream.codec_name === codec && stream.channels === 6));
    console.log(JSON.stringify({ event: 'fixture', format: 'HEVC Main10 2160p60', audio: ['DTS 5.1', 'EAC3 5.1'], bytes: (await stat(join(fixtures, 'main10.mkv'))).size }));
  }
  server = createServer(async (req, res) => {
    const record = { case: activeCase, range: req.headers.range || '', status: 200, bytes: 0, aborted: false };
    requests.push(record);
    try {
      const path = new URL(req.url, 'http://fixture.invalid').pathname;
      assert(['/long.mkv', '/main10.mkv'].includes(path));
      const file = join(fixtures, path.slice(1)), info = await stat(file);
      let start = 0, end = info.size - 1;
      if (!activeCase.startsWith('seek-no-range')) {
        res.setHeader('Accept-Ranges', 'bytes');
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range); assert(match);
          start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
          if (start >= info.size || end < start) { record.status = res.statusCode = 416; res.setHeader('Content-Range', `bytes */${info.size}`); res.end(); return; }
          record.status = res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
        }
      }
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') { res.end(); return; }
      const source = createReadStream(file, { start, end, highWaterMark: 65536 });
      source.on('data', chunk => { record.bytes += chunk.length; });
      if (activeCase.endsWith('-slow')) {
        const throttle = new Transform({ transform(chunk, _encoding, callback) { setTimeout(() => callback(null, chunk), 64); } });
        await pipeline(source, throttle, res);
      } else await pipeline(source, res);
    } catch (error) {
      record.aborted = req.aborted || res.destroyed;
      record.error = error.code || error.name;
      if (!res.destroyed) { res.statusCode = 500; res.end('fixture failed'); }
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  // Only test transport maps the validated public fixture host onto the local byte server.
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpRequest: (url, options, callback) => {
    assert.equal(url.origin, 'http://video.quark.cn'); agents.add(options.agent);
    return httpRequest({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname }, callback);
  } });
  cloud = createQuarkMedia({ request, quark: { playback: async () => ({
    episode: { type: 'mkv', url: `http://video.quark.cn/${activeCase === 'hevc-main10' ? 'main10.mkv' : 'long.mkv'}` },
    headers: { 'user-agent': 'controlled-fixture' }, allowCookieOrigins: [], metadata: { requiresCompatibility: true },
  }) } });
  transcoder = createTranscoder({ media: createMedia(), tmpRoot: jobs,
    env: { ...process.env, FFMPEG_PATH: ffmpeg, TRANSCODE_ENABLED: 'true', TRANSCODE_ACCEL: 'software', TRANSCODE_ALLOW_SOFTWARE: 'true' },
    logger: { error: (...values) => { const text = values.join(' '); diagnostics.push(text); console.error(text); } } });
  for (const name of cases) {
    activeCase = name; const before = requests.length, start = Date.now(), position = name.startsWith('seek-') ? 281 : 0;
    const lease = await cloud.playback('fixture', { owner: 'repro' });
    try {
      const task = await transcoder.start({ episode: lease.episode, mediaOverride: lease.media, proxyPath: lease.proxyPath,
        valid: lease.valid, owner: 'repro', position });
      const startupMs = Date.now() - start; assert(startupMs < 20000);
      const output = await checkOutput(task, name), ranges = requests.slice(before);
      if (name.startsWith('seek-range')) assert(ranges.some(row => /^bytes=[1-9]\d*-/.test(row.range)), 'Remote MKV seek must issue a nonzero Range');
      console.log(JSON.stringify({ event: 'case', name, status: 'passed', startupMs, position, output, requests: ranges }));
    } catch (error) {
      console.log(JSON.stringify({ event: 'case', name, status: name.startsWith('seek-no-range') ? 'rejected' : 'failed', startupMs: Date.now() - start, position,
        error: error.message, code: error.status, errorCode: error.code, requests: requests.slice(before), diagnostics: diagnostics.slice(-1) }));
      if (!name.startsWith('seek-no-range')) throw error;
      assert.equal(error.code, 'TRANSCODE_INPUT_NOT_SEEKABLE');
      assert(Date.now() - start < 8000, 'Unsupported remote seek must fail before the old 20-second startup timeout');
      const restartedAt = Date.now(), restarted = await transcoder.start({ episode: lease.episode, mediaOverride: lease.media, proxyPath: lease.proxyPath,
        valid: lease.valid, owner: 'repro', position: 0 });
      assert.equal(restarted.startPosition, 0);
      const output = await checkOutput(restarted, name);
      console.log(JSON.stringify({ event: 'from-start', name, status: 'passed', startupMs: Date.now() - restartedAt, position: 0, output }));
    } finally { cloud.invalidate(); }
  }
  console.log(JSON.stringify({ event: 'complete', cases }));
} finally {
  await transcoder?.close(); cloud?.invalidate();
  for (const agent of agents) agent.destroy();
  if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  const path = resolve(root); assert(path.startsWith(resolve(tmpdir()) + sep) && basename(path).startsWith('vipvideo-quark-repro-'));
  await rm(path, { recursive: true, force: true });
}

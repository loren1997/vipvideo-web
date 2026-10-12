// CI: docker exec -i <container> node --input-type=module < web/test/transcode-smoke.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { createMedia } = await import(pathToFileURL(join(process.cwd(), 'lib/media.mjs')));
const { createTranscoder } = await import(pathToFileURL(join(process.cwd(), 'lib/transcode.mjs')));
const executable = process.env.FFMPEG_PATH || 'ffmpeg';
const root = await mkdtemp(join(tmpdir(), 'vipvideo-transcode-smoke-'));
const fixtures = join(root, 'fixtures'), jobs = join(root, 'jobs');
const requests = [];
let transcoder, server;

function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} failed`);
  return result.stdout;
}
const probe = file => JSON.parse(run('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height', '-of', 'json', file,
]));

try {
  await mkdir(fixtures, { mode: 0o700 });
  await mkdir(jobs, { mode: 0o700 });
  const input = join(fixtures, 'source.mp4');
  run(executable, ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-filter_threads', '2',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '8', '-c:v', 'mpeg4', '-q:v', '5', '-g', '50', '-threads', '2',
    '-c:a', 'ac3', '-b:a', '96k', '-movflags', '+faststart', input]);
  const original = probe(input);
  assert(original.streams.some(stream => stream.codec_name === 'mpeg4'));
  assert(original.streams.some(stream => stream.codec_name === 'ac3'));
  const originalDuration = Number(original.format.duration);
  await writeFile(join(fixtures, 'key.bin'), randomBytes(16));
  await writeFile(join(fixtures, 'key.info'), `https://fixtures.example/key.bin?signature=key\n${join(fixtures, 'key.bin')}\n`);
  // MP4 的 MPEG-4 初始化头不能直接复制进独立 TS；MPEG-2 在关键帧重复序列头。
  run(executable, ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-threads', '2', '-filter_threads', '2', '-i', input,
    '-c:v', 'mpeg2video', '-q:v', '5', '-g', '50', '-threads', '2', '-c:a', 'copy',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_key_info_file', join(fixtures, 'key.info'),
    '-hls_segment_filename', join(fixtures, 'input%03d.ts'), join(fixtures, 'source.m3u8')]);
  await writeFile(join(fixtures, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nsource.m3u8?signature=playlist&part=1\n');
  const fixtureNames = new Set(await readdir(fixtures));
  // 固定公网样例通过 DI 映射为本地字节；生产网络校验保持启用。
  const media = createMedia({ request: async (value, options = {}) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://fixtures.example');
    const name = url.pathname.slice(1);
    assert(fixtureNames.has(name) && name === basename(name));
    requests.push(url.href);
    let body = await readFile(join(fixtures, name));
    const headers = { 'content-type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' :
      name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream',
      'accept-ranges': 'bytes', 'content-length': String(body.length) };
    let statusCode = 200;
    if (options.headers?.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(options.headers.range);
      assert(match);
      const start = match[1] ? Number(match[1]) : Math.max(0, body.length - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      if (start >= body.length || end < start) {
        statusCode = 416; headers['content-range'] = `bytes */${body.length}`; body = Buffer.alloc(0);
      } else {
        statusCode = 206; headers['content-range'] = `bytes ${start}-${end}/${body.length}`; body = body.subarray(start, end + 1);
      }
      headers['content-length'] = String(body.length);
    }
    return Object.assign(Readable.from(options.method === 'HEAD' ? [] : [body]), { statusCode, headers, finalUrl: url.href });
  } });
  transcoder = createTranscoder({ media, tmpRoot: jobs, startupTimeout: 60000, probeTimeout: 10000,
    env: { ...process.env, TRANSCODE_ENABLED: 'true', TRANSCODE_ACCEL: 'software', FFMPEG_PATH: executable } });
  const status = await transcoder.status();
  assert.equal(status.available, true); assert.equal(status.enabled, true);
  server = createServer(async (req, res) => {
    try {
      const match = /^\/api\/transcode\/([a-f0-9]{32})\/(index\.m3u8|segment\d+\.ts)$/.exec(new URL(req.url, 'http://localhost').pathname);
      assert(match); await transcoder.serve(req, res, match[1], match[2]);
    } catch (error) { res.statusCode = error.status || 500; res.end(error.message); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const sample of [{ type: 'mp4', path: 'source.mp4?signature=mp4', position: 0, speed: 1 },
    { type: 'hls', path: 'master.m3u8?signature=master', position: 3, speed: 1.5 }]) {
    const task = await transcoder.start({ episode: { url: `https://fixtures.example/${sample.path}`, type: sample.type },
      position: sample.position, speed: sample.speed, owner: 'ci-smoke', valid: () => true });
    assert.equal(task.startPosition, sample.position); assert.equal(task.acceleration, 'software');
    assert.equal((await transcoder.status()).running, true);
    let playlist = '';
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const response = await fetch(origin + task.url, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); playlist = await response.text();
      if (playlist.includes('#EXT-X-ENDLIST')) break;
      await wait(250);
    }
    assert(playlist.includes('#EXT-X-ENDLIST'), 'Synthetic transcode did not finish');
    const output = join(root, `output-${sample.type}`); await mkdir(output);
    const names = playlist.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    assert(names.length >= 2);
    for (const name of names) {
      assert(/^segment\d{6,12}\.ts$/.test(name));
      const response = await fetch(new URL(name, origin + task.url), { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); await writeFile(join(output, name), Buffer.from(await response.arrayBuffer()));
    }
    await writeFile(join(output, 'index.m3u8'), playlist);
    const actual = probe(join(output, 'index.m3u8'));
    const video = actual.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video?.codec_name, 'h264'); assert(video.width <= 1280 && video.height <= 720);
    assert.equal(actual.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
    const duration = Number(actual.format.duration);
    assert(Math.abs(duration - (originalDuration - sample.position)) < 0.4,
      `${sample.type} offset/readrate changed duration: ${duration}`);
    run(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2',
      '-i', join(output, 'index.m3u8'), '-f', 'null', '-']);
    assert.equal(await transcoder.cancel(task.id, 'ci-smoke'), true);
    assert.deepEqual(await readdir(jobs), []);
    assert.equal((await transcoder.status()).running, false);
    assert.equal((await fetch(origin + task.url, { signal: AbortSignal.timeout(5000) })).status, 404);
    console.log(`${process.arch} ${sample.type}: H.264/AAC ${video.width}x${video.height}, offset=${sample.position}, speed=${sample.speed}, duration=${duration}; stop removed task files.`);
  }
  assert(requests.some(url => url.includes('source.m3u8?signature=playlist&part=1')));
  assert(requests.some(url => url.includes('key.bin?signature=key')));
  console.log('Real FFmpeg media bridge/transcode/seek/AES-128 HLS smoke passed.');
} finally {
  await transcoder?.close();
  if (server?.listening) { server.closeIdleConnections(); await new Promise(done => server.close(done)); }
  const path = resolve(root);
  assert(path.startsWith(resolve(tmpdir()) + sep) && basename(path).startsWith('vipvideo-transcode-smoke-'));
  await rm(path, { recursive: true, force: true });
}

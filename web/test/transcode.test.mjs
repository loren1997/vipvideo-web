import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { createTranscoder, supportsDolbyMapping } from '../lib/transcode.mjs';
import { createMedia } from '../lib/media.mjs';

const url = 'https://movies.example/feature.m3u8?access=neutral';
const episode = { url, type: 'hls' };
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment000000.ts\n';
const inputManifest = '#EXTM3U\n#EXTINF:2,\nsegment.ts?token=neutral\n#EXT-X-ENDLIST\n';
const statusError = status => error => error.status === status;
function assertRawInput(args) {
  const input = args.slice(0, args.indexOf('-i'));
  assert.equal(input.includes('-f'), false);
  assert.equal(input[input.indexOf('-format_whitelist') + 1], 'mov,matroska,webm,mpegts,avi');
  assert.equal(input[input.indexOf('-protocol_whitelist') + 1], 'http,tcp,crypto');
}
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vipvideo-transcode-test-'));
  const device = options.gpu ? join(root, 'gpu') : options.device || join(root, 'missing-gpu');
  if (options.gpu) await writeFile(device, 'device');
  const calls = [], requests = [], logs = [], children = [];
  const files = options.files || new Map([[url, [inputManifest, 'application/vnd.apple.mpegurl']], ['https://movies.example/segment.ts?token=neutral', [Buffer.alloc(752, 0x47), 'video/mp2t']]]);
  const media = options.media || createMedia({ secret: Buffer.alloc(32, 7), request: async (target, requestOptions) => {
    requests.push({ url: String(target), ...requestOptions });
    const [body, contentType] = files.get(String(target)) || ['not found', 'text/plain'];
    return Object.assign(Readable.from([body]), { statusCode: files.has(String(target)) ? 200 : 404, headers: { 'content-type': contentType }, finalUrl: String(target) });
  } });
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.windowsHide, true);
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough(); child.signals = []; children.push(child);
    if (options.pid !== undefined) child.pid = options.pid;
    child.exit = code => { if (child.finished) return; child.finished = true; child.emit('exit', code); child.emit('close', code); };
    child.kill = signal => { child.signals.push(signal); if (!options.ignoreKill || signal === 'SIGKILL') queueMicrotask(() => child.exit(0)); return true; };
    setImmediate(async () => {
      try {
        if (args[0] === '-version') {
          if (options.missing) child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
          else if (!options.hungVersion) child.exit(0);
          return;
        }
        if (args.includes('-show_entries')) {
          if (options.colorProbeDelay) await new Promise(done => setTimeout(done, options.colorProbeDelay));
          if (child.finished) return;
          if (options.inspect) await options.inspect({ child, args, input: args[args.indexOf('-i') + 1] });
          if (child.finished) return;
          if (!options.hungColorProbe) { child.stdout.write(options.colorProbeBody ?? JSON.stringify(options.colorProbe ?? { streams: [{ color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }], frames: [{ color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }] })); child.exit(0); }
          return;
        }
        if (options.run) { await options.run({ child, args, write: () => output(args), input: args[args.indexOf('-i') + 1] }); return; }
        await output(args);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  async function output(args) {
    const dir = join(args.at(-1), '..');
    await writeFile(join(dir, 'segment000000.ts'), Buffer.alloc(752, 0x47));
    const dolby = args.some(value => value.includes('apply_dolbyvision=1'));
    if (dolby) await writeFile(join(dir, 'segment000001.ts'), Buffer.alloc(752, 0x47));
    await writeFile(args.at(-1), manifest + (dolby ? '#EXTINF:2,\nsegment000001.ts\n' : ''));
  }
  const service = createTranscoder({ media, spawn, tmpRoot: root, device, env: { TRANSCODE_ACCEL: 'software', ...options.env }, startupTimeout: 1000, pollInterval: 5, killTimeout: 10, probeTimeout: 30, idleTimeout: 5000, logger: { error: (...args) => logs.push(args.join(' ')) }, ...options.di });
  return { service, root, calls, requests, logs, children, async close() {
    await service.close(); const target = resolve(root), base = resolve(tmpdir());
    assert.ok(target.startsWith(base + sep) && target.split(sep).at(-1).startsWith('vipvideo-transcode-test-'));
    await rm(root, { recursive: true, force: true });
  } };
}
const start = (service, overrides = {}) => service.start({ episode, position: 0, speed: 1, owner: 'device-a', valid: () => true, ...overrides });
const dolbyProbe = (profile = 5, compatibility = 0) => ({
  streams: [{ codec_name: 'hevc', pix_fmt: 'yuv420p10le', side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: profile, dv_bl_signal_compatibility_id: compatibility, rpu_present_flag: 1, bl_present_flag: 1, el_present_flag: 0 }] }],
  frames: [{ pix_fmt: 'yuv420p10le', side_data_list: [{ side_data_type: 'Dolby Vision RPU Data' }] }],
});

// These tests exercise the real signed HTTP bridge and cancellation. Decoder
// correctness is separately checked with the public P5 sample and real FFprobe.
function probeRangeMedia(mode = 'valid', size = 4 * 1024 * 1024 + 17) {
  const calls = [], streams = [];
  const media = createMedia({ secret: Buffer.alloc(32, 19), request: async (target, options) => {
    calls.push(options.headers.range);
    const match = /^bytes=(\d+)-(\d*)$/.exec(options.headers.range || 'bytes=0-');
    const first = Number(match[1]), last = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1), length = last - first + 1;
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(length), 'content-range': `bytes ${first}-${last}/${mode === 'changed-total' && calls.length > 1 ? size + 1 : size}` };
    if (mode === 'mismatch' || mode === 'missing-length-mismatch') headers['content-range'] = `bytes ${first + 1}-${last}/${size}`;
    if (mode.startsWith('missing-length')) delete headers['content-length'];
    if (mode === 'missing-length-no-range') delete headers['content-range'];
    if (mode === 'bad-length') headers['content-length'] = String(length + 1);
    let response;
    if (mode === 'stalled' || mode === 'missing-length-abrupt') {
      response = new PassThrough(); response.write(Buffer.alloc(1));
      if (mode === 'missing-length-abrupt') setImmediate(() => response.destroy(new Error('fixture upstream truncated')));
    }
    else response = Readable.from([Buffer.alloc(mode === 'overlong' || mode === 'missing-length-overlong' ? length + 1 : mode === 'short' || mode === 'missing-length-short' ? length - 1 : length)]);
    streams.push(response);
    return Object.assign(response, { statusCode: mode === 'ignored' ? 200 : 206, headers, finalUrl: String(target) });
  } });
  return { media, calls, streams, setMode: value => { mode = value; } };
}
const rawDolby = { url: 'https://movies.example/original.mkv', type: 'mkv', colorSpace: 'dolby-vision' };
const trustedDolbyProof = { colorSpace: 'dolby-vision', codec: 'hevc', dolbyVisionProfile: 5, dolbyVisionCompatibilityId: 0, rpuPresent: true, rpuSeen: true, blPresent: true, elPresent: false };

test('trusted original Dolby proof avoids duplicate inspection and keeps encoder range limits', async () => {
  const source = probeRangeMedia('valid', 9 * 1024 * 1024);
  const f = await fixture({ media: source.media, hungColorProbe: true, run: async ({ input, args, write }) => {
    assert.ok(args.some(value => value.includes('apply_dolbyvision=1')));
    const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 8 * 1024 * 1024);
    await write();
  } });
  try {
    await start(f.service, { episode: { ...rawDolby, sourceColorSpace: 'dolby-vision' }, trustedColorProbe: trustedDolbyProof });
    assert.equal(f.calls.filter(call => call.args.includes('-show_entries')).length, 0);
    assert.deepEqual(source.calls, ['bytes=0-8388607']);
  } finally { await f.close(); }
});

test('trusted original Dolby proof never substitutes missing RPU or a different stream kind', async () => {
  for (const [episode, proof] of [
    [{ ...rawDolby, sourceColorSpace: 'dolby-vision' }, { ...trustedDolbyProof, rpuSeen: false }],
    [{ ...rawDolby, sourceColorSpace: 'dolby-vision' }, { ...trustedDolbyProof, rpuPresent: false }],
    [{ ...rawDolby, sourceColorSpace: 'dolby-vision' }, { ...trustedDolbyProof, colorSpace: 'pq' }],
    [{ ...rawDolby, sourceColorSpace: 'dolby-vision' }, { ...trustedDolbyProof, dolbyVisionProfile: 7 }],
    [{ ...rawDolby, sourceColorSpace: 'unknown' }, trustedDolbyProof],
    [{ ...rawDolby, url, type: 'hls', sourceColorSpace: 'dolby-vision' }, trustedDolbyProof],
  ]) {
    const colorProbe = dolbyProbe(); colorProbe.frames[0].side_data_list = [];
    const f = await fixture({ colorProbe });
    try {
      await assert.rejects(start(f.service, { episode, trustedColorProbe: proof }), error => error.status === 409 && /RPU/.test(error.message));
      assert.equal(f.calls.filter(call => call.args.includes('-show_entries')).length, 1);
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
    } finally { await f.close(); }
  }
});

test('trusted original Dolby proof does not authorize an expired lease', async () => {
  const f = await fixture();
  try {
    await assert.rejects(start(f.service, { episode: { ...rawDolby, sourceColorSpace: 'dolby-vision' }, trustedColorProbe: trustedDolbyProof, valid: () => false }), statusError(409));
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('real MP4 color inspection skips chapter reads and finds tail metadata across many mdat boxes', { timeout: 20000 }, async t => {
  const { spawn, execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? join(ffmpeg, '..', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
  const run = (command, args) => promisify(execFile)(command, args, { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Local FFmpeg and FFprobe are required for the native chapter fixture'); throw error; }
  let data; const requests = [], bodies = new Set(), children = new Set();
  const media = createMedia({ request: async (target, options) => {
    assert.equal(String(target), 'https://fixtures.example/chapters.mp4');
    const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range), first = Number(range[1]), last = Math.min(Number(range[2]), data.size - 1);
    assert.ok(last - first + 1 <= 2 * 1024 * 1024); requests.push(first);
    const body = data.read(first, last), response = Readable.from((async function* () {
      // Network-sized chunks let FFprobe cancel a seek without pre-counting a whole window.
      for (let offset = 0; offset < body.length; offset += 8192) { yield body.subarray(offset, offset + 8192); await new Promise(done => setTimeout(done, 1)); }
    })());
    bodies.add(response); response.once('close', () => bodies.delete(response));
    return Object.assign(response, { statusCode: 206, finalUrl: String(target), headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${first}-${last}/${data.size}` } });
  } });
  const f = await fixture({ media, di: { env: { FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe }, spawn: (command, args, options) => {
    const child = spawn(command, args, options); children.add(child); child.once('close', () => children.delete(child)); return child;
  } } });
  try {
    const metadata = ';FFMETADATA1\n' + Array.from({ length: 24 }, (_, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${i * 80}\nEND=${(i + 1) * 80}\ntitle=Chapter ${i + 1}\n`).join('');
    const meta = join(f.root, 'chapters.txt'), input = join(f.root, 'source.mp4'); await writeFile(meta, metadata);
    await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1', '-i', meta,
      '-map', '0:v:0', '-map_metadata', '1', '-map_chapters', '1', '-frames:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', input]);
    const source = await readFile(input);
    for (const count of [1, 40]) await t.test(count === 1 ? 'sparse chapter titles do not consume probe reads' : 'forty mdat headers preserve the first video frame within the read budget', async () => {
      data = sparseChapterMp4(source, count); requests.length = 0;
      // The Dolby hint activates the original-file guard; this synthetic frame is SDR.
      const proof = await f.service.inspectColor({ episode: { type: 'mp4', url: 'https://fixtures.example/chapters.mp4', colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'native-chapter-test', valid: () => true, timeout: 10000 });
      assert.equal(proof.codec, 'h264'); assert.equal(proof.colorSpace, 'sdr');
      assert.equal(requests.filter(offset => data.chapterOffsets.includes(offset)).length, 0, 'color inspection must not fetch unrelated chapter samples');
      assert.ok(count === 1 ? requests.length < 16 : requests.length > 16 && requests.length <= 64);
      assert.equal(supportsDolbyMapping(proof), false, 'a synthetic SDR frame cannot pass Dolby mapping');
    });
  } finally { await f.close(); assert.equal(bodies.size, 0); assert.equal(children.size, 0); }
});

test('real color inspection decodes a first frame spanning bounded HTTP ranges', { timeout: 20000 }, async t => {
  const { spawn, execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? join(ffmpeg, '..', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
  const run = (command, args) => promisify(execFile)(command, args, { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Local FFmpeg and FFprobe are required for the native range fixture'); throw error; }
  let data, contentLength = true; const requests = [], frames = [], bodies = new Set(), children = new Set();
  const media = createMedia({ request: async (target, options) => {
    assert.equal(String(target), 'https://fixtures.example/large-first-frame.mp4');
    const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range); assert.ok(range);
    const first = Number(range[1]), last = Math.min(Number(range[2]), data.length - 1); requests.push(first);
    assert.ok(last >= first && last - first + 1 <= 2 * 1024 * 1024);
    const response = Readable.from((async function* () {
      for (let at = first; at <= last; at += 8192) { yield data.subarray(at, Math.min(at + 8192, last + 1)); await new Promise(done => setImmediate(done)); }
    })());
    bodies.add(response); response.once('close', () => bodies.delete(response));
    return Object.assign(response, { statusCode: 206, finalUrl: String(target), headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${first}-${last}/${data.length}`, ...(contentLength ? { 'content-length': String(last - first + 1) } : {}) } });
  } });
  const f = await fixture({ media, di: { env: { FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe }, spawn: (command, args, options) => {
    const child = spawn(command, args, options); children.add(child); let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('close', () => { children.delete(child); if (args.includes('-show_entries')) { let result; try { result = JSON.parse(stdout); } catch {} frames.push(result?.frames?.length || 0); } });
    return child;
  } } });
  try {
    const input = join(f.root, 'single-frame.mp4');
    await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1', '-frames:v', '1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', input]);
    const decoded = JSON.parse((await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=color_space,color_transfer,color_primaries', '-of', 'json', input])).stdout);
    assert.equal(decoded.frames.length, 1, 'the generated fixture must decode before testing HTTP');
    for (const key of ['color_space', 'color_transfer', 'color_primaries']) assert.equal(decoded.frames[0][key], 'bt709');
    const source = await readFile(input), atoms = [];
    function scan(first, last) {
      for (let at = first; at < last;) {
        const size = source.readUInt32BE(at), type = source.toString('ascii', at + 4, at + 8); assert.ok(size >= 8 && at + size <= last); atoms.push({ at, size, type });
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) scan(at + 8, at + size); at += size;
      }
    }
    scan(0, source.length); const mdat = atoms.find(atom => atom.type === 'mdat'), moov = atoms.find(atom => atom.type === 'moov'), stsz = atoms.find(atom => atom.type === 'stsz');
    assert.ok(moov.at > mdat.at); assert.equal(source.readUInt32BE(stsz.at + 16), 1); assert.equal(source.readUInt32BE(stsz.at + 12), mdat.size - 8);
    // A valid filler NAL keeps the frame tiny while placing its IDR beyond the first two MiB.
    const filler = Buffer.alloc(2 * 1024 * 1024 + 65542, 0xff); filler.writeUInt32BE(filler.length - 4); filler[4] = 12; filler[filler.length - 1] = 0x80;
    source.writeUInt32BE(mdat.size - 8 + filler.length, stsz.at + 12); source.writeUInt32BE(mdat.size + filler.length, mdat.at);
    data = Buffer.concat([source.subarray(0, mdat.at + 8), filler, source.subarray(mdat.at + 8)]);
    for (contentLength of [true, false]) await t.test(contentLength ? 'upstream supplies Content-Length' : 'upstream has no Content-Length', async () => {
      requests.length = 0;
      const proof = await f.service.inspectColor({ episode: { type: 'mp4', url: 'https://fixtures.example/large-first-frame.mp4', colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'native-range-test', valid: () => true, timeout: 6000 });
      t.diagnostic(JSON.stringify({ contentLength, ranges: requests, decodedFrames: frames.at(-1), codec: proof.codec, colorSpace: proof.colorSpace }));
      assert.equal(frames.at(-1), 1, 'the probe must receive and decode the entire first packet');
      assert.equal(proof.codec, 'h264'); assert.equal(proof.colorSpace, 'sdr'); assert.equal(supportsDolbyMapping(proof), false);
      assert.ok(requests.includes(mdat.at + 8 + 2 * 1024 * 1024), 'the next bounded read resumes exactly where the first window ended');
      assert.ok(requests.length <= 8, 'reconnect cannot loop at the real end of the file');
    });
  } finally { await f.close(); assert.equal(bodies.size, 0); assert.equal(children.size, 0); }
});

test('real raw input detection accepts renamed Matroska and rejects referenced playlists', { timeout: 30000 }, async t => {
  const { spawn, execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? join(ffmpeg, '..', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
  const run = (command, args) => promisify(execFile)(command, args, { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Local FFmpeg and FFprobe are required for native container detection'); throw error; }
  let body = Buffer.alloc(0), referenceRequests = 0, hlsSuffix = false; const children = new Set(), streams = new Set();
  const canary = createServer((_req, res) => { referenceRequests++; res.statusCode = 403; res.end(); });
  await new Promise(done => canary.listen(0, '127.0.0.1', done));
  const sourceUrl = 'https://fixtures.example/renamed.mp4', reference = `http://127.0.0.1:${canary.address().port}/forbidden.ts`;
  const media = createMedia({ request: async (target, options) => {
    assert.equal(String(target), sourceUrl);
    const range = /^bytes=(\d+)-(\d*)$/.exec(options.headers.range || 'bytes=0-'); assert.ok(range);
    const first = Number(range[1]), last = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    assert.ok(first <= last);
    const response = Readable.from([body.subarray(first, last + 1)]); streams.add(response); response.once('close', () => streams.delete(response));
    return Object.assign(response, { statusCode: 206, finalUrl: String(target), headers: { 'content-type': 'video/mp4', 'content-length': String(last - first + 1), 'content-range': `bytes ${first}-${last}/${body.length}` } });
  } });
  const f = await fixture({ media, di: { env: { TRANSCODE_ACCEL: 'software', FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe }, startupTimeout: 10000, probeTimeout: 6000,
    spawn: (command, args, options) => {
      if (args.includes('-i')) {
        assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp,crypto');
        if (args.includes('-show_entries')) assert.equal(args[args.indexOf('-ignore_chapters') + 1], '1');
        else assert.equal(args.includes('-ignore_chapters'), false);
        // Let the HLS negative case reach the demuxer whitelist instead of
        // stopping earlier at FFmpeg's filename-extension check.
        if (hlsSuffix) { args = [...args]; const input = args.indexOf('-i') + 1; args[input] = args[input].replace('/asset.mp4?', '/asset.m3u8?'); }
      }
      const child = spawn(command, args, options); children.add(child); child.once('close', () => children.delete(child)); return child;
    },
  } });
  const raw = { type: 'mp4', url: sourceUrl };
  try {
    const input = join(f.root, 'renamed.mp4');
    await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=16x16:rate=2:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-g', '4', '-pix_fmt', 'yuv420p',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-f', 'matroska', input]);
    body = await readFile(input); assert.equal(body.readUInt32BE(0), 0x1a45dfa3);
    await t.test('renamed Matroska is inspected from its bytes', async () => {
      const proof = await f.service.inspectColor({ episode: { ...raw, colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'native-container-test', valid: () => true, timeout: 6000 });
      assert.equal(proof.codec, 'h264'); assert.equal(proof.colorSpace, 'sdr');
    });
    await t.test('renamed Matroska produces continuing playable HLS segments', async () => {
      const result = await start(f.service, { episode: { ...raw, colorSpace: 'sdr' } });
      assert.equal(result.duration, 8);
      const dir = join(f.root, (await readdir(f.root)).find(name => name.startsWith('vipvideo-transcode-')));
      const deadline = Date.now() + 6000; let playlist, segments = [];
      do {
        playlist = await readFile(join(dir, 'index.m3u8'), 'utf8');
        segments = playlist.split(/\r?\n/).filter(line => /^segment\d+\.ts$/.test(line));
        if (segments.length < 2) await new Promise(done => setTimeout(done, 25));
      } while (segments.length < 2 && Date.now() < deadline);
      assert.ok(segments.length >= 2, 'the real encoder must progress beyond its first segment');
      for (const segment of segments.slice(0, 2)) {
        const decoded = JSON.parse((await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'json', join(dir, segment)])).stdout);
        assert.equal(decoded.streams[0]?.codec_name, 'h264');
      }
      await f.service.cancel(result.id, 'device-a');
    });
    for (const [name, text] of [
      ['HLS', `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${reference}\n#EXT-X-ENDLIST\n`],
      ['concat', `ffconcat version 1.0\nfile '${reference}'\n`],
    ]) await t.test(`${name} disguised as MP4 cannot make probe or encoder fetch a referenced URL`, async () => {
      body = Buffer.from(text); hlsSuffix = name === 'HLS'; const logStart = f.logs.length;
      await assert.rejects(f.service.inspectColor({ episode: { ...raw, colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'native-container-test', valid: () => true, timeout: 6000 }), error => error.code === 'QUARK_COLOR_UNCONFIRMED');
      await assert.rejects(start(f.service, { episode: { ...raw, colorSpace: 'sdr' } }), statusError(502));
      assert.equal(f.logs.slice(logStart).filter(line => /not on whitelist/i.test(line)).length, 2, 'both native readers must reject the playlist demuxer');
      assert.equal(referenceRequests, 0);
      assert.equal((await f.service.status()).running, false);
    });
  } finally {
    await f.close(); await new Promise(done => canary.close(done));
    assert.equal(referenceRequests, 0); assert.equal(streams.size, 0); assert.equal(children.size, 0);
  }
});

function sparseChapterMp4(source, mdatCount = 1) {
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);
  function boxes(buffer) {
    const result = [];
    for (let at = 0; at < buffer.length;) {
      const size = buffer.readUInt32BE(at), type = buffer.toString('ascii', at + 4, at + 8); assert.ok(size >= 8 && at + size <= buffer.length);
      result.push({ type, at, size, body: buffer.subarray(at + 8, at + size) }); at += size;
    }
    return result;
  }
  function find(buffer, type) {
    for (const box of boxes(buffer)) { if (box.type === type) return box; if (containers.has(box.type)) { const result = find(box.body, type); if (result) return result; } }
  }
  const isChapter = buffer => find(buffer, 'stsd')?.body.toString('ascii', 12, 16) === 'text';
  const top = boxes(source), moov = top.find(box => box.type === 'moov'), mdat = top.find(box => box.type === 'mdat'); assert.ok(moov && mdat);
  const chapter = boxes(moov.body).find(box => box.type === 'trak' && isChapter(box.body)); assert.ok(chapter);
  const stsz = find(chapter.body, 'stsz').body, stsc = find(chapter.body, 'stsc').body, stco = find(chapter.body, 'stco').body;
  const count = stsz.readUInt32BE(8), samples = [], entries = Array.from({ length: stsc.readUInt32BE(4) }, (_, i) => [stsc.readUInt32BE(8 + 12 * i), stsc.readUInt32BE(12 + 12 * i)]);
  for (let chunk = 0, index = 0; chunk < stco.readUInt32BE(4); chunk++) {
    let offset = stco.readUInt32BE(8 + 4 * chunk); const [, perChunk] = entries.filter(([first]) => first <= chunk + 1).at(-1);
    for (let i = 0; i < perChunk; i++, index++) { const size = stsz.readUInt32BE(4) || stsz.readUInt32BE(12 + index * 4); samples.push(source.subarray(offset, offset + size)); offset += size; }
  }
  assert.equal(count, 24); assert.equal(samples.length, count);
  const chapterOffsets = samples.map((_, i) => 4 * 1024 * 1024 + i * 96 * 1024), pieces = []; let position = 0, delta;
  for (const box of top.filter(box => box !== moov)) {
    if (box === mdat) {
      const size = 16 + box.body.length + 32 * 1024 * 1024;
      for (let i = 0; i < mdatCount; i++) {
        const start = Math.floor(size * i / mdatCount), end = Math.floor(size * (i + 1) / mdatCount), header = Buffer.alloc(16);
        header.writeUInt32BE(1); header.write('mdat', 4); header.writeBigUInt64BE(BigInt(end - start), 8); pieces.push([position + start, header]);
      }
      pieces.push([position + 16, box.body]); delta = position + 16 - (box.at + 8); position += size;
    } else { pieces.push([position, source.subarray(box.at, box.at + box.size)]); position += box.size; }
  }
  samples.forEach((body, i) => pieces.push([chapterOffsets[i], body]));
  function atom(type, body) { const value = Buffer.alloc(body.length + 8); value.writeUInt32BE(value.length); value.write(type, 4); body.copy(value, 8); return value; }
  function rebuild(buffer, chapterTrack = false) {
    return Buffer.concat(boxes(buffer).map(box => {
      const chapter = chapterTrack || box.type === 'trak' && isChapter(box.body);
      if (chapter && box.type === 'stco') {
        const body = Buffer.alloc(8 + count * 4); body.writeUInt32BE(count, 4); chapterOffsets.forEach((value, i) => body.writeUInt32BE(value, 8 + i * 4)); return atom(box.type, body);
      }
      if (chapter && box.type === 'stsc') {
        const body = Buffer.alloc(20); [1, 1, 1, 1].forEach((value, i) => body.writeUInt32BE(value, 4 + i * 4)); return atom(box.type, body);
      }
      if (box.type === 'stco') {
        const body = Buffer.from(box.body); for (let i = 0; i < body.readUInt32BE(4); i++) body.writeUInt32BE(body.readUInt32BE(8 + i * 4) + delta, 8 + i * 4); return atom(box.type, body);
      }
      return atom(box.type, containers.has(box.type) ? rebuild(box.body, chapter) : box.body);
    }));
  }
  const tail = atom('moov', rebuild(moov.body)); pieces.push([position, tail]);
  return { size: position + tail.length, chapterOffsets, read(first, last) {
    const result = Buffer.alloc(last - first + 1);
    for (const [start, body] of pieces) { const from = Math.max(first, start), to = Math.min(last + 1, start + body.length); if (to > from) body.copy(result, from - first, from - start, to - start); }
    return result;
  } };
}

test('Dolby color inspection uses two MiB ranges and its encoder uses separate eight MiB windows', async () => {
  const source = probeRangeMedia();
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000, startupTimeout: 5000 },
    inspect: async ({ input }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      assert.equal(response.status, 206);
      assert.equal((await response.arrayBuffer()).byteLength, 2 * 1024 * 1024);
    },
    run: async ({ input, args, write }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      assert.ok(Number(response.headers.get('content-length')) > 2 * 1024 * 1024);
      assert.ok(Number(response.headers.get('content-length')) <= 8 * 1024 * 1024);
      assert.equal(args[args.indexOf('-reconnect') + 1], '1');
      assert.ok(args.indexOf('-reconnect') < args.indexOf('-i'));
      assert.equal(args.includes('-reconnect_at_eof'), false);
      await response.arrayBuffer(); await write();
    },
  });
  try {
    const proof = await f.service.inspectColor({ episode: rawDolby, sourceColorSpace: 'dolby-vision', owner: 'probe', valid: () => true, timeout: 5500 });
    assert.equal(proof.rpuSeen, true);
    await start(f.service, { episode: rawDolby });
    assert.deepEqual(source.calls, ['bytes=0-2097151', 'bytes=0-2097151', 'bytes=0-8388607']);
  } finally { await f.close(); }
});

test('Dolby encoder windows can exceed both probe lifetime quotas without enlarging each HTTP read', async () => {
  const source = probeRangeMedia('valid', 32 * 1024 * 1024);
  let bytes = 0;
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { startupTimeout: 6000, probeTimeout: 3000 },
    run: async ({ input, write }) => {
      for (let index = 0; index < 18; index++) {
        const response = await fetch(input, { headers: { Range: 'bytes=0-0' } }); bytes += (await response.arrayBuffer()).byteLength;
      }
      for (let index = 0; index < 3; index++) {
        const response = await fetch(input, { headers: { Range: `bytes=${index * 8 * 1024 * 1024}-` } });
        const body = await response.arrayBuffer(); assert.equal(body.byteLength, 8 * 1024 * 1024); bytes += body.byteLength;
      }
      await write();
    },
  });
  try {
    await start(f.service, { episode: rawDolby });
    assert.ok(bytes > 16 * 1024 * 1024);
    assert.equal(source.calls.length, 21);
    assert.equal(source.calls.at(-1), 'bytes=16777216-25165823');
  } finally { await f.close(); }
});

test('an invalid Dolby encoder response stops an already-started process instead of reconnecting forever', { timeout: 5000 }, async () => {
  const source = probeRangeMedia();
  let trigger, stopped;
  const failSource = new Promise(done => { trigger = done; }), processStopped = new Promise(done => { stopped = done; });
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
    run: async ({ child, input, write }) => {
      child.once('close', stopped); await write(); await failSource;
      source.setMode('ignored');
      try { const response = await fetch(input, { headers: { Range: 'bytes=0-' } }); await response.arrayBuffer(); } catch { /* The real HTTP peer is deliberately closed by the guard. */ }
    },
  });
  try {
    await start(f.service, { episode: rawDolby }); trigger(); await processStopped;
    const state = await f.service.status();
    assert.equal(state.running, false);
    assert.match(state.error, /媒体范围响应无效/);
    assert.ok(f.children.at(-1).signals.includes('SIGTERM'));
    assert.equal(source.calls.length, 1);
  } finally { trigger(); await f.close(); }
});

test('chunked Dolby range responses keep probe and encoder windows bounded across large-file tail seeks', async () => {
  const size = 32 * 1024 * 1024 * 1024 + 17, source = probeRangeMedia('missing-length', size);
  const largeDolby = { ...rawDolby, url: 'https://movies.example/large-original.mp4', type: 'mp4' };
  const inspect = async ({ input }) => {
    const head = await fetch(input, { method: 'HEAD', headers: { Range: 'bytes=0-' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), String(2 * 1024 * 1024));
    assert.equal(head.headers.get('transfer-encoding'), null);
    assert.equal(head.headers.get('content-range'), `bytes 0-2097151/${size}`);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const [start, expected] of [[0, 2 * 1024 * 1024], [size - 1024, 1024]]) {
      const response = await fetch(input, { headers: { Range: `bytes=${start}-` } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-length'), String(expected));
      assert.equal(response.headers.get('transfer-encoding'), null);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${start + expected - 1}/${size}`);
      assert.equal((await response.arrayBuffer()).byteLength, expected);
    }
  };
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000, startupTimeout: 5000 }, inspect,
    run: async ({ input, write }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-length'), String(8 * 1024 * 1024));
      assert.equal(response.headers.get('transfer-encoding'), null);
      assert.equal((await response.arrayBuffer()).byteLength, 8 * 1024 * 1024);
      await write();
    },
  });
  try {
    const proof = await f.service.inspectColor({ episode: largeDolby, sourceColorSpace: 'dolby-vision', owner: 'probe', valid: () => true });
    assert.equal(proof.rpuSeen, true);
    await start(f.service, { episode: largeDolby });
    assert.deepEqual(source.calls, ['bytes=0-2097151', 'bytes=0-2097151', `bytes=${size - 1024}-${size - 1}`, 'bytes=0-2097151', 'bytes=0-2097151', `bytes=${size - 1024}-${size - 1}`, 'bytes=0-8388607']);
  } finally { await f.close(); }
});

test('Dolby HTTP color probes reject ignored ranges, inconsistent lengths and mismatched totals without encoding', async () => {
  for (const mode of ['ignored', 'mismatch', 'bad-length', 'overlong', 'short', 'changed-total', 'missing-length-overlong', 'missing-length-short', 'missing-length-no-range', 'missing-length-mismatch']) {
    const source = probeRangeMedia(mode);
    const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
      inspect: async ({ input }) => {
        for (let index = 0; index < (mode === 'changed-total' ? 2 : 1); index++) {
          const response = await fetch(input, { headers: { Range: 'bytes=0-0' } }); await response.arrayBuffer();
        }
      },
    });
    try {
      await assert.rejects(f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true }), error => error.status === 502 && error.code === 'QUARK_COLOR_PROBE_READ_FAILED' && error.colorProbe.colorSpace === 'unknown');
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
      assert.ok(source.streams.every(stream => stream.destroyed));
    } finally { await f.close(); }
  }
});

test('chunked Dolby range truncation cannot be hidden by decoded frame metadata', async () => {
  const source = probeRangeMedia('missing-length-abrupt');
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
    inspect: async ({ input }) => {
      // A decoder can already have frame metadata when an upstream body fails.
      await assert.rejects(async () => {
        const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
        await response.arrayBuffer();
      });
    },
  });
  try {
    await assert.rejects(f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true }),
      error => error.code === 'QUARK_COLOR_SOURCE_FAILED' && error.colorProbe.colorSpace === 'unknown');
    assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
    assert.ok(source.streams.every(stream => stream.destroyed));
  } finally { await f.close(); }
});

test('original Dolby probes keep sixteen MiB while MP4 allows sixty-four seeks and other formats sixteen', async () => {
  for (const type of ['mkv', 'mp4']) for (const range of ['bytes=0-', 'bytes=0-0']) {
    const accepted = range === 'bytes=0-' ? 8 : type === 'mp4' ? 64 : 16;
    const source = probeRangeMedia();
    const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 5500 },
      inspect: async ({ input }) => {
        for (let index = 0; index <= accepted; index++) {
          const response = await fetch(input, { headers: { Range: range } }); await response.arrayBuffer();
        }
      },
    });
    try {
      await assert.rejects(f.service.inspectColor({ episode: { ...rawDolby, type }, owner: 'probe', valid: () => true, timeout: 5500 }), error => error.status === 502 && error.code === 'QUARK_COLOR_PROBE_READ_FAILED');
      assert.equal(source.calls.length, accepted, 'the rejected request never reaches the underlying account media transport');
    } finally { await f.close(); }
  }
});

test('aborting a Dolby probe closes its live HTTP body immediately', async () => {
  const source = probeRangeMedia('stalled'), controller = new AbortController();
  let received;
  const firstByte = new Promise(done => { received = done; });
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
    inspect: async ({ input }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      await response.body.getReader().read(); received();
    },
  });
  try {
    const pending = f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => !controller.signal.aborted, signal: controller.signal });
    await firstByte; controller.abort();
    await assert.rejects(pending);
    assert.ok(source.streams.every(stream => stream.destroyed));
  } finally { await f.close(); }
});

test('a color-probe client can close its finite response early without creating a range error', async () => {
  const source = probeRangeMedia('stalled');
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
    inspect: async ({ input }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      const reader = response.body.getReader(); await reader.read(); await reader.cancel();
    },
  });
  try {
    const proof = await f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true });
    assert.equal(proof.rpuSeen, true);
    assert.ok(source.streams.every(stream => stream.destroyed));
  } finally { await f.close(); }
});

test('ordinary unknown color inspection still accepts a small non-range HTTP200 video', async () => {
  const source = probeRangeMedia('ignored');
  const color = { codec_name: 'h264', pix_fmt: 'yuv420p' };
  const f = await fixture({ media: source.media, colorProbe: { streams: [color], frames: [color] }, di: { probeTimeout: 3000 },
    inspect: async ({ input }) => { const response = await fetch(input); assert.equal(response.status, 200); await response.arrayBuffer(); },
  });
  try {
    const proof = await f.service.inspectColor({ episode: { ...rawDolby, colorSpace: 'unknown' }, owner: 'probe', valid: () => true });
    assert.equal(proof.colorSpace, 'browser-default');
    assert.deepEqual(source.calls, [undefined]);
  } finally { await f.close(); }
});

test('color inspection verifies an unmarked signed source without encoding or disturbing an active SDR encoder', async () => {
  const color = { codec_name: 'h264', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709' };
  const f = await fixture({ colorProbe: { streams: [color], frames: [color] } });
  try {
    const playing = await start(f.service, { episode: { ...episode, colorSpace: 'sdr' } });
    const encoder = f.children.at(-1), before = f.calls.length;
    const proof = await f.service.inspectColor({ episode, owner: 'color-check', valid: () => true });
    assert.deepEqual(proof, { codec: 'h264', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', colorSpace: 'sdr' });
    assert.equal(f.calls.length, before + 1); assert.ok(f.calls.at(-1).args.includes('-show_entries'));
    assert.match(f.calls.at(-1).args[f.calls.at(-1).args.indexOf('-i') + 1], /^http:\/\/127\.0\.0\.1:/);
    assert.equal(f.children.at(-1).finished, true); assert.deepEqual(encoder.signals, []);
    assert.equal((await f.service.status()).running, true); assert.equal(await f.service.cancel(playing.id, 'device-a'), true);
  } finally { await f.close(); }
});

test('color inspection reports real DV metadata for alternate selection but never starts a DV encoder', async () => {
  const color = { codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc', side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 5, dv_bl_signal_compatibility_id: 0, rpu_present_flag: 1, bl_present_flag: 1, el_present_flag: 0 }] };
  const f = await fixture({ colorProbe: { streams: [color], frames: [{ ...color, side_data_list: [{ side_data_type: 'Dolby Vision RPU Data' }] }] } });
  try {
    const proof = await f.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, owner: 'color-check', valid: () => true });
    assert.equal(proof.colorSpace, 'dolby-vision'); assert.equal(proof.dolbyVisionProfile, 5);
    assert.equal(proof.dolbyVisionCompatibilityId, 0); assert.equal(proof.rpuPresent, true); assert.equal(proof.blPresent, true); assert.equal(proof.elPresent, false); assert.equal(proof.rpuSeen, true);
    assert.equal(proof.pixFmt, 'yuv420p10le'); assert.equal(proof.bitDepth, 10);
    assert.equal(f.calls.length, 1); assert.ok(f.calls[0].args.includes('-show_entries'));
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('decoded unmarked 8-bit AVC uses a separate browser default without claiming SDR or encoding', async () => {
  for (const pix_fmt of ['yuv420p', 'yuvj420p', 'nv12']) {
    const color = { codec_name: 'h264', pix_fmt, bits_per_raw_sample: 'N/A' };
    const f = await fixture({ colorProbe: { streams: [color], frames: [{ pix_fmt }] } });
    try {
      const proof = await f.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, sourceColorSpace: 'unknown', owner: 'color-check', valid: () => true });
      assert.equal(proof.colorSpace, 'browser-default'); assert.equal(proof.pixFmt, pix_fmt); assert.equal(proof.bitDepth, 8); assert.equal(proof.transfer, '');
      assert.equal(f.calls.length, 1); assert.ok(f.calls[0].args.includes('-show_entries')); assert.equal(f.calls.some(call => call.args.includes('-c:v')), false);
    } finally { await f.close(); }
  }
});

test('Dolby AVC tags and configuration flags never qualify as browser defaults or prove an actual decoded RPU', async () => {
  const config = { side_data_type: 'DOVI configuration record', dv_profile: 8, dv_bl_signal_compatibility_id: 1, rpu_present_flag: 1, bl_present_flag: 1, el_present_flag: 0 };
  for (const metadata of [{ side_data_list: [config] }, { codec_tag_string: 'dvav' }, { codec_tag_string: 'dva1' }]) {
    const f = await fixture({ colorProbe: { streams: [{ codec_name: 'h264', pix_fmt: 'yuv420p', ...metadata }], frames: [{ pix_fmt: 'yuv420p' }] } });
    try {
      const proof = await f.service.inspectColor({ episode, owner: 'color-check', valid: () => true });
      assert.equal(proof.colorSpace, 'dolby-vision'); assert.equal(proof.rpuSeen, false);
      if (metadata.side_data_list) { assert.equal(proof.rpuPresent, true); assert.equal(proof.dolbyVisionCompatibilityId, 1); }
    } finally { await f.close(); }
  }
});

test('missing tags never erase source HDR risk, 10-bit or HEVC uncertainty, contradictory depth or HDR side data', async () => {
  const plain = { codec_name: 'h264', pix_fmt: 'yuv420p' };
  const cases = [
    ...['dolby-vision', 'hdr', 'pq', 'hlg'].map(sourceColorSpace => ({ sourceColorSpace, stream: plain, frame: plain })),
    { stream: { ...plain, pix_fmt: 'yuv420p10le' }, frame: { pix_fmt: 'yuv420p10le' } },
    { stream: { ...plain, pix_fmt: 'yuv420p10le' }, frame: { pix_fmt: 'yuv420p' } },
    { stream: plain, frame: { pix_fmt: 'yuv420p10le' } },
    { stream: { codec_name: 'h264', bits_per_raw_sample: '8' }, frame: {} },
    { stream: { ...plain, codec_name: 'hevc' }, frame: plain },
    { stream: { ...plain, bits_per_raw_sample: '10' }, frame: plain },
    { stream: plain, frame: { ...plain, color_primaries: 'bt2020' } },
    { stream: plain, frame: { ...plain, side_data_list: [{ side_data_type: 'Mastering display metadata' }] } },
    { stream: plain, frame: { ...plain, side_data_list: [{ side_data_type: 'Content light level metadata' }] } },
    { stream: plain, frame: { ...plain, side_data_list: [{ side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] } },
    { stream: plain, frame: null },
  ];
  for (const row of cases) {
    const f = await fixture({ colorProbe: { streams: [row.stream], frames: row.frame ? [row.frame] : [] } });
    try {
      await assert.rejects(f.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, sourceColorSpace: row.sourceColorSpace || 'unknown', owner: 'color-check', valid: () => true }), error => error.code === 'QUARK_COLOR_UNCONFIRMED');
      assert.equal(f.calls.some(call => call.args.includes('-c:v')), false);
    } finally { await f.close(); }
  }
  const f = await fixture({ colorProbe: { streams: [plain], frames: [plain] } });
  try { await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), /无法确认.*色彩/); }
  finally { await f.close(); }
});

test('a browser-default compatibility source preserves the ordinary pipeline without another probe or color remapping', async () => {
  const f = await fixture();
  try {
    await start(f.service, { episode: { ...episode, colorSpace: 'browser-default' } });
    assert.equal(f.calls.some(call => call.args.includes('-show_entries')), false);
    assert.doesNotMatch(f.calls.find(call => call.args.includes('-c:v')).args.join(' '), /tonemap|zscale|-color_trc|-color_primaries|-colorspace/);
  } finally { await f.close(); }
});

test('a transfer tag alone cannot certify SDR with conflicting frame metadata, wide-gamut tags or HDR side data', async () => {
  const sdr = { codec_name: 'h264', pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709' };
  for (const [stream, frame] of [
    [{ ...sdr, color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }, sdr],
    [{ ...sdr, color_space: 'smpte170m' }, sdr],
    [{ ...sdr, color_primaries: 'bt2020' }, { ...sdr, color_primaries: 'bt2020' }],
    [{ ...sdr, color_space: 'bt2020nc' }, { ...sdr, color_space: 'bt2020nc' }],
    [sdr, { ...sdr, side_data_list: [{ side_data_type: 'Mastering display metadata' }] }],
  ]) {
    const f = await fixture({ colorProbe: { streams: [stream], frames: [frame] } });
    try { await assert.rejects(f.service.inspectColor({ episode, owner: 'color-check', valid: () => true }), error => error.code === 'QUARK_COLOR_UNCONFIRMED'); }
    finally { await f.close(); }
  }
});

test('source DV or HDR requires a complete consistent SDR triplet while ordinary unmarked AVC still uses browser defaults', async () => {
  const sdr = { codec_name: 'h264', pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709' };
  for (const sourceColorSpace of ['dolby-vision', 'hdr', 'pq', 'hlg']) {
    for (const partial of [{ color_transfer: 'bt709' }, { color_transfer: 'bt709', color_primaries: 'bt709' }, { color_transfer: 'bt709', color_space: 'bt709' }]) {
      const f = await fixture({ colorProbe: { streams: [{ codec_name: 'h264', pix_fmt: 'yuv420p', ...partial }], frames: [partial] } });
      try { await assert.rejects(f.service.inspectColor({ episode, sourceColorSpace, owner: 'color-check', valid: () => true }), error => error.code === 'QUARK_COLOR_UNCONFIRMED'); }
      finally { await f.close(); }
    }
    const f = await fixture({ colorProbe: { streams: [sdr], frames: [sdr] } });
    try { assert.equal((await f.service.inspectColor({ episode, sourceColorSpace, owner: 'color-check', valid: () => true })).colorSpace, 'sdr'); }
    finally { await f.close(); }
  }
});

test('aborting a signed color inspection stops its process and leaves no encoding or input bridge alive', async () => {
  const f = await fixture({ hungColorProbe: true }); const controller = new AbortController();
  try {
    const pending = f.service.inspectColor({ episode, owner: 'color-check', valid: () => !controller.signal.aborted, signal: controller.signal });
    while (!f.calls.length) await new Promise(done => setTimeout(done, 1));
    controller.abort(); await assert.rejects(pending);
    assert.ok(f.children[0].signals.includes('SIGTERM')); assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(f.logs.some(line => line.includes('HDR 色彩检查失败')), false, 'explicit cancellation is not a probe failure');
  } finally { await f.close(); }
});

test('ordinary SDR playback keeps the existing path without a color probe or tone mapping', async () => {
  const f = await fixture();
  try {
    await start(f.service, { episode: { ...episode, colorSpace: 'sdr' } });
    assert.equal(f.calls.filter(call => call.args.includes('-show_entries')).length, 0);
    assert.doesNotMatch(f.calls.find(call => call.args.includes('-c:v')).args.join(' '), /fps=|tonemap|zscale|-color_trc/);
    assert.equal(f.calls.find(call => call.args.includes('-c:v')).args.includes('-reconnect'), false);
  } finally { await f.close(); }
});

test('confirmed PQ and HLG alternatives from a known Dolby source tone-map in linear light to BT709 SDR', async () => {
  for (const [hint, transfer, sideData] of [['pq', 'smpte2084'], ['hlg', 'arib-std-b67'], ['unknown', 'smpte2084'], ['hdr', 'smpte2084', [{ side_data_type: 'HDR Vivid Dynamic Metadata' }]]]) {
    const color = { color_transfer: transfer, color_primaries: 'bt2020', color_space: 'bt2020nc' };
    const f = await fixture({ colorProbe: { streams: [color], frames: [{ ...color, side_data_list: sideData || [] }] } });
    try {
      const result = await start(f.service, { episode: { ...episode, colorSpace: hint, sourceColorSpace: 'dolby-vision' } });
      assert.equal(result.acceleration, 'software');
      const probe = f.calls.find(call => call.args.includes('-show_entries')), encoder = f.calls.find(call => call.args.includes('-c:v'));
      assert.equal(probe.command, 'ffprobe'); assert.equal(probe.options.stdio[1], 'pipe');
      assert.ok(probe.args[probe.args.indexOf('-i') + 1].startsWith('http://127.0.0.1:'));
      assert.equal(probe.args[probe.args.indexOf('-read_intervals') + 1], '%+#1');
      assert.equal(probe.args[probe.args.indexOf('-probesize') + 1], '1048576');
      assert.equal(probe.args[probe.args.indexOf('-f') + 1], 'hls');
      assert.equal(probe.args[probe.args.indexOf('-allowed_extensions') + 1], 'ALL');
      const filter = encoder.args[encoder.args.indexOf('-vf') + 1];
      assert.match(filter, /min\(1280,iw\).*min\(720,ih\)/);
      assert.match(filter, /zscale=transfer=linear.*format=gbrpf32le.*tonemap=.*zscale=transfer=bt709/);
      assert.match(filter, /sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA/);
      assert.equal(encoder.args[encoder.args.indexOf('-color_trc') + 1], 'bt709');
      assert.equal(encoder.args[encoder.args.indexOf('-color_primaries') + 1], 'bt709');
      assert.equal(encoder.args[encoder.args.indexOf('-colorspace') + 1], 'bt709');
      assert.ok(!encoder.args.some(value => value.includes('movies.example') || value.includes('access=neutral')));
    } finally { await f.close(); }
  }
});

test('ordinary HDR Vivid, PQ, HLG and unknown MP4 or MKV compatibility never probes or calibrates color', async () => {
  for (const type of ['mp4', 'mkv']) for (const colorSpace of [undefined, 'unknown', 'hdr', 'pq', 'hlg']) {
    const f = await fixture({ hungColorProbe: true });
    try {
      await start(f.service, { episode: { url: `https://movies.example/2026.HDR.Vivid.${type}`, type, colorSpace, sourceColorSpace: colorSpace ?? 'unknown' } });
      assert.equal(f.calls.filter(call => call.args.includes('-show_entries')).length, 0);
      const args = f.calls.find(call => call.args.includes('-c:v')).args;
      assert.doesNotMatch(args.join(' '), /tonemap|zscale|libplacebo|-color_trc|-color_primaries|-colorspace|sidedata=/);
      assertRawInput(args);
      assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    } finally { await f.close(); }
  }
});

test('an explicitly converted SDR stream from a Dolby source keeps ordinary codec compatibility without calibration', async () => {
  const f = await fixture({ hungColorProbe: true });
  try {
    await start(f.service, { episode: { ...episode, colorSpace: 'sdr', sourceColorSpace: 'dolby-vision' } });
    assert.equal(f.calls.some(call => call.args.includes('-show_entries')), false);
    assert.doesNotMatch(f.calls.find(call => call.args.includes('-c:v')).args.join(' '), /tonemap|zscale|libplacebo|-color_trc|-color_primaries|-colorspace/);
  } finally { await f.close(); }
});

test('a Dolby hint without original RPU cannot fall through to ordinary PQ conversion', async () => {
  const direct = await fixture();
  try {
    await assert.rejects(start(direct.service, { episode: { ...episode, colorSpace: 'dolby-vision' } }), /杜比 RPU.*SDR/);
    assert.equal(direct.calls.filter(call => call.args.includes('-c:v')).length, 0);
  } finally { await direct.close(); }
  const color = { color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' };
  for (const location of ['stream', 'frame']) {
    const metadata = [{ side_data_type: location === 'stream' ? 'DOVI configuration record' : 'Dolby Vision RPU Data', dv_profile: 5, dv_bl_signal_compatibility_id: 0 }];
    const f = await fixture({ colorProbe: { streams: [{ ...color, ...(location === 'stream' ? { side_data_list: metadata } : {}) }], frames: [{ ...color, ...(location === 'frame' ? { side_data_list: metadata } : {}) }] } });
    try {
      await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), /杜比视界.*SDR/);
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('only decoded single-layer Profile 5 or 8.1 RPU is eligible for Dolby mapping', () => {
  const proof = { codec: 'hevc', dolbyVisionProfile: 5, dolbyVisionCompatibilityId: 0, rpuPresent: true, rpuSeen: true, blPresent: true, elPresent: false };
  assert.equal(supportsDolbyMapping(proof), true);
  assert.equal(supportsDolbyMapping({ ...proof, dolbyVisionProfile: 8, dolbyVisionCompatibilityId: 1 }), true);
  for (const change of [{ codec: 'h264' }, { dolbyVisionProfile: 7 }, { dolbyVisionCompatibilityId: 1 }, { rpuPresent: false }, { rpuSeen: false }, { blPresent: false }, { elPresent: true }, { elPresent: undefined }]) assert.equal(supportsDolbyMapping({ ...proof, ...change }), false);
  assert.equal(supportsDolbyMapping(undefined), false);
});

test('supported original Dolby RPU uses libplacebo and BT709 output in both existing encoding modes', async () => {
  for (const [profile, compatibility] of [[5, 0], [8, 1]]) for (const gpu of [false, true]) {
    const f = await fixture({ gpu, colorProbe: dolbyProbe(profile, compatibility), env: { TRANSCODE_ACCEL: gpu ? 'vaapi' : 'software', TRANSCODE_ALLOW_SOFTWARE: gpu ? 'false' : 'true' } });
    try {
      const result = await start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } });
      assert.equal(result.acceleration, gpu ? 'vaapi' : 'software');
      const args = f.calls.find(call => call.args.includes('-c:v')).args, filter = args[args.indexOf('-vf') + 1];
      assert.equal(args.includes('-reconnect'), false, 'HLS keeps its existing protocol behavior');
      assert.match(filter, /libplacebo=.*apply_dolbyvision=1.*colorspace=bt709.*color_primaries=bt709.*color_trc=bt709/);
      assert.match(filter, /force_original_aspect_ratio=decrease:force_divisible_by=2/);
      assert.doesNotMatch(filter, /zscale|tonemap=tonemap/);
      assert.equal(args[args.indexOf('-color_primaries') + 1], 'bt709');
      assert.equal(args[args.indexOf('-threads') + 1], gpu ? '1' : '4', 'only software Dolby decode uses four threads');
      assert.equal(args[args.lastIndexOf('-threads') + 1], '1', 'encoding remains bounded to one thread');
      assert.equal(args[args.indexOf('-filter_threads') + 1], '1');
      assert.equal(args[args.indexOf('-r') + 1], '30', 'the existing output frame rate remains unchanged');
      assert.equal(args[args.indexOf('-readrate') + 1], '1');
      if (gpu) {
        assert.match(args[args.indexOf('-init_hw_device') + 1], /^vaapi=va:/);
        assert.equal(args[args.indexOf('-hwaccel') + 1], 'vaapi');
        assert.ok(filter.startsWith("fps='if(gt(source_fps,0),min(source_fps,30),30)',hwmap=derive_device=vulkan,format=vulkan"));
        assert.match(filter, /hwdownload,format=yuv420p,format=nv12,hwupload$/);
        assert.ok(args.includes('h264_vaapi')); assert.ok(!args.includes('libx264'));
      } else {
        assert.equal(args[args.indexOf('-init_hw_device') + 1], 'vulkan=vk:0');
        assert.ok(filter.startsWith("fps='if(gt(source_fps,0),min(source_fps,30),30)',hwupload,libplacebo="));
        assert.ok(args.includes('libx264'));
      }
    } finally { await f.close(); }
  }
});

test('Dolby startup waits for two distinct listed segments that both exist and are nonempty', async () => {
  for (const gpu of [false, true]) {
    let outputPath, outputReady;
    const created = new Promise(done => { outputReady = done; });
    const f = await fixture({ gpu, colorProbe: dolbyProbe(), env: { TRANSCODE_ACCEL: gpu ? 'vaapi' : 'software' }, run: async ({ args }) => {
      outputPath = args.at(-1);
      await writeFile(join(outputPath, '..', 'segment000000.ts'), Buffer.alloc(188));
      await writeFile(outputPath, manifest);
      outputReady();
    } });
    try {
      let settled = false;
      const playback = start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } });
      playback.then(() => { settled = true; }, () => { settled = true; });
      await created;
      const first = join(outputPath, '..', 'segment000000.ts'), second = join(outputPath, '..', 'segment000001.ts');
      const pending = async message => { await new Promise(done => setTimeout(done, 20)); assert.equal(settled, false, message); };
      const publish = async body => { await writeFile(outputPath + '.tmp', body); await rename(outputPath + '.tmp', outputPath); };
      await pending('one open segment does not provide the Dolby startup buffer');
      await writeFile(second, Buffer.alloc(188));
      await pending('an unlisted file does not count toward the buffer');
      await publish(manifest + '#EXTINF:2,\nsegment000000.ts\n');
      await pending('a duplicate segment does not provide a second segment');
      await writeFile(first, Buffer.alloc(0));
      await publish(manifest + '#EXTINF:2,\nsegment000001.ts\n');
      await pending('the first listed segment must also be nonempty');
      await writeFile(second, Buffer.alloc(0)); await writeFile(first, Buffer.alloc(188));
      await pending('an empty second segment is not ready');
      await rm(second);
      await pending('a missing second segment is not ready');
      await writeFile(second, Buffer.alloc(188));
      assert.equal((await playback).acceleration, gpu ? 'vaapi' : 'software');
    } finally { await f.close(); }
  }
});

test('a short completed Dolby output may start with one segment only when its exact ENDLIST is present', async () => {
  for (const { body, empty, second, ended } of [
    { body: manifest },
    { body: manifest + '#EXT-X-ENDLIST-DRAFT\n' },
    { body: '#EXTM3U\n#EXT-X-ENDLIST\n' },
    { body: manifest + '#EXT-X-ENDLIST\n', empty: true },
    { body: manifest + '#EXTINF:2,\nsegment000001.ts\n#EXT-X-ENDLIST\n', second: true },
    { body: manifest + '#EXT-X-ENDLIST\n', ended: true },
  ]) {
    const f = await fixture({ colorProbe: dolbyProbe(), run: async ({ child, args }) => {
      await writeFile(join(args.at(-1), '..', 'segment000000.ts'), Buffer.alloc(empty ? 0 : 188));
      if (second) await writeFile(join(args.at(-1), '..', 'segment000001.ts'), Buffer.alloc(0));
      await writeFile(args.at(-1), body); child.exit(0);
    } });
    try {
      const playback = start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } });
      if (ended) assert.equal((await playback).acceleration, 'software');
      else await assert.rejects(playback, statusError(503));
    } finally { await f.close(); }
  }
});

test('Dolby Vulkan failure in strict hardware mode reports capability failure without CPU fallback', async () => {
  const f = await fixture({ gpu: true, colorProbe: dolbyProbe(), env: { TRANSCODE_ACCEL: 'vaapi', TRANSCODE_ALLOW_SOFTWARE: 'false' }, run: async ({ child }) => { child.stderr.write('Vulkan unsupported https://private.example/video?token=hidden'); child.exit(1); } });
  try {
    await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } }), error => error.status === 503 && /libplacebo.*Vulkan/.test(error.message));
    assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 1);
    assert.equal(f.calls.some(call => call.args.includes('libx264')), false);
    assert.equal(f.logs.join('\n').includes('private.example'), false);
    assert.deepEqual(await readdir(f.root), ['gpu']);
  } finally { await f.close(); }
});

test('bounded Dolby and HDR probes can finish after three seconds while ordinary probes keep their shorter deadline', async () => {
  const dolby = await fixture({ colorProbe: dolbyProbe(), colorProbeDelay: 3150, di: { probeTimeout: 6000 } });
  try {
    const proof = await dolby.service.inspectColor({ episode: { ...episode, colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'probe', valid: () => true, timeout: 5500 });
    assert.equal(supportsDolbyMapping(proof), true);
    assert.equal(dolby.calls.some(call => call.args.includes('-c:v')), false);
  } finally { await dolby.close(); }
  for (const sourceColorSpace of ['hdr', 'pq', 'hlg']) {
    const color = { codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: sourceColorSpace === 'hlg' ? 'arib-std-b67' : 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' };
    const hdr = await fixture({ colorProbe: { streams: [color], frames: [color] }, colorProbeDelay: 3150, di: { probeTimeout: 6000 } });
    try {
      const proof = await hdr.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, sourceColorSpace, owner: 'probe', valid: () => true, timeout: 6000 });
      assert.equal(proof.colorSpace, sourceColorSpace === 'hlg' ? 'hlg' : 'pq');
      assert.ok(hdr.children.every(child => child.finished));
    } finally { await hdr.close(); }
  }
  const ordinary = await fixture({ colorProbeDelay: 3150, di: { probeTimeout: 6000 } });
  try {
    await assert.rejects(ordinary.service.inspectColor({ episode, owner: 'probe', valid: () => true, timeout: 5500 }), error => error.status === 504 && error.code === 'QUARK_COLOR_PROBE_TIMEOUT');
    assert.ok(ordinary.children.every(child => child.finished));
    assert.deepEqual(await readdir(ordinary.root), []);
  } finally { await ordinary.close(); }
});

test('unknown, malformed, oversized and timed-out color probes stop safely before encoding', async () => {
  for (const option of [{ colorProbe: { streams: [{}], frames: [{}] } }, { colorProbe: { streams: [{ color_transfer: 'smpte2084' }], frames: [] } }, { colorProbeBody: '{malformed' }, { colorProbeBody: 'x'.repeat(65537) }, { hungColorProbe: true }]) {
    const f = await fixture(option);
    try {
      await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), error => error.status === (option.hungColorProbe ? 504 : 409) && (option.hungColorProbe ? error.code === 'QUARK_COLOR_PROBE_TIMEOUT' : /无法确认.*色彩/.test(error.message)) && !error.message.includes('movies.example'));
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
      assert.ok(f.children.every(child => child.finished));
    } finally { await f.close(); }
  }
});

test('HDR alternatives from Dolby sources honor GPU-only and disabled-software settings', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ gpu: true, env });
    try {
      await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'pq', sourceColorSpace: 'dolby-vision' } }), error => error.status === 503 && /软件色调映射/.test(error.message));
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
    } finally { await f.close(); }
  }
});

test('ordinary HDR compatibility keeps hardware encoding instead of forcing software color mapping', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ gpu: true, env, hungColorProbe: true });
    try {
      const result = await start(f.service, { episode: { ...episode, colorSpace: 'pq', sourceColorSpace: 'hdr' } });
      assert.equal(result.acceleration, 'vaapi'); assert.equal(f.calls.some(call => call.args.includes('-show_entries')), false);
      const args = f.calls.find(call => call.args.includes('-c:v')).args;
      assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi');
      assert.doesNotMatch(args.join(' '), /tonemap|zscale|libplacebo|-color_trc|-color_primaries|-colorspace/);
    } finally { await f.close(); }
  }
});

test('a build without HDR filters reports the missing capability instead of claiming converted playback', async () => {
  const f = await fixture({ run: async ({ child }) => { child.stderr.write("No such filter: 'zscale'\n"); child.exit(1); } });
  try {
    await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'pq', sourceColorSpace: 'dolby-vision' } }), error => error.status === 503 && /缺少 HDR 色调映射支持/.test(error.message));
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('closing during a color probe kills its owned process and leaves no bridge or output directory', async () => {
  const f = await fixture({ hungColorProbe: true, di: { probeTimeout: 1000 } });
  try {
    const pending = assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), statusError(409));
    for (let index = 0; index < 30 && !f.calls.some(call => call.args.includes('-show_entries')); index++) await new Promise(done => setTimeout(done, 2));
    assert.ok(f.calls.some(call => call.args.includes('-show_entries')));
    await f.service.close(); await pending;
    assert.ok(f.children.every(child => child.finished));
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('cloud media override stays inside signed bridge and MKV uses bounded container detection', async () => {
  const f = await fixture({ run: async ({ input, write }) => {
    const response = await fetch(input); assert.equal(response.status, 200); assert.equal(await response.text(), 'cloud-video'); await write();
  } });
  let upstreamCalls = 0;
  const cloudMedia = createMedia({ proxyPath: '/api/quark/media/test-lease', request: async () => {
    upstreamCalls++; return Object.assign(Readable.from([Buffer.from('cloud-video')]), { statusCode: 200, headers: { 'content-type': 'video/x-matroska' } });
  } });
  try {
    await start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, mediaOverride: cloudMedia, proxyPath: '/api/quark/media/test-lease' });
    const args = f.calls.find(call => call.args.includes('-i'))?.args;
    assertRawInput(args);
    assert.ok(upstreamCalls > 0);
    assert.ok(args[args.indexOf('-i') + 1].startsWith('http://127.0.0.1:'));
    assert.ok(!args.some(arg => arg.includes('cloud.quark.cn')));
  } finally { await f.close(); }
});

test('cloud AVI and transport-stream files use bounded container detection through the signed bridge', async () => {
  for (const type of ['avi', 'mpegts']) {
    const f = await fixture({ run: async ({ input, write }) => { assert.equal((await fetch(input)).status, 200); await write(); } });
    const cloudMedia = createMedia({ proxyPath: '/api/quark/media/test-lease', request: async () => Object.assign(Readable.from([Buffer.from('video')]), { statusCode: 200, headers: { 'content-type': 'application/octet-stream' } }) });
    try {
      await start(f.service, { episode: { type, url: 'https://cloud.quark.cn/file.bin' }, mediaOverride: cloudMedia, proxyPath: '/api/quark/media/test-lease' });
      const args = f.calls.find(call => call.args.includes('-i')).args;
      assertRawInput(args);
      assert.ok(args[args.indexOf('-i') + 1].startsWith('http://127.0.0.1:'));
    } finally { await f.close(); }
  }
});

test('raw-file resume rejects ignored, mismatched and malformed Range responses before encoding', async () => {
  for (const reply of [
    { statusCode: 200, headers: { 'content-length': '1', 'accept-ranges': 'bytes' } },
    { statusCode: 206, headers: { 'content-length': '1', 'content-range': 'bytes 0-0/1000' } },
    { statusCode: 206, headers: { 'content-length': '2', 'content-range': 'bytes 1-1/1000' } },
    { statusCode: 206, headers: { 'content-length': '1', 'content-range': 'bytes 1-1/1' } },
  ]) {
    const requests = [], media = createMedia({ request: async (_url, options) => {
      requests.push(options);
      return Object.assign(Readable.from([Buffer.from('v')]), { ...reply, headers: { 'content-type': 'video/x-matroska', ...reply.headers } });
    } });
    const f = await fixture({ media });
    try {
      await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
        error => error.status === 409 && error.code === 'TRANSCODE_INPUT_NOT_SEEKABLE' && /从头播放|官方在线线路/.test(error.message));
      assert.equal(requests.length, 1); assert.equal(requests[0].headers.range, 'bytes=1-1');
      assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('raw-file resume accepts a genuine nonzero byte range and shares the startup deadline', async () => {
  const requests = [], media = createMedia({ request: async (_url, options) => {
    requests.push(options);
    return Object.assign(Readable.from([Buffer.from('v')]), { statusCode: 206,
      headers: { 'content-type': 'video/x-matroska', 'content-length': '1', 'content-range': 'bytes 1-1/1000' } });
  } });
  const f = await fixture({ media });
  try {
    const result = await start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 });
    assert.equal(result.startPosition, 281); assert.equal(requests.length, 1); assert.equal(requests[0].headers.range, 'bytes=1-1');
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 1);
  } finally { await f.close(); }
});

test('from-start raw files and HLS resume do not require byte-range support', async () => {
  for (const input of [{ type: 'mkv', position: 0 }, { type: 'hls', position: 281 }]) {
    const f = await fixture();
    try {
      assert.equal((await start(f.service, { episode: { type: input.type, url }, position: input.position })).startPosition, input.position);
      assert.equal(f.requests.length, 0);
      const args = f.calls.find(call => call.args.includes('-i')).args;
      assert.equal(args.includes('-ss'), input.position > 0);
      assert.equal(args.includes('-reconnect'), false);
    }
    finally { await f.close(); }
  }
});

test('a source that stops honoring Range after the probe keeps the actionable resume error', async () => {
  let requests = 0;
  const media = createMedia({ request: async (_url, options) => {
    requests++;
    return Object.assign(Readable.from([Buffer.from('v')]), { statusCode: requests === 1 ? 206 : 200,
      headers: { 'content-type': 'video/x-matroska', 'content-length': '1', ...(requests === 1 ? { 'content-range': 'bytes 1-1/1000' } : {}) } });
  } });
  const f = await fixture({ media, run: async ({ input }) => { try { await fetch(input, { headers: { Range: 'bytes=500-' } }); } catch {} } });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
      error => error.code === 'TRANSCODE_INPUT_NOT_SEEKABLE');
    assert.equal(requests, 2); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('closing during a pending resume probe cancels it without leaking resources or replacing 409', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const media = createMedia({ request: async (_url, options) => {
    entered();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const f = await fixture({ media });
  try {
    const pending = start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }).catch(error => error);
    await started;
    await Promise.all([f.service.close(), f.service.close()]);
    assert.equal((await pending).status, 409);
    assert.deepEqual(await readdir(f.root), []); assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0);
  } finally { await f.close(); }
});

test('a hung resume probe uses the existing startup deadline and never launches an encoder', async () => {
  const media = createMedia({ request: async (_url, options) => {
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const f = await fixture({ media, di: { startupTimeout: 40 } });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }), statusError(504));
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('a startup-limited resume probe remains a timeout when its timer fires just before the wall-clock deadline', async () => {
  let clock = 1000;
  const media = createMedia({ request: async (_url, options) => {
    clock = 1039;
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const f = await fixture({ media, di: { startupTimeout: 40, now: () => clock } });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
      error => error.status === 504 && /启动超时/.test(error.message));
    assert.equal(clock, 1039); assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('a resume probe upstream failure before the startup deadline remains a check error', async () => {
  const media = createMedia({ request: async () => { throw new Error('fixture upstream unavailable'); } });
  const f = await fixture({ media });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
      error => error.status === 502 && /无法检查原文件/.test(error.message));
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

async function assetServer(service, id) {
  const server = createServer(async (req, res) => {
    try { await service.serve(req, res, id, decodeURIComponent(req.url.slice(1))); }
    catch (error) { if (!res.headersSent) { res.statusCode = error.status || 500; res.end(error.message); } else res.destroy(error); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

test('factory and unused close have no FFmpeg or HTTP side effects and allow media fixture without serve', async () => {
  let calls = 0;
  const service = createTranscoder({ media: { playback() {} }, spawn() { calls++; } });
  await service.close(); assert.equal(calls, 0);
});

test('lazy availability is shared, disabled mode never starts a process, and missing binary reports a friendly error', async () => {
  const f = await fixture();
  try { assert.equal(f.calls.length, 0); const [a, b] = await Promise.all([f.service.status(), f.service.status()]); assert.equal(a.available, true); assert.deepEqual(a, b); assert.equal(f.calls.length, 1); }
  finally { await f.close(); }
  const disabled = await fixture({ env: { TRANSCODE_ENABLED: 'false' } });
  try { assert.equal((await disabled.service.status()).enabled, false); await assert.rejects(start(disabled.service), statusError(503)); assert.equal(disabled.calls.length, 0); }
  finally { await disabled.close(); }
  const missing = await fixture({ missing: true });
  try { const result = await missing.service.status(); assert.equal(result.available, false); assert.match(result.error, /FFmpeg/); await assert.rejects(start(missing.service), statusError(503)); assert.equal(missing.calls.length, 1); }
  finally { await missing.close(); }
});

test('software output uses a private bridge, bounded HLS window, one thread and unmodified playback timestamps', async () => {
  const f = await fixture({ env: { FFMPEG_PATH: 'custom-ffmpeg' }, run: async ({ child, args, write }) => { child.stderr.write('Duration: 00:01:'); child.stderr.write('30.50, start: 0\n'); await write(); } });
  try {
    const result = await start(f.service, { position: 12.5, speed: 1.5 });
    assert.equal(result.duration, 90.5); assert.equal(result.startPosition, 12.5); assert.equal(result.acceleration, 'software'); assert.equal(result.transcoded, true); assert.match(result.url, /^\/api\/transcode\/[a-f0-9]{32}\/index\.m3u8$/);
    const { command, args } = f.calls[1]; assert.equal(command, 'custom-ffmpeg'); assert.equal(args[args.indexOf('-readrate') + 1], '1.5'); assert.equal(args[args.indexOf('-ss') + 1], '12.5'); assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp,crypto'); assert.match(args[args.indexOf('-i') + 1], /^http:\/\/127\.0\.0\.1:\d+\/api\/media\/asset\.m3u8\?token=/); assert.equal(args.includes(url), false);
    assert.equal(args[args.indexOf('-f') + 1], 'hls'); assert.equal(args[args.indexOf('-allowed_extensions') + 1], 'ALL'); assert.equal(args.includes('-format_whitelist'), false);
    assert.equal(args[args.indexOf('-hls_time') + 1], '2'); assert.equal(args[args.indexOf('-hls_list_size') + 1], '30'); assert.equal(args[args.indexOf('-hls_flags') + 1], 'delete_segments+temp_file'); assert.ok(args.includes('libx264')); assert.ok(args.includes('aac')); assert.equal(args.includes('-atempo'), false); assert.equal(args.some(value => value.includes('setpts')), false); assert.equal((await f.service.status()).running, true);
    assert.equal(args[args.indexOf('-r') + 1], '30'); assert.equal(args[args.indexOf('-maxrate') + 1], '3500k'); assert.equal(args[args.indexOf('-bufsize') + 1], '7000k');
    assert.equal(result.quality, 720);
    assert.ok(args.every((value, index) => !['-threads', '-filter_threads'].includes(value) || args[index + 1] === '1'));
  } finally { await f.close(); }
});

test('quality limits dimensions and bitrate across software, VAAPI and Dolby mapping without increasing thread limits', async () => {
  for (const [quality, width, bitrate, maxrate] of [[720, 1280, 2500, 3500], [1080, 1920, 5000, 7000], [2160, 3840, 14000, 18000]]) {
    for (const [hardware, dolby] of [[false, false], [true, false], [false, true], [true, true]]) {
      const f = await fixture({ gpu: hardware, env: { TRANSCODE_ACCEL: hardware ? 'vaapi' : 'software' }, colorProbe: dolbyProbe() });
      try {
        const result = await start(f.service, { quality, episode: dolby ? rawDolby : episode });
        assert.equal(result.quality, quality); assert.equal(result.acceleration, hardware ? 'vaapi' : 'software');
        const args = f.calls.find(call => call.args.includes('-c:v')).args, filter = args[args.indexOf('-vf') + 1];
        assert.ok(filter.includes(`w='min(${width},iw)':h='min(${quality},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`));
        assert.ok(filter.includes(dolby ? 'libplacebo=' : hardware ? 'scale_vaapi=' : 'scale='));
        if (dolby) assert.match(filter, /apply_dolbyvision=1:colorspace=bt709:color_primaries=bt709:color_trc=bt709/);
        if (hardware) assert.equal(args[args.indexOf('-b:v') + 1], `${bitrate}k`);
        assert.equal(args[args.indexOf('-maxrate') + 1], `${maxrate}k`); assert.equal(args[args.indexOf('-bufsize') + 1], `${maxrate * 2}k`);
        assert.equal(args[args.indexOf('-r') + 1], '30');
        assert.deepEqual(args.flatMap((value, index) => value === '-threads' ? [args[index + 1]] : []), [dolby && !hardware ? '4' : '1', '1']);
        assert.equal(args[args.indexOf('-filter_threads') + 1], '1'); assert.equal(args[args.indexOf('-hls_list_size') + 1], quality === 2160 ? '15' : '30', '4K码率较高，缩短缓存窗口以适配128MiB临时目录');
      } finally { await f.close(); }
    }
  }
});

test('higher quality retains linear-light HDR mapping and cannot enable forbidden software encoding', async () => {
  for (const quality of [1080, 2160]) {
    const f = await fixture();
    try {
      await start(f.service, { quality, episode: { ...episode, colorSpace: 'pq', sourceColorSpace: 'dolby-vision' } });
      const args = f.calls.find(call => call.args.includes('-c:v')).args, filter = args[args.indexOf('-vf') + 1];
      assert.ok(filter.includes(`h='min(${quality},ih)'`));
      assert.match(filter, /zscale=transfer=linear.*tonemap=tonemap=hable.*zscale=transfer=bt709/);
      assert.equal(args[args.indexOf('-color_trc') + 1], 'bt709');
    } finally { await f.close(); }
    const protectedService = await fixture({ env: { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' } });
    try {
      await assert.rejects(start(protectedService.service, { quality }), statusError(503));
      assert.equal(protectedService.calls.some(call => call.args.includes('-c:v')), false);
    } finally { await protectedService.close(); }
  }
});

test('unsupported or coerced quality values fail before starting processes or replacing the active job', async () => {
  const f = await fixture();
  try {
    for (const quality of [null, '720', '1080', '2160', 0, 480, 1440, 4320, 720.5, Infinity, NaN, {}, []]) await assert.rejects(start(f.service, { quality }), statusError(400));
    assert.equal(f.calls.length, 0);
    const original = await start(f.service, { quality: 1080 });
    await assert.rejects(start(f.service, { quality: '2160' }), statusError(400));
    assert.equal((await f.service.status()).running, true); assert.equal(f.children[1].signals.length, 0);
    assert.equal(await f.service.cancel(original.id, 'device-a'), true);
  } finally { await f.close(); }
});

test('real quality scaling keeps 720p sources unchanged and bounds 4K sources at each selected height', { timeout: 30000 }, async t => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const run = args => promisify(execFile)(ffmpeg, args, { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  try { await run(['-version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Local FFmpeg is required for actual scaling dimensions'); throw error; }
  const f = await fixture();
  try {
    for (const quality of [720, 1080, 2160]) {
      await start(f.service, { quality });
      const args = f.calls.at(-1).args, filter = args[args.indexOf('-vf') + 1];
      for (const sourceHeight of [720, 2160]) {
        const { stderr } = await run(['-hide_banner', '-nostdin', '-threads', '1', '-filter_threads', '1', '-f', 'lavfi', '-i', `testsrc2=size=${sourceHeight * 16 / 9}x${sourceHeight}:rate=1`,
          '-vf', `${filter},showinfo`, '-frames:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-f', 'null', '-']);
        const dimensions = /\[Parsed_showinfo_[^\r\n]+\bs:(\d+)x(\d+)\b/.exec(stderr);
        assert.ok(dimensions, 'FFmpeg must report a decoded output frame');
        const height = Math.min(sourceHeight, quality);
        assert.deepEqual(dimensions.slice(1).map(Number), [height * 16 / 9, height], `source=${sourceHeight} quality=${quality}`);
      }
    }
  } finally { await f.close(); }
});

test('duration survives a large stderr chunk and a duration split across chunks before retained-tail truncation', async () => {
  for (const chunks of [
    ['Duration: 02:10:00.50, start: 0\n' + 'codec diagnostics\n'.repeat(400)],
    ['codec diagnostics\n'.repeat(200) + 'Dura', 'tion: 02:10:00.50, start: 0\n' + 'codec diagnostics\n'.repeat(400)],
  ]) {
    const f = await fixture({ run: async ({ child, write }) => { for (const chunk of chunks) child.stderr.write(chunk); await write(); } });
    try { assert.equal((await start(f.service)).duration, 7800.5); }
    finally { await f.close(); }
  }
});

test('duration does not invent a value for unavailable, invalid or excessive input metadata', async () => {
  for (const value of ['N/A', '00:60:01', '00:01:60.50', '168:00:01', '9'.repeat(400) + ':00:00']) {
    const f = await fixture({ run: async ({ child, write }) => { child.stderr.write(`Duration: ${value}, start: 0\n` + 'codec diagnostics\n'.repeat(400)); await write(); } });
    try { assert.equal((await start(f.service)).duration, null); }
    finally { await f.close(); }
  }
});

test('bridge rewrites master, AES key, map and segment links to its own origin and forwards only signed media requests', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nsub/child.m3u8\n';
  const child = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nchunk.m4s?auth=a%24b\n';
  const files = new Map([[url, [master, 'application/vnd.apple.mpegurl']], ['https://movies.example/sub/child.m3u8', [child, 'application/vnd.apple.mpegurl']], ['https://cdn.example/key', [Buffer.alloc(16), 'application/octet-stream']], ['https://movies.example/sub/init.mp4', [Buffer.alloc(10), 'video/mp4']], ['https://movies.example/sub/chunk.m4s?auth=a%24b', [Buffer.alloc(10), 'video/mp4']]]);
  let bridgeOrigin;
  const f = await fixture({ files, run: async ({ input, write }) => {
    bridgeOrigin = new URL(input).origin;
    const masterText = await (await fetch(input)).text(); const childUrl = masterText.split('\n').find(line => line && !line.startsWith('#'));
    assert.equal(new URL(childUrl).origin, bridgeOrigin); assert.match(new URL(childUrl).pathname, /\.m3u8$/);
    const text = await (await fetch(childUrl)).text(); const assets = [...text.matchAll(/URI="([^"]+)"/g)].map(value => value[1]).concat(text.split('\n').filter(line => line && !line.startsWith('#')));
    for (const target of assets) { assert.equal(new URL(target).origin, bridgeOrigin); assert.equal((await fetch(target)).status, 200); }
    assert.match(text, /asset\.mp4\?token=/); assert.match(text, /asset\.m4s\?token=/); await write();
  } });
  try {
    await start(f.service); assert.equal(f.requests.length, 5);
    for (const suffix of ['/api/media?url=https://other.example/movie.mp4', '/arbitrary', '/api/media/asset.ts?token=invalid&url=https://other.example']) assert.equal((await fetch(bridgeOrigin + suffix)).status, 403);
    assert.equal(f.requests.length, 5);
  } finally { await f.close(); }
  await assert.rejects(fetch(bridgeOrigin + '/arbitrary'));
});

test('unsafe or unquoted manifest links and upstream Location headers cannot escape the bridge', async () => {
  for (const body of ['#EXTM3U\nhttps://attacker.example/segment.ts\n', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=http://127.0.0.1/private\n']) {
    let status;
    const real = createMedia({ secret: Buffer.alloc(32), request() {} });
    const media = { playback: (...args) => real.playback(...args), async serve(_req, res) { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(body); } };
    const f = await fixture({ media, run: async ({ input, write }) => { status = (await fetch(input)).status; await write(); } });
    try { await start(f.service); assert.equal(status, 502); } finally { await f.close(); }
  }
  const real = createMedia({ secret: Buffer.alloc(32), request() {} }); let status;
  const f = await fixture({ media: { playback: (...args) => real.playback(...args), async serve(_req, res) { res.setHeader('Location', 'https://attacker.example/'); res.end(); } }, run: async ({ input, write }) => { const response = await fetch(input, { redirect: 'manual' }); status = response.status; assert.equal(response.headers.get('location'), null); await write(); } });
  try { await start(f.service); assert.equal(status, 502); } finally { await f.close(); }
});

test('private inputs, unsupported formats, invalid speed/position/owner and stale validity never spawn FFmpeg', async () => {
  const f = await fixture();
  try {
    for (const overrides of [{ episode: { url: 'http://127.0.0.1/a.mp4', type: 'mp4' } }, { episode: { url: 'file:///tmp/a.mp4', type: 'mp4' } }, { episode: { url, type: 'page' } }, { episode: { ...episode, sourceColorSpace: 'invalid' } }, { episode: { ...episode, sourceColorSpace: 'browser-default' } }, { episode: { ...episode, sourceColorSpace: {} } }, { speed: 4 }, { position: -1 }, { position: Infinity }, { owner: '' }, { valid: null }]) await assert.rejects(start(f.service, overrides));
    await assert.rejects(start(f.service, { valid: () => false }), statusError(409)); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('single-task ownership rejects other devices and a same-device seek stops and removes the previous task', async () => {
  const f = await fixture();
  try {
    const first = await start(f.service); const firstDir = join(f.calls[1].args.at(-1), '..');
    await assert.rejects(start(f.service, { owner: 'device-b' }), statusError(409)); await assert.rejects(f.service.cancel(first.id, 'device-b'), statusError(403));
    const second = await start(f.service, { position: 45, quality: 1080 }); assert.notEqual(first.id, second.id); assert.equal(second.startPosition, 45); assert.equal(second.quality, 1080); assert.ok(f.children[1].signals.includes('SIGTERM')); await assert.rejects(readFile(join(firstDir, 'index.m3u8')));
    assert.equal(await f.service.cancel(first.id, 'device-a'), false); assert.equal(await f.service.cancel(second.id, 'device-a'), true); assert.equal((await f.service.status()).running, false); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('hardware failure before its first segment falls back once to software within the startup deadline', async () => {
  const hardware = await fixture({ gpu: true, env: { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'true' }, run: async ({ child, args, write }) => { if (args.includes('h264_vaapi')) { child.stderr.write('hardware rejected https://secret.example/video?token=hidden'); child.exit(1); } else await write(); } });
  try { const result = await start(hardware.service); assert.equal(result.acceleration, 'software'); assert.equal(hardware.calls.length, 3); assert.ok(hardware.calls[1].args.includes('h264_vaapi')); assert.ok(hardware.calls[2].args.includes('libx264')); }
  finally { await hardware.close(); }
});

test('strict VAAPI and the Plex protection setting never select software for missing GPUs', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }, { TRANSCODE_ACCEL: 'software', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ env });
    try {
      await assert.rejects(start(f.service), statusError(503));
      assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('strict VAAPI and the Plex protection setting preserve hardware errors without CPU fallback', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi', TRANSCODE_ALLOW_SOFTWARE: 'true' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ gpu: true, env, run: async ({ child }) => { child.stderr.write('hardware rejected https://secret.example/video?token=hidden'); child.exit(1); } });
    try {
      await assert.rejects(start(f.service), statusError(502));
      const encoders = f.calls.filter(call => call.args.includes('-i'));
      assert.equal(encoders.length, 1); assert.ok(encoders[0].args.includes('h264_vaapi'));
      assert.equal(f.logs.join('\n').includes('secret.example'), false);
      assert.deepEqual(await readdir(f.root), ['gpu']);
    } finally { await f.close(); }
  }
});

test('Linux children run at low priority while Windows launches stay hidden without Unix priority changes', async () => {
  for (const platform of ['linux', 'win32']) {
    const priorities = [], f = await fixture({ pid: 123456, di: { platform, setPriority: (pid, priority) => priorities.push([pid, priority]) } });
    try {
      await start(f.service);
      assert.deepEqual(priorities, platform === 'linux' ? [[123456, 19], [123456, 19]] : []);
      assert.ok(f.calls.every(call => call.options.windowsHide));
    } finally { await f.close(); }
  }
});

test('priority adjustment failures retain playback and sanitize diagnostic links', async () => {
  const f = await fixture({ pid: 123456, di: { platform: 'linux', setPriority() { throw new Error('denied https://secret.example/video?token=hidden'); } } });
  try {
    assert.equal((await start(f.service)).acceleration, 'software');
    assert.equal(f.logs.length, 2); assert.equal(f.logs.join('\n').includes('secret.example'), false);
  } finally { await f.close(); }
});

test('VAAPI uses hardware frames and bounded VBR while an absent device selects software directly', async () => {
  const hardware = await fixture({ gpu: true, env: { TRANSCODE_ACCEL: 'auto' } });
  try {
    assert.equal((await start(hardware.service)).acceleration, 'vaapi');
    const args = hardware.calls[1].args;
    assert.equal(args[args.indexOf('-hwaccel') + 1], 'vaapi'); assert.equal(args[args.indexOf('-hwaccel_output_format') + 1], 'vaapi'); assert.match(args[args.indexOf('-vf') + 1], /^scale_vaapi=.*format=nv12$/); assert.equal(args[args.indexOf('-rc_mode') + 1], 'VBR'); assert.equal(args.includes('-qp'), false); assert.equal(args.includes('-crf'), false); assert.equal(args.includes('-preset'), false);
  } finally { await hardware.close(); }
  const software = await fixture({ env: { TRANSCODE_ACCEL: 'auto' } });
  try { assert.equal((await start(software.service)).acceleration, 'software'); assert.equal(software.calls.length, 2); assert.equal(software.calls[1].args.includes('-hwaccel'), false); }
  finally { await software.close(); }
});

test('a hardware attempt that has already produced a segment never restarts encoding with software', async () => {
  const f = await fixture({ gpu: true, env: { TRANSCODE_ACCEL: 'auto' }, run: async ({ child, args }) => { await writeFile(join(args.at(-1), '..', 'segment000000.ts'), Buffer.alloc(188)); child.exit(1); } });
  try { await assert.rejects(start(f.service), statusError(502)); assert.equal(f.calls.length, 2); assert.deepEqual(await readdir(f.root), ['gpu']); }
  finally { await f.close(); }
});

test('overlapping same-owner starts supersede safely while a different pending owner is rejected', async () => {
  const f = await fixture();
  try {
    const first = start(f.service).then(() => 'unexpected success', error => error);
    const second = start(f.service, { position: 10 });
    await assert.rejects(start(f.service, { owner: 'device-b' }), statusError(409));
    assert.equal((await first).status, 409); assert.equal((await second).startPosition, 10);
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 1);
  } finally { await f.close(); }
});

test('closing or invalidating a task during startup rejects it and removes late-acquired resources', async () => {
  for (const close of [false, true]) {
    let good = true; const f = await fixture({ run: async () => {}, di: { startupTimeout: 100 } });
    try {
      const pending = start(f.service, { valid: () => good }).then(() => 'unexpected success', error => error);
      while (f.calls.length < 2) await new Promise(done => setTimeout(done, 2));
      if (close) await f.service.close(); else good = false;
      assert.equal((await pending).status, 409); assert.deepEqual(await readdir(f.root), []); assert.ok(f.children[1].signals.includes('SIGTERM'));
    } finally { await f.close(); }
  }
});

test('a hung availability probe is terminated and cached as unavailable', async () => {
  const f = await fixture({ hungVersion: true, ignoreKill: true, di: { probeTimeout: 10, killTimeout: 5 } });
  try { assert.equal((await f.service.status()).available, false); assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']); assert.equal((await f.service.status()).available, false); assert.equal(f.calls.length, 1); }
  finally { await f.close(); }
});

test('startup timeout kills the process, removes private files and sanitizes diagnostics', async () => {
  const f = await fixture({ run: async ({ child }) => child.stderr.write('Could not read https://secret.example/video?token=hidden\n'), di: { startupTimeout: 25 } });
  try { await assert.rejects(start(f.service), statusError(504)); assert.ok(f.children[1].signals.includes('SIGTERM')); assert.deepEqual(await readdir(f.root), []); assert.ok(f.logs.length); assert.equal(f.logs.join('\n').includes('secret.example'), false); assert.equal((await f.service.status()).running, false); }
  finally { await f.close(); }
});

test('SIGKILL bounds shutdown if SIGTERM is ignored and idle readers are cleaned up', async () => {
  const f = await fixture({ ignoreKill: true, di: { idleTimeout: 25, killTimeout: 10 } });
  try { await start(f.service); await new Promise(done => setTimeout(done, 80)); assert.ok(f.children[1].signals.includes('SIGTERM')); assert.ok(f.children[1].signals.includes('SIGKILL')); assert.equal((await f.service.status()).running, false); assert.deepEqual(await readdir(f.root), []); }
  finally { await f.close(); }
});

test('asset serving validates identity and paths, supports segment ranges and closes a newly invalid session', async () => {
  const f = await fixture(); let app, good = true;
  try {
    const result = await start(f.service, { valid: () => good }); app = await assetServer(f.service, result.id);
    const manifestResponse = await fetch(app.origin + '/index.m3u8'); assert.equal(manifestResponse.status, 200); assert.match(manifestResponse.headers.get('content-type'), /mpegurl/); assert.equal(await manifestResponse.text(), manifest);
    const ranged = await fetch(app.origin + '/segment000000.ts', { headers: { Range: 'bytes=0-9' } }); assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), 'bytes 0-9/752'); assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(app.origin + '/segment000000.ts', { headers: { Range: 'bytes=9999-' } })).status, 416);
    assert.equal((await fetch(app.origin + '/segment000000.ts', { headers: { Range: 'items=1-2' } })).status, 400);
    assert.equal((await fetch(app.origin + '/%2e%2e%2fsecret')).status, 404);
    assert.equal((await fetch(app.origin + '/index.m3u8', { method: 'POST' })).status, 400);
    good = false; assert.equal((await fetch(app.origin + '/index.m3u8')).status, 409); assert.deepEqual(await readdir(f.root), []);
  } finally { await app?.close(); await f.close(); }
});

test('MP4 input uses bounded container detection and compatibility assets do not expose stale task IDs', async () => {
  const f = await fixture(); let app;
  try { const result = await start(f.service, { episode: { url: 'https://movies.example/a.mp4?token=x', type: 'mp4' } }); assertRawInput(f.calls[1].args); assert.match(f.calls[1].args[f.calls[1].args.indexOf('-i') + 1], /asset\.mp4\?token=/); await f.service.cancel(result.id, 'device-a'); app = await assetServer(f.service, result.id); assert.equal((await fetch(app.origin + '/index.m3u8')).status, 404); }
  finally { await app?.close(); await f.close(); }
});

test('original Dolby probe can finish after six seconds within its caller deadline', async () => {
  const f = await fixture({ colorProbe: dolbyProbe(), colorProbeDelay: 6200, di: { probeTimeout: 6000 } });
  try {
    const proof = await f.service.inspectColor({ episode: { ...episode, type: 'mp4', colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'probe', valid: () => true, timeout: 14000 });
    assert.equal(supportsDolbyMapping(proof), true);
    assert.ok(f.children.every(child => child.finished));
    assert.equal(f.calls.some(call => call.args.includes('-c:v')), false);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('raw Dolby decoding may outlast 15 seconds without changing the single-thread or byte limits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered, release;
  const ready = new Promise(done => { entered = done; });
  const f = await fixture({ colorProbe: dolbyProbe(), inspect: async () => { entered(); await new Promise(done => { release = done; }); } });
  try {
    const pending = f.service.inspectColor({ episode: { type: 'mp4', url: 'https://fixtures.example/slow-dolby.mp4', colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'probe', valid: () => true, timeout: 30000 });
    await ready; t.mock.timers.tick(16000);
    assert.equal(f.children[0].finished, undefined);
    release(); assert.equal(supportsDolbyMapping(await pending), true);
    const args = f.calls[0].args; assert.equal(args[args.indexOf('-threads') + 1], '1');
    assert.equal(f.calls.some(call => call.args.includes('-c:v')), false);
  } finally { await f.close(); }
});

test('probe preserves upstream timeout, HTTP rejection and network failures before a readable body', async () => {
  for (const mode of ['dns', 'headers', 'body', 403, 412, 'network']) {
    const timeout = ['dns', 'headers', 'body'].includes(mode), upstream = [];
    const cause = Object.assign(new Error('https://private.example/secret-film.mp4?sign=signature-secret Cookie: cookie-secret'),
      timeout ? { code: 'MEDIA_SOURCE_TIMEOUT', stage: mode } : { code: 'ECONNRESET' });
    const media = createMedia({ secret: Buffer.alloc(32, 19), request: async () => {
      if (mode === 'body') {
        const stream = Object.assign(new PassThrough(), { statusCode: 206,
          headers: { 'content-type': 'video/mp4', 'content-length': '3', 'content-range': 'bytes 0-2/3' } });
        upstream.push(stream); setImmediate(() => stream.destroy(cause)); return stream;
      }
      if (Number.isInteger(mode)) {
        const stream = Object.assign(Readable.from(['denied']), { statusCode: mode, headers: { 'content-type': 'text/plain' } });
        upstream.push(stream); return stream;
      }
      throw cause;
    } });
    const f = await fixture({ media, colorProbe: dolbyProbe(), inspect: async ({ input }) => {
      await assert.rejects(async () => { const response = await fetch(input); await response.arrayBuffer(); });
    } });
    try {
      await assert.rejects(f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true }), error =>
        error.code === (timeout ? 'QUARK_COLOR_SOURCE_TIMEOUT' : 'QUARK_COLOR_SOURCE_FAILED') &&
        error.status === (timeout ? 504 : Number.isInteger(mode) ? mode : 502) && error.colorProbe.colorSpace === 'unknown');
      const entries = f.logs.filter(line => line.startsWith('HDR 色彩检查失败 ')); assert.equal(entries.length, 1);
      const summary = JSON.parse(entries[0].slice('HDR 色彩检查失败 '.length));
      assert.equal(summary.phase, timeout ? 'source-timeout' : 'source-failed');
      assert.equal(summary.upstreamStage, timeout ? mode : 'headers');
      assert.equal(summary.upstreamStatus, mode === 'body' ? 206 : Number.isInteger(mode) ? mode : null);
      assert.equal(summary.requests, 1); assert.equal(summary.bytes, 0);
      assert.doesNotMatch(f.logs.join('\n'), /private|secret|signature|cookie|https?:|mp4/i);
      assert.ok(upstream.every(stream => stream.destroyed)); assert.ok(f.children.every(child => child.finished));
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0); assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('probe timeout diagnostics distinguish unread and completed input without exposing stderr data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const read of [false, true]) {
    let entered; const ready = new Promise(resolve => { entered = resolve; });
    const source = probeRangeMedia('valid', 3), f = await fixture({ media: source.media, hungColorProbe: true, inspect: async ({ child, input }) => {
      child.stderr.write('Stream ends prematurely https://private.example/secret-film.mp4?sign=signature-secret Cookie: __puus=cookie-secret token=bare-secret C:\\private\\private-film.mkv');
      if (read) assert.equal((await (await fetch(input)).arrayBuffer()).byteLength, 3);
      entered();
    } });
    try {
      const pending = f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true, timeout: 5000 });
      await ready; t.mock.timers.tick(5000);
      await assert.rejects(pending, error => error.code === 'QUARK_COLOR_PROBE_TIMEOUT');
      assert.equal(f.logs.length, 1);
      const summary = JSON.parse(f.logs[0].slice('HDR 色彩检查失败 '.length));
      assert.equal(summary.phase, 'probe-timeout'); assert.equal(summary.rangeGuard, true);
      assert.equal(summary.requests, Number(read)); assert.equal(summary.bytes, read ? 3 : 0);
      assert.equal(summary.reserved, 0); assert.equal(summary.openResponses, 0);
      assert.equal(summary.processClosed, false); assert.equal(summary.exitCode, null); assert.equal(summary.stderrCategory, 'partial-input');
      assert.ok(Number.isFinite(summary.elapsedMs) && summary.elapsedMs >= 0);
      assert.ok(read ? Number.isFinite(summary.lastReadAgoMs) && summary.lastReadAgoMs >= 0 : summary.lastReadAgoMs === null);
      assert.doesNotMatch(f.logs[0], /private|secret|signature|cookie|token|https?:|mp4|mkv/i);
      assert.ok(f.logs[0].length < 512); assert.ok(f.children.every(child => child.finished));
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('a probe reconnect during termination cannot reopen an unguarded source read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered, reconnectStatus; const ready = new Promise(resolve => { entered = resolve; });
  const source = probeRangeMedia('valid', 3), f = await fixture({ media: source.media, hungColorProbe: true, inspect: async ({ child, input }) => {
    child.kill = signal => {
      child.signals.push(signal);
      if (signal === 'SIGTERM') {
        void fetch(input, { headers: { Range: 'bytes=0-' } }).then(async response => {
          reconnectStatus = response.status; await response.arrayBuffer();
        }).catch(() => { reconnectStatus = 0; }).finally(() => child.exit(0));
      } else child.exit(0);
      return true;
    };
    entered();
  } });
  try {
    const pending = f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true, timeout: 5000 });
    await ready; t.mock.timers.tick(5000);
    await assert.rejects(pending, error => error.code === 'QUARK_COLOR_PROBE_TIMEOUT');
    assert.deepEqual(source.calls, []);
    assert.notEqual(reconnectStatus, undefined); assert.notEqual(reconnectStatus, 206);
    assert.ok(f.children.every(child => child.finished)); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('probe diagnostics preserve range failures and distinguish a closed malformed probe', async () => {
  for (const mode of ['mismatch', 'malformed']) {
    const source = probeRangeMedia(mode === 'mismatch' ? mode : 'valid', 3);
    const f = await fixture({ media: source.media, colorProbeBody: '{malformed', inspect: async ({ input }) => {
      if (mode === 'mismatch') await assert.rejects(fetch(input));
    } });
    try {
      await assert.rejects(f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true }), error => error.code === (mode === 'mismatch' ? 'QUARK_COLOR_PROBE_READ_FAILED' : 'QUARK_COLOR_UNCONFIRMED'));
      assert.equal(f.logs.length, 1);
      const summary = JSON.parse(f.logs[0].slice('HDR 色彩检查失败 '.length));
      assert.equal(summary.phase, mode === 'mismatch' ? 'probe-read-failed' : 'probe-metadata-invalid');
      assert.equal(summary.requests, mode === 'mismatch' ? 1 : 0); assert.equal(summary.bytes, 0); assert.equal(summary.stderrCategory, 'none');
      if (mode === 'malformed') { assert.equal(summary.processClosed, true); assert.equal(summary.exitCode, 0); }
    } finally { await f.close(); }
  }
});

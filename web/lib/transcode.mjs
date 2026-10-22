import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { setPriority as nodeSetPriority, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { validateUrl } from './network.mjs';

const speeds = new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 3]);
const inputFormats = { hls: 'hls', mp4: 'mov', mkv: 'matroska', webm: 'matroska', avi: 'avi', mpegts: 'mpegts' };
const colorSpaces = new Set(['sdr', 'pq', 'hlg', 'dolby-vision', 'hdr', 'unknown', 'browser-default']);
const assetName = /^(?:index\.m3u8|segment\d{6,12}\.ts)$/;
const failure = (message, status = 502, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { status });
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const diagnostics = value => String(value).replace(/https?:\/\/[^\s'"<>]+/gi, '[媒体链接]').replace(/[\x00-\x08\x0b-\x1f]/g, '').slice(-4096);
const notSeekable = () => Object.assign(failure('原文件暂不支持定位续播，请从头播放或换官方在线线路', 409), { code: 'TRANSCODE_INPUT_NOT_SEEKABLE' });
function matchingRange(status, header, start, end) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(header('content-range') || ''));
  if (status !== 206 || !match) return false;
  const [first, last, size] = match.slice(1).map(Number), length = header('content-length');
  return [first, last, size].every(Number.isSafeInteger) && first === start && last >= first && size > last &&
    (end === undefined || last === Math.min(end, size - 1)) &&
    (length === undefined || length === null || /^\d+$/.test(String(length)) && Number(length) === last - first + 1);
}

export function supportsDolbyMapping(proof) {
  return proof?.codec === 'hevc' && ((proof.dolbyVisionProfile === 5 && proof.dolbyVisionCompatibilityId === 0) ||
    (proof.dolbyVisionProfile === 8 && proof.dolbyVisionCompatibilityId === 1)) && proof.rpuPresent === true &&
    proof.rpuSeen === true && proof.blPresent === true && proof.elPresent === false;
}

export function createTranscoder({ media, spawn = nodeSpawn, setPriority = nodeSetPriority, platform = process.platform, env = process.env, now = Date.now, tmpRoot = tmpdir(), device = '/dev/dri/renderD128', startupTimeout = 20_000, probeTimeout = 6000, killTimeout = 1500, idleTimeout = 120_000, pollInterval = 50, logger = console } = {}) {
  const enabled = String(env.TRANSCODE_ENABLED ?? 'true').toLowerCase() !== 'false';
  const preference = ['auto', 'software', 'vaapi'].includes(env.TRANSCODE_ACCEL) ? env.TRANSCODE_ACCEL : 'auto';
  const allowSoftware = String(env.TRANSCODE_ALLOW_SOFTWARE ?? 'true').toLowerCase() !== 'false';
  const executable = env.FFMPEG_PATH || 'ffmpeg';
  const probeExecutable = env.FFPROBE_PATH || (env.FFMPEG_PATH ? join(dirname(executable), platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
  let current, inspection, available, availability, availabilityAttempt, closed = false, lastError;

  function runProcess(args, onStderr, { command = executable, capture = false } = {}) {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let finish;
    const attempt = { child, done: false, error: null, code: null, stderr: '', stdout: '', stdoutBytes: 0, promise: new Promise(done => { finish = done; }) };
    const settle = (code, error) => { if (attempt.done) return; attempt.done = true; attempt.code = code; attempt.error = error; finish(); };
    child.once('error', error => settle(null, error));
    // ffprobe JSON is complete only after its output pipe closes.
    child.once(capture ? 'close' : 'exit', code => settle(code, null));
    child.stderr?.on('data', chunk => { attempt.stderr = (attempt.stderr + String(chunk)).slice(-16_384); onStderr?.(String(chunk)); });
    if (capture) child.stdout?.on('data', chunk => {
      attempt.stdoutBytes += Buffer.byteLength(chunk);
      if (attempt.stdoutBytes <= 65536) attempt.stdout += String(chunk);
      else if (!attempt.oversized) { attempt.oversized = true; try { child.kill('SIGTERM'); } catch (error) { logger.error('停止 HDR 色彩检查失败', diagnostics(error.message)); } }
    });
    if (platform === 'linux' && Number.isInteger(child.pid) && child.pid > 0) {
      try { setPriority(child.pid, 19); }
      catch (error) { if (error.code !== 'ESRCH') logger.error('降低兼容播放进程优先级失败', diagnostics(error.message)); }
    }
    return attempt;
  }
  async function terminate(attempt) {
    if (!attempt || attempt.done) return;
    try { attempt.child.kill('SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') logger.error('停止兼容播放进程失败', diagnostics(error.message)); }
    let timer;
    await Promise.race([attempt.promise, new Promise(done => { timer = setTimeout(done, killTimeout); })]); clearTimeout(timer);
    if (!attempt.done) {
      try { attempt.child.kill('SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') logger.error('结束兼容播放进程失败', diagnostics(error.message)); }
      await Promise.race([attempt.promise, new Promise(done => { timer = setTimeout(done, killTimeout); })]); clearTimeout(timer);
    }
  }
  async function installed() {
    if (available !== undefined) return available;
    if (!availability) availability = (async () => {
      let attempt, timer;
      try {
        attempt = availabilityAttempt = runProcess(['-version']);
        await Promise.race([attempt.promise, new Promise(done => { timer = setTimeout(done, probeTimeout); })]);
        available = attempt.done && !attempt.error && attempt.code === 0;
        if (!available) lastError = 'FFmpeg 不可用，请检查安装或 FFMPEG_PATH';
      } catch { available = false; lastError = 'FFmpeg 不可用，请检查安装或 FFMPEG_PATH'; }
      finally { clearTimeout(timer); await terminate(attempt); availabilityAttempt = undefined; }
      return available;
    })();
    return availability;
  }
  const valid = task => !closed && !task.stopped && (task.inspectOnly ? inspection === task : current === task) && (() => { try { return task.valid() === true; } catch { return false; } })();
  const assertValid = task => { if (task?.inputError) throw task.inputError; if (!valid(task)) throw failure('播放会话或资源配置已变更，请重新打开影片', 409); };
  async function removeOutput(task) {
    if (!task.dir) return;
    const path = resolve(task.dir), root = resolve(tmpRoot);
    if (!path.startsWith(root + sep) || !path.split(sep).at(-1).startsWith('vipvideo-transcode-')) throw failure('兼容播放临时目录无效');
    await rm(path, { recursive: true, force: true });
  }
  async function cleanup(task) {
    if (task.cleaning) return task.cleaning;
    task.cleaning = (async () => {
      task.stopped = true; clearTimeout(task.idleTimer); task.probeController?.abort();
      await stopReadScope(task, task.probeReads); await stopReadScope(task, task.encoderReads);
      await terminate(task.probeAttempt);
      await terminate(task.attempt);
      for (const socket of task.sockets || []) socket.destroy();
      if (task.bridge?.listening) await new Promise(done => task.bridge.close(done));
      await removeOutput(task);
      if (current === task) current = undefined;
      if (inspection === task) inspection = undefined;
    })().finally(() => { delete task.cleaning; });
    return task.cleaning;
  }
  function armIdle(task) {
    clearTimeout(task.idleTimer);
    task.idleTimer = setTimeout(() => { cleanup(task).catch(error => logger.error('清理兼容播放失败', diagnostics(error.message))); }, idleTimeout);
    task.idleTimer.unref?.();
  }
  function signedPath(value, origin, proxyPath = '/api/media') {
    const parsed = new URL(value, origin), token = parsed.searchParams.get('token');
    if (parsed.origin !== origin || parsed.pathname !== proxyPath || parsed.hash || [...parsed.searchParams].length !== 1 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token || '')) throw failure('媒体清单包含不安全的转发地址');
    let extension = 'ts';
    try {
      const data = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      const suffix = new URL(data.url).pathname.match(/\.(m3u8|mp4|m4s|ts|aac|vtt|key)$/i)?.[1]?.toLowerCase();
      extension = data.type === 'hls' ? 'm3u8' : ['mp4', 'mkv', 'webm', 'avi'].includes(data.type) ? data.type : suffix || 'ts';
    } catch { throw failure('媒体清单转发凭证无效'); }
    return `${origin}/api/media/asset.${extension}?token=${token}`;
  }
  function bridgeManifest(body, origin, proxyPath) {
    if (Buffer.byteLength(body) > 2 * 1024 * 1024 || !body.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) throw failure('兼容播放收到无效媒体清单');
    return body.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith('#')) return signedPath(trimmed, origin, proxyPath);
      return line.replace(/\bURI\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/gi, (_match, quoted, single, bare) => {
        if (single !== undefined || bare !== undefined) throw failure('媒体清单 URI 格式无效');
        return `URI="${signedPath(quoted, origin, proxyPath)}"`;
      });
    }).join('\n');
  }
  async function stopReadScope(task, scope) {
    if (!scope) return;
    if (task.probeReads === scope) delete task.probeReads;
    if (task.encoderReads === scope) delete task.encoderReads;
    scope.closed = true;
    const closing = [...scope.responses].filter(response => !response.closed).map(response => new Promise(done => response.once('close', done)));
    for (const response of scope.responses) response.destroy();
    scope.responses.clear();
    await Promise.all(closing);
  }
  function guardSourceRead(task, req, res) {
    const scope = task.probeReads || task.encoderReads;
    if (!scope) return;
    const encoder = scope.encoding === true, windowLimit = (encoder ? 8 : 2) * 1024 * 1024;
    const reject = () => {
      if (!scope.error) {
        scope.error = encoder
          ? Object.assign(failure('杜比原片的媒体范围响应无效，已停止兼容播放', 502), { code: 'TRANSCODE_INPUT_READ_FAILED' })
          : Object.assign(failure('原片色彩检查的范围响应无效或超过读取限额，已停止读取', 502), { code: 'QUARK_COLOR_PROBE_READ_FAILED', colorProbe: { colorSpace: 'unknown' } });
        scope.failed?.();
        if (encoder) {
          task.inputError = scope.error; lastError = scope.error.message;
          void cleanup(task).catch(error => logger.error('停止杜比媒体失败', diagnostics(error.message)));
        }
      }
      for (const response of scope.responses) response.destroy();
      return scope.error;
    };
    if (scope.closed || scope.error || !encoder && scope.requests >= 16) throw reject();
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || 'bytes=0-');
    if (!match) throw reject();
    const start = Number(match[1]), wantedEnd = match[2] ? Number(match[2]) : undefined;
    if (!Number.isSafeInteger(start) || start < 0 || wantedEnd !== undefined && (!Number.isSafeInteger(wantedEnd) || wantedEnd < start)) throw reject();
    const remaining = encoder ? Infinity : 16 * 1024 * 1024 - scope.bytes - scope.reserved;
    const window = Math.min(windowLimit, req.method === 'HEAD' ? windowLimit : remaining);
    if (window <= 0 || !Number.isSafeInteger(start + window - 1) || scope.total !== undefined && start >= scope.total) throw reject();
    const end = Math.min(start + window - 1, wantedEnd ?? Infinity, scope.total === undefined ? Infinity : scope.total - 1);
    req.headers.range = `bytes=${start}-${end}`;
    scope.requests++; scope.responses.add(res);
    let reserved = req.method === 'HEAD' ? 0 : end - start + 1, left = reserved, checked = false, released = false;
    scope.reserved += reserved;
    const release = () => {
      if (released) return;
      released = true; scope.reserved -= reserved; reserved = 0; scope.responses.delete(res);
    };
    res.once('finish', release); res.once('close', release);
    const headers = status => {
      if (scope.closed || scope.error) return false;
      if (checked) return true;
      const length = res.getHeader('content-length');
      if (!/^\d+$/.test(String(length)) || !matchingRange(status, name => res.getHeader(name), start, end)) { reject(); return false; }
      const total = Number(/^bytes \d+-\d+\/(\d+)$/.exec(String(res.getHeader('content-range')))[1]);
      if (scope.total !== undefined && scope.total !== total) { reject(); return false; }
      scope.total = total; checked = true;
      if (req.method !== 'HEAD') {
        const actual = Number(length);
        scope.reserved -= reserved - actual; reserved = left = actual;
      }
      return true;
    };
    const count = (chunk, encoding) => {
      if (res.destroyed || released) return false;
      if (!headers(res.statusCode)) return false;
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk?.byteLength || 0;
      if (size > left || !encoder && scope.bytes + size > 16 * 1024 * 1024) { reject(); return false; }
      left -= size; reserved -= size; scope.reserved -= size; scope.bytes += size;
      return true;
    };
    const writeHead = res.writeHead.bind(res), write = res.write.bind(res), endResponse = res.end.bind(res);
    res.writeHead = (status, ...args) => headers(status) ? writeHead(status, ...args) : res;
    res.write = (chunk, encoding, callback) => count(chunk, encoding) ? write(chunk, encoding, callback) : false;
    res.end = (chunk, encoding, callback) => {
      if (res.destroyed) return res;
      if (!headers(res.statusCode) || chunk && !count(chunk, encoding)) return res;
      if (req.method !== 'HEAD' && left !== 0) { reject(); return res; }
      return endResponse(chunk, encoding, callback);
    };
  }
  async function bridge(task) {
    const server = task.bridge = createServer(async (req, res) => {
      try {
        assertValid(task);
        const origin = task.origin, parsed = new URL(req.url, origin);
        if (!['GET', 'HEAD'].includes(req.method) || parsed.origin !== origin || req.headers.host !== new URL(origin).host || !/^\/api\/media\/asset\.(?:m3u8|mp4|mkv|webm|avi|m4s|ts|aac|vtt|key)$/.test(parsed.pathname) || [...parsed.searchParams].length !== 1 || !parsed.searchParams.get('token')) throw failure('转发请求无效', 403);
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => { if (String(name).toLowerCase() === 'location') throw failure('媒体转发禁止重定向'); return setHeader(name, value); };
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (status, ...args) => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
          if (task.position > 0 && task.type !== 'hls' && range && Number(range[1]) > 0 && [200, 206].includes(status) &&
              !matchingRange(status, name => res.getHeader(name), Number(range[1]), range[2] ? Number(range[2]) : undefined)) {
            task.inputError = notSeekable(); res.destroy(); return res;
          }
          return writeHead(status, ...args);
        };
        const end = res.end.bind(res);
        res.end = (body, encoding, callback) => {
          if (body && /mpegurl/i.test(String(res.getHeader('Content-Type') || ''))) {
            body = bridgeManifest(Buffer.isBuffer(body) ? body.toString('utf8') : String(body), origin, task.proxyPath);
            res.setHeader('Content-Length', Buffer.byteLength(body));
          }
          return end(body, encoding, callback);
        };
        guardSourceRead(task, req, res);
        await task.media.serve(req, res, parsed.searchParams.get('token'));
      } catch (error) {
        if (res.destroyed) return;
        if (!res.headersSent) { res.statusCode = error.status || 502; res.removeHeader('Content-Length'); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('兼容播放媒体转发失败'); }
        else res.destroy(error);
      }
    });
    task.sockets = new Set(); server.on('connection', socket => { task.sockets.add(socket); socket.once('close', () => task.sockets.delete(socket)); });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); done(); }); });
    task.origin = `http://127.0.0.1:${server.address().port}`;
    return signedPath(task.playback.proxyUrl, task.origin, task.proxyPath);
  }
  async function checkResumeRange(task, deadline) {
    if (task.position === 0 || task.type === 'hls') return;
    const controller = task.probeController = new AbortController();
    const remaining = deadline - now();
    if (remaining <= 0) throw failure('兼容播放启动超时，请切换线路或稍后重试', 504);
    const startupLimited = remaining <= 8000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(8000, remaining));
    let response;
    try {
      response = await fetch(task.input, { headers: { Range: 'bytes=1-1' }, redirect: 'error', signal: controller.signal });
      assertValid(task);
      if (!matchingRange(response.status, name => response.headers.get(name), 1, 1)) {
        if ([200, 206, 416].includes(response.status)) throw task.inputError = notSeekable();
        throw failure('无法检查原文件的定位续播能力，请稍后重试或换官方在线线路');
      }
    } catch (error) {
      assertValid(task);
      if (task.inputError) throw task.inputError;
      if (timedOut && startupLimited || now() >= deadline) throw failure('兼容播放启动超时，请切换线路或稍后重试', 504);
      throw error.status ? error : failure('无法检查原文件的定位续播能力，请稍后重试或换官方在线线路', 502, error);
    } finally {
      clearTimeout(timer);
      if (response?.body) await response.body.cancel().catch(error => { if (!controller.signal.aborted) logger.error('结束续播检查失败', diagnostics(error.message)); });
      if (task.probeController === controller) delete task.probeController;
    }
  }
  async function checkColor(task, deadline) {
    if (!task.inspectOnly && (task.colorSpace === 'sdr' || task.colorSpace !== 'dolby-vision' && task.sourceColorSpace !== 'dolby-vision')) return;
    const sourceRisk = ['pq', 'hlg', 'hdr', 'dolby-vision'].some(value => [task.sourceColorSpace, task.colorSpace].includes(value));
    let attempt, timer;
    const scope = task.type !== 'hls' && (task.colorSpace === 'dolby-vision' || task.sourceColorSpace === 'dolby-vision')
      ? task.probeReads = { bytes: 0, reserved: 0, requests: 0, responses: new Set(), promise: undefined } : undefined;
    if (scope) scope.promise = new Promise(done => { scope.failed = done; });
    try {
      attempt = task.probeAttempt = runProcess(['-v', 'error', '-threads', '1', '-protocol_whitelist', 'http,tcp,crypto',
        '-analyzeduration', '1000000', '-probesize', '1048576', '-f', inputFormats[task.type],
        ...(task.type === 'hls' ? ['-allowed_extensions', 'ALL'] : []), '-read_intervals', '%+#1', '-i', task.input,
        '-select_streams', 'v:0', '-show_streams', '-show_frames', '-show_entries',
        'stream=codec_name,codec_tag_string,pix_fmt,bits_per_raw_sample,color_space,color_transfer,color_primaries:stream_side_data:frame=pix_fmt,color_space,color_transfer,color_primaries:frame_side_data', '-of', 'json'], undefined, { command: probeExecutable, capture: true });
      const colorBudget = sourceRisk ? 6000 : 3000;
      await Promise.race([attempt.promise, ...(scope ? [scope.promise] : []), new Promise(done => { timer = setTimeout(done, Math.max(1, Math.min(probeTimeout, colorBudget, deadline - now()))); })]);
      assertValid(task);
      if (scope?.error) throw scope.error;
      if (!attempt.done) throw Object.assign(failure('原文件色彩信息读取超时，请稍后重试或选择其他版本', 504), { code: 'QUARK_COLOR_PROBE_TIMEOUT', colorProbe: { colorSpace: 'unknown' } });
      if (attempt.error || attempt.code !== 0 || attempt.oversized) throw new Error('probe unavailable');
      const result = JSON.parse(attempt.stdout), stream = result.streams?.[0], frame = result.frames?.[0];
      if (!stream || !frame) throw new Error('missing decoded video metadata');
      const sideData = [...(stream.side_data_list || []), ...(frame.side_data_list || [])];
      const transfer = frame.color_transfer || stream.color_transfer, primaries = frame.color_primaries || stream.color_primaries, matrix = frame.color_space || stream.color_space;
      const unspecified = value => !value || ['unknown', 'unspecified'].includes(value);
      const consistent = ['color_transfer', 'color_primaries', 'color_space'].every(key => new Set([stream[key], frame[key]].filter(value => !unspecified(value))).size <= 1);
      const sdrPrimaries = new Set(['bt709', 'bt470bg', 'smpte170m', 'smpte240m']), sdrMatrices = new Set(['bt709', 'bt470bg', 'smpte170m', 'smpte240m', 'fcc', 'gbr']);
      const hdrMetadata = sideData.some(row => /hdr|mastering display|content light|smpte.?2094/i.test(row?.side_data_type || ''));
      const dolby = /^(?:dvhe|dvh1|dvav|dva1)$/i.test(stream.codec_tag_string || '') || sideData.some(row => row && (/dovi|dolby.?vision/i.test(row.side_data_type || '') || row.dv_profile !== undefined));
      const config = sideData.find(row => Number.isSafeInteger(row?.dv_profile) && row.dv_profile >= 0 && row.dv_profile <= 255), profile = config?.dv_profile;
      const field = value => typeof value === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(value) ? value : '';
      const pixFmt = field(frame.pix_fmt || stream.pix_fmt), formatDepth = /^(?:yuv420p|yuvj420p|nv12)$/.test(pixFmt) ? 8 : /^(?:yuv\d+p|gbrp)(10|12|16)(?:le|be)$/.exec(pixFmt)?.[1];
      const declaredDepth = Number(stream.bits_per_raw_sample), bitDepth = formatDepth && (!Number.isInteger(declaredDepth) || declaredDepth <= 0 || declaredDepth === Number(formatDepth)) ? Number(formatDepth) : undefined;
      task.colorProbe = { codec: field(stream.codec_name), transfer: field(transfer), primaries: field(primaries), matrix: field(matrix), ...(pixFmt ? { pixFmt } : {}), ...(bitDepth ? { bitDepth } : {}), ...(profile === undefined ? {} : { dolbyVisionProfile: profile }) };
      if (Number.isSafeInteger(config?.dv_bl_signal_compatibility_id) && config.dv_bl_signal_compatibility_id >= 0 && config.dv_bl_signal_compatibility_id <= 15) task.colorProbe.dolbyVisionCompatibilityId = config.dv_bl_signal_compatibility_id;
      for (const [source, target] of [['rpu_present_flag', 'rpuPresent'], ['bl_present_flag', 'blPresent'], ['el_present_flag', 'elPresent']]) if (config?.[source] === 0 || config?.[source] === 1) task.colorProbe[target] = config[source] === 1;
      if (dolby) task.colorProbe.rpuSeen = (frame.side_data_list || []).some(row => /dolby.?vision.*(?:rpu|metadata)|dovi.*(?:rpu|metadata)/i.test(row?.side_data_type || '') && !/configuration/i.test(row.side_data_type));
      if (dolby) {
        task.colorSpace = task.colorProbe.colorSpace = 'dolby-vision';
        if (task.inspectOnly) return;
        if (supportsDolbyMapping(task.colorProbe)) return;
        throw failure('此杜比视界版本缺少可确认的单层 RPU 数据，暂不能正确转换，请选择其他 SDR 版本', 409);
      }
      if (!task.inspectOnly && task.colorSpace === 'dolby-vision') throw failure('原片未提供可确认的杜比 RPU 数据，已停止转换，请选择其他 SDR 版本', 409);
      if (['smpte2084', 'arib-std-b67'].includes(transfer) && primaries === 'bt2020' && ['bt2020nc', 'bt2020c'].includes(matrix)) task.colorSpace = transfer === 'smpte2084' ? 'pq' : 'hlg';
      else if (['bt709', 'smpte170m', 'iec61966-2-1'].includes(transfer) && consistent && !hdrMetadata &&
          [stream, frame].every(row => (unspecified(row.color_primaries) || sdrPrimaries.has(row.color_primaries)) && (unspecified(row.color_space) || sdrMatrices.has(row.color_space))) &&
          (!sourceRisk || sdrPrimaries.has(primaries) && sdrMatrices.has(matrix))) task.colorSpace = 'sdr';
      // Missing AVC color tags can use the browser's default without claiming verified SDR.
      else if (!['pq', 'hlg', 'hdr', 'dolby-vision'].includes(task.colorSpace) && ['unknown', 'sdr'].includes(task.sourceColorSpace || 'unknown') && task.colorProbe.codec === 'h264' && bitDepth === 8 &&
          [stream.pix_fmt, frame.pix_fmt].every(value => !value || ['yuv420p', 'yuvj420p', 'nv12'].includes(value)) &&
          [stream, frame].every(row => [row.color_transfer, row.color_primaries, row.color_space].every(value => !value || ['unknown', 'unspecified'].includes(value))) &&
          !hdrMetadata) task.colorSpace = 'browser-default';
      else throw new Error('unknown color metadata');
      task.colorProbe.colorSpace = task.colorSpace;
    } catch (error) {
      assertValid(task);
      if (error.status) throw error;
      if (attempt?.stderr) logger.error('HDR 色彩检查失败', diagnostics(attempt.stderr));
      throw Object.assign(failure('无法确认此视频的色彩信息，已停止兼容播放以避免偏色，请改用夸克官方 SDR 线路或其他 SDR 版本', 409), { code: 'QUARK_COLOR_UNCONFIRMED', colorProbe: { ...task.colorProbe, colorSpace: 'unknown' } });
    } finally {
      clearTimeout(timer); await stopReadScope(task, scope); await terminate(attempt);
      if (task.probeAttempt === attempt) delete task.probeAttempt;
    }
  }
  function argumentsFor(task, acceleration) {
    const scale = "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
    const dolby = task.colorSpace === 'dolby-vision', hardware = acceleration === 'vaapi';
    const toneMapped = dolby || task.sourceColorSpace === 'dolby-vision' && ['pq', 'hlg'].includes(task.colorSpace);
    const toneMap = `${scale},zscale=transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,tonemap=tonemap=hable:desat=2,zscale=transfer=bt709:matrix=bt709:range=limited,format=yuv420p,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL`;
    // The original HEVC RPU must reach libplacebo; an already miscoloured AVC stream cannot be repaired here.
    const dolbyMap = `${hardware ? 'hwmap=derive_device=vulkan,format=vulkan' : 'hwupload'},libplacebo=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:format=yuv420p:apply_dolbyvision=1:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=hable:peak_detect=false:upscaler=none:downscaler=none,hwdownload,format=yuv420p${hardware ? ',format=nv12,hwupload' : ''}`;
    return ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-threads', dolby && !hardware ? '4' : '1', '-filter_threads', '1',
      ...(dolby ? ['-init_hw_device', hardware ? `vaapi=va:${device}` : 'vulkan=vk:0', '-filter_hw_device', hardware ? 'va' : 'vk'] : []),
      ...(hardware ? ['-hwaccel', 'vaapi', '-hwaccel_device', dolby ? 'va' : device, '-hwaccel_output_format', 'vaapi'] : []),
      '-protocol_whitelist', 'http,tcp,crypto', '-readrate', String(task.speed), ...(task.position > 0 ? ['-ss', String(task.position)] : []), '-f', inputFormats[task.type],
      ...(task.type === 'hls' ? ['-allowed_extensions', 'ALL'] : []), ...(task.encoderReads ? ['-reconnect', '1'] : []), '-i', task.input,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', dolby ? dolbyMap : toneMapped ? toneMap : hardware ? "scale_vaapi=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:format=nv12" : `${scale},format=yuv420p`,
      ...(toneMapped ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
      '-c:v', acceleration === 'vaapi' ? 'h264_vaapi' : 'libx264', ...(acceleration === 'vaapi' ? ['-rc_mode', 'VBR', '-b:v', '2500k'] : ['-preset', 'veryfast', '-crf', '23']),
      '-maxrate', '3500k', '-bufsize', '7000k', '-r', '30', '-threads', '1', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '30', '-hls_flags', 'delete_segments+temp_file', '-hls_segment_filename', join(task.dir, 'segment%06d.ts'), join(task.dir, 'index.m3u8')];
  }
  async function ready(task, deadline) {
    while (now() < deadline) {
      assertValid(task);
      if (task.inputError) throw task.inputError;
      try {
        const body = await readFile(join(task.dir, 'index.m3u8'), 'utf8');
        const lines = body.split(/\r?\n/).map(line => line.trim());
        const segments = lines.filter(line => line && !line.startsWith('#'));
        if (Buffer.byteLength(body) > 128 * 1024 || !body.startsWith('#EXTM3U') || segments.some(file => !/^segment\d{6,12}\.ts$/.test(file))) throw failure('兼容播放输出清单无效');
        const dolby = task.colorSpace === 'dolby-vision';
        const buffered = dolby ? [...new Set(segments)] : segments;
        const required = dolby && !(buffered.length === 1 && lines.includes('#EXT-X-ENDLIST')) ? 2 : 1;
        if (buffered.length >= required && (await Promise.all(buffered.slice(0, required).map(file => stat(join(task.dir, file))))).every(file => file.size > 0)) { task.produced = true; return; }
      } catch (error) { if (!['ENOENT'].includes(error.code)) throw error; }
      assertValid(task);
      if (task.inputError) throw task.inputError;
      if (task.attempt.done) {
        if (task.colorSpace === 'dolby-vision') throw failure('杜比色彩转换未能启动，请检查 FFmpeg 的 libplacebo 支持、Vulkan 驱动与核显权限，或选择其他 SDR 版本', 503);
        if (['pq', 'hlg'].includes(task.colorSpace) && /No such filter[^\r\n]*(?:zscale|tonemap|sidedata)/i.test(task.attempt.stderr)) throw failure('当前 FFmpeg 缺少 HDR 色调映射支持，请改用夸克官方 SDR 线路', 503);
        throw failure('FFmpeg 未能启动兼容编码，请检查输入格式或硬件权限');
      }
      await wait(Math.min(pollInterval, Math.max(1, deadline - now())));
    }
    throw failure('兼容播放启动超时，请切换线路或稍后重试', 504);
  }
  return {
    async status() { return { available: enabled && !closed ? await installed() : available === true, enabled: enabled && !closed, acceleration: preference, running: !!current && !current.stopped, ...(lastError ? { error: lastError } : {}) }; },
    async inspectColor({ episode, sourceColorSpace = 'unknown', owner, valid: isValid, mediaOverride, proxyPath = '/api/media', signal, timeout = 3000 } = {}) {
      const selectedMedia = mediaOverride ?? media;
      if (closed || inspection && !inspection.stopped) throw failure('色彩检查暂时繁忙', 409);
      if (!selectedMedia?.playback || !selectedMedia?.serve || typeof owner !== 'string' || !owner || owner.length > 256 || typeof isValid !== 'function' || !Object.hasOwn(inputFormats, episode?.type) || typeof episode.url !== 'string' || episode.url.length > 8192 || !/^\/api\/[a-z0-9/_-]{1,120}$/.test(proxyPath) || !Number.isFinite(timeout) || timeout <= 0) throw failure('色彩检查参数无效', 400);
      if (!colorSpaces.has(sourceColorSpace) || sourceColorSpace === 'browser-default') throw failure('原文件色彩参数无效', 400);
      const url = validateUrl(episode.url).href;
      const task = inspection = { owner, valid: isValid, stopped: false, type: episode.type, colorSpace: episode.colorSpace, sourceColorSpace, inspectOnly: true, position: 0, media: selectedMedia, proxyPath };
      const abort = () => { void cleanup(task).catch(error => logger.error('停止色彩检查失败', diagnostics(error.message))); };
      try {
        if (signal?.aborted) throw failure('色彩检查已取消', 499);
        signal?.addEventListener('abort', abort, { once: true });
        assertValid(task); task.playback = selectedMedia.playback({ lines: [{ episodes: [{ url, type: task.type }] }] }, 0, 0);
        task.input = await bridge(task); assertValid(task);
        await checkColor(task, now() + timeout); assertValid(task);
        return { ...task.colorProbe };
      } finally { signal?.removeEventListener('abort', abort); await cleanup(task); }
    },
    async start({ episode, position = 0, speed = 1, owner, valid: isValid, mediaOverride, proxyPath = '/api/media' } = {}) {
      if (!enabled || closed) throw failure('兼容播放已关闭', 503);
      const selectedMedia = mediaOverride ?? media;
      if (!selectedMedia?.playback || !selectedMedia?.serve) throw failure('兼容播放需要签名媒体转发模块', 503);
      if (typeof owner !== 'string' || !owner || owner.length > 256 || typeof isValid !== 'function' || !Number.isFinite(position) || position < 0 || position > 604800 || !speeds.has(speed) || !Object.hasOwn(inputFormats, episode?.type) || typeof episode.url !== 'string' || episode.url.length > 8192 || !/^\/api\/[a-z0-9/_-]{1,120}$/.test(proxyPath)) throw failure('兼容播放参数无效', 400);
      if (episode.colorSpace !== undefined && !colorSpaces.has(episode.colorSpace)) throw failure('兼容播放色彩参数无效', 400);
      if (episode.sourceColorSpace !== undefined && (!colorSpaces.has(episode.sourceColorSpace) || episode.sourceColorSpace === 'browser-default')) throw failure('原文件色彩参数无效', 400);
      const url = validateUrl(episode.url).href;
      if (current && !current.stopped && current.owner !== owner) throw failure('另一台设备正在使用兼容播放，请稍后再试', 409);
      const previous = current, task = { id: randomBytes(16).toString('hex'), owner, valid: isValid, position, speed, type: episode.type, colorSpace: episode.colorSpace, sourceColorSpace: episode.sourceColorSpace ?? 'unknown', duration: null, stopped: false, media: selectedMedia, proxyPath };
      current = task;
      try {
        if (previous) await cleanup(previous);
        assertValid(task); if (!await installed()) throw failure(lastError, 503); assertValid(task);
        task.playback = selectedMedia.playback({ lines: [{ episodes: [{ url, type: task.type }] }] }, 0, 0);
        task.dir = await mkdtemp(join(tmpRoot, 'vipvideo-transcode-')); assertValid(task);
        task.input = await bridge(task); assertValid(task);
        let acceleration = 'software';
        if (preference !== 'software') {
          try { await access(device, constants.R_OK | constants.W_OK); acceleration = 'vaapi'; }
          catch { if (preference === 'vaapi' || !allowSoftware) throw failure('GPU 不可访问，已停止兼容播放以避免软件编码，请检查核显映射与权限', 503); }
        }
        if (acceleration === 'software' && !allowSoftware) throw failure('软件兼容编码已关闭，请使用可用的核显或切换播放线路', 503);
        const deadline = now() + startupTimeout;
        await checkResumeRange(task, deadline); assertValid(task);
        await checkColor(task, deadline); assertValid(task);
        if (task.sourceColorSpace === 'dolby-vision' && ['pq', 'hlg'].includes(task.colorSpace)) {
          if (preference === 'vaapi' || !allowSoftware) throw failure('HDR 转为普通色彩需要软件色调映射，当前设置不允许，请改用夸克官方 SDR 线路', 503);
          acceleration = 'software';
        }
        if (task.type !== 'hls' && task.colorSpace === 'dolby-vision') task.encoderReads = { encoding: true, bytes: 0, reserved: 0, requests: 0, responses: new Set() };
        for (;;) {
          assertValid(task);
          task.attempt = runProcess(argumentsFor(task, acceleration), text => {
            const durationText = (task.durationText || '') + text;
            const match = durationText.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
            task.durationText = durationText.slice(-2048);
            if (match) {
              const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
              if (Number(match[2]) < 60 && Number(match[3]) < 60 && Number.isFinite(duration) && duration <= 604800) task.duration = duration;
            }
          });
          try { await ready(task, deadline); break; }
          catch (error) {
            const files = await readdir(task.dir).catch(() => []);
            if (preference === 'vaapi' || !allowSoftware || acceleration !== 'vaapi' || files.some(file => /^segment\d{6,12}\.ts$/.test(file)) || !valid(task) || now() >= deadline) throw error;
            await terminate(task.attempt); await removeOutput(task); await mkdir(task.dir, { mode: 0o700 }); acceleration = 'software';
          }
        }
        assertValid(task); lastError = undefined; armIdle(task);
        return { id: task.id, url: `/api/transcode/${task.id}/index.m3u8`, type: 'hls', transcoded: true, startPosition: position, duration: task.duration, acceleration };
      } catch (error) {
        lastError = error.status ? error.message : '兼容播放启动失败，请检查 FFmpeg';
        if (task.attempt?.stderr) logger.error('兼容播放失败', diagnostics(task.attempt.stderr));
        await cleanup(task); throw error.status ? error : failure(lastError, 502);
      }
    },
    async serve(req, res, id, file) {
      const task = current;
      if (!task || task.id !== id || !/^[a-f0-9]{32}$/.test(id) || typeof file !== 'string' || !assetName.test(file)) throw failure('兼容播放资源不存在', 404);
      if (!valid(task)) { await cleanup(task); throw failure('播放会话或资源配置已变更', 409); }
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) throw failure('不支持的媒体请求方法', 400);
      const path = join(task.dir, file);
      let info;
      try { const canonical = await realpath(path); if (!canonical.startsWith(resolve(task.dir) + sep)) throw failure('媒体文件路径无效', 403); info = await stat(canonical); }
      catch (error) { if (error.code === 'ENOENT') throw failure('兼容播放分片尚未生成或已过期', 404); throw error; }
      if (!info.isFile()) throw failure('媒体文件无效', 403);
      assertValid(task); armIdle(task);
      let start = 0, end = info.size - 1;
      if (req.headers?.range && file !== 'index.m3u8') {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) throw failure('Range 请求格式无效', 400);
        if (match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
        else start = Math.max(0, info.size - Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${info.size}`); res.end(); return; }
        end = Math.min(end, info.size - 1); res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      } else res.statusCode = 200;
      res.setHeader('Content-Type', file === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t'); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
      await pipeline(createReadStream(path, { start, end }), res);
    },
    async cancel(id, owner) { if (!current || current.id !== id) return false; if (current.owner !== owner) throw failure('只能停止当前设备发起的兼容播放', 403); await cleanup(current); return true; },
    async close() { closed = true; if (inspection) await cleanup(inspection); if (current) await cleanup(current); await terminate(availabilityAttempt); },
  };
}

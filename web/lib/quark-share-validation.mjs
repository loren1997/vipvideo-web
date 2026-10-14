const fid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const unavailable = reason => ({ status: 'unavailable', reason });
function identity(resource) {
  const pwdId = resource?.pwdId, password = resource?.password ?? '';
  return typeof pwdId === 'string' && /^[a-z0-9]{6,32}$/i.test(pwdId) && typeof password === 'string' && /^[a-z0-9]{0,16}$/i.test(password) ? { pwdId, password, key: pwdId + ':' + password } : null;
}

export function createQuarkShareValidator({ read, now = Date.now, isVideo, isDirectory } = {}) {
  if (![read, isVideo, isDirectory].every(value => typeof value === 'function')) throw new TypeError('Share validation requires read and file predicates');
  const cache = new Map(), queue = [], active = new Set();
  let stopped = false, stopPromise;

  function finish(work, result) {
    if (work.controller?.signal.aborted) result = unavailable(work.controller.signal.reason?.message || '分享校验已取消');
    Object.assign(work.entry, result, { pending: false });
    if (!result.reason) delete work.entry.reason;
    delete work.entry.promise;
    work.expires = now() + (result.status === 'valid' ? 120_000 : 30_000);
    work.resolve?.(work.entry);
  }

  async function scan(work) {
    const { signal } = work.controller, deadline = now() + 8000;
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    const timer = setTimeout(() => work.controller.abort(new Error('分享校验超过8秒，请稍后重试')), 8000);
    const guard = () => {
      if (now() >= deadline && !signal.aborted) work.controller.abort(new Error('分享校验超过8秒，请稍后重试'));
      signal.throwIfAborted();
    };
    const call = async (path, input = {}) => {
      guard();
      const result = await Promise.race([
        Promise.resolve().then(() => { guard(); return read(path, { ...input, signal, timeout: Math.max(1, deadline - now()) }); }),
        aborted,
      ]);
      guard();
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.code !== undefined && result.code !== 0 || Number(result.status || 200) >= 400) throw Object.assign(new Error('分享响应未通过核验'), { status: Number(result?.status) });
      return result;
    };
    try {
      const token = await call('/share/sharepage/token', { method: 'POST', body: { pwd_id: work.pwdId, passcode: work.password } });
      if (typeof token?.data?.stoken !== 'string' || !token.data.stoken || token.data.stoken.length > 4096) return unavailable('分享暂时无法核验，可能已取消、需要提取码或受访问限制');
      const folders = [{ fid: '0', depth: 0, page: 1, count: 0 }], seen = new Set();
      let requests = 0, incomplete = false;
      while (folders.length && requests++ < 5) {
        const folder = folders.shift();
        const result = await call('/share/sharepage/detail', { method: 'GET', query: { pwd_id: work.pwdId, stoken: token.data.stoken, pdir_fid: folder.fid, _page: String(folder.page), _size: '100', _fetch_total: '1', ver: '2', force: '0' } });
        const list = result?.data?.list;
        if (!Array.isArray(list) || list.length > 100) return unavailable('分享目录格式异常，暂时无法核验');
        for (const row of list) {
          if (!row || !fid(row.fid) || typeof row.file_name !== 'string' || !row.file_name.trim() || /[\u0000-\u001f\u007f]/.test(row.file_name)) { incomplete = true; continue; }
          if (seen.has(row.fid)) return unavailable('分享目录存在重复记录，暂时无法完整核验');
          seen.add(row.fid);
          if (isDirectory(row)) {
            if (folder.depth < 2) folders.push({ fid: row.fid, depth: folder.depth + 1, page: 1, count: 0 });
            else incomplete = true;
          } else if (isVideo(row)) {
            const size = Number(row.size);
            if (Number.isSafeInteger(size) && size > 0) return { status: 'valid' };
            incomplete = true;
          }
        }
        const rawTotal = result.metadata?._total, total = rawTotal === undefined ? undefined : Number(rawTotal), count = folder.count + list.length;
        if (total !== undefined && (!(typeof rawTotal === 'number' || typeof rawTotal === 'string' && /^\d+$/.test(rawTotal)) || !Number.isSafeInteger(total) || total < count || folder.total !== undefined && folder.total !== total || !list.length && total > count)) return unavailable('分享目录分页数量异常，暂时无法完整核验');
        if (folder.total !== undefined && total === undefined || total === undefined && list.length === 100) return unavailable('分享目录分页信息不完整，暂时无法确认视频');
        if (total !== undefined && total > count) folders.push({ ...folder, page: folder.page + 1, count, total });
      }
      return folders.length || incomplete ? unavailable('分享目录超出本次检查范围，暂时无法确认视频') : { status: 'empty', reason: '分享目录为空或没有视频文件' };
    } catch (cause) {
      if (signal.aborted) return unavailable(signal.reason?.message || '分享校验已取消');
      const status = cause?.quarkUpstreamStatus || cause?.status;
      return unavailable(status === 429 ? '夸克请求过于频繁（429），暂时无法核验，请稍后重试'
        : status === 403 ? '夸克暂时拒绝访问（403），无法核验分享'
          : status === 401 ? '此分享需要登录后核验'
            : '分享暂时无法核验，可能已取消、需要提取码或受访问限制');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  function pump() {
    while (!stopped && active.size < 2 && queue.length) {
      const work = queue.shift(); clearTimeout(work.queueTimer);
      if (work.queuedUntil <= now()) { finish(work, unavailable('分享校验排队超过30秒，请稍后重试')); continue; }
      active.add(work);
      work.job = scan(work).then(result => finish(work, result)).finally(() => { active.delete(work); pump(); });
    }
  }

  function remember(key, work) {
    cache.delete(key);
    for (const [savedKey, saved] of cache) if (!saved.entry.pending && (saved.expires <= now() || cache.size >= 128)) cache.delete(savedKey);
    cache.set(key, work);
  }

  function inspect(resource, { force = false } = {}) {
    if (stopped) return { ...unavailable('分享校验服务已停止'), pending: false };
    const parsed = identity(resource);
    if (!parsed) return { ...unavailable('夸克分享地址或提取码无效'), pending: false };
    const { pwdId, password, key } = parsed, previous = cache.get(key);
    if (previous?.entry.pending || previous?.expires > now() && !force) return previous.entry;
    const entry = { status: previous?.entry.status === 'valid' && previous.expires > now() ? 'valid' : 'checking', pending: true };
    const work = { entry, pwdId, password, expires: Infinity, controller: new AbortController(), queuedUntil: now() + 30_000 };
    remember(key, work);
    if (active.size >= 2 && queue.length >= 64) { finish(work, unavailable('分享校验繁忙，请稍后重试')); return entry; }
    entry.promise = new Promise(resolve => { work.resolve = resolve; });
    work.queueTimer = setTimeout(() => {
      const index = queue.indexOf(work);
      if (index >= 0) { queue.splice(index, 1); finish(work, unavailable('分享校验排队超过30秒，请稍后重试')); }
    }, 30_000);
    queue.push(work); pump();
    return entry;
  }

  function clear() {
    for (const work of queue.splice(0)) { clearTimeout(work.queueTimer); work.controller.abort(new Error('分享校验已取消')); finish(work, unavailable('分享校验已取消')); }
    for (const work of active) work.controller.abort(new Error('分享校验已取消'));
    cache.clear();
  }

  function stop() {
    if (!stopPromise) {
      stopped = true; clear();
      stopPromise = Promise.allSettled([...active].map(work => work.job)).then(() => {});
    }
    return stopPromise;
  }

  function invalidate(resource) {
    const parsed = identity(resource);
    if (!parsed || stopped) return { ...unavailable(stopped ? '分享校验服务已停止' : '夸克分享地址或提取码无效'), pending: false };
    let work = cache.get(parsed.key);
    if (!work) { work = { entry: {} }; remember(parsed.key, work); }
    work.controller?.abort(new Error('分享读取失败，暂时无法核验，请稍后重试'));
    const index = queue.indexOf(work);
    if (index >= 0) { queue.splice(index, 1); clearTimeout(work.queueTimer); }
    finish(work, unavailable('分享读取失败，暂时无法核验，请稍后重试'));
    return work.entry;
  }

  return { inspect, invalidate, clear, stop };
}

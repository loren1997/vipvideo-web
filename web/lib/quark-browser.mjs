import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { request, readText, validateUrl } from './network.mjs';

let renderQueue = Promise.resolve();
const failure = (message, reason, status = 502, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { status, quarkPoolReason: reason });
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const verificationUrl = url => /(?:^|\.)google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/i.test(url.hostname) && /^\/sorry(?:\/|$)/.test(url.pathname);

export function createQuarkBrowser({ safeRequest = request, executablePath = process.env.CHROMIUM_PATH, launch = options => chromium.launch(options) } = {}) {
  let closed = false;
  const jobs = new Set();

  async function render(value, { deadline = Date.now() + 25000, signal } = {}) {
    const url = validateUrl(value).href;
    if (closed) throw failure('网页渲染器已关闭', 'browserUnavailable', 503);
    const controller = new AbortController(), end = Math.min(Number.isFinite(deadline) ? deadline : Infinity, Date.now() + 25000);
    const remaining = () => Math.max(1, end - Date.now());
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (end <= Date.now()) controller.abort(failure('动态网页读取超时', 'browserTimeout'));
    const timer = setTimeout(() => controller.abort(failure('动态网页读取超时', 'browserTimeout')), remaining());
    const stopped = controller.signal.aborted ? Promise.resolve() : new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    jobs.add(controller);
    let started = false;

    async function run() {
      controller.signal.throwIfAborted();
      let browser, launching;
      try {
        const operation = (async () => {
          const path = executablePath || ['/usr/bin/chromium', chromium.executablePath()].find(candidate => existsSync(candidate));
          if (!path) throw failure('未安装动态网页浏览器', 'browserUnavailable', 503);
          launching = launch({ executablePath: path, headless: true, timeout: remaining(), args: [
            '--mute-audio', '--noerrdialogs', '--disable-gpu', '--disable-dev-shm-usage', '--disable-quic',
            '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=WebTransport,WebUSB,WebBluetooth',
            '--js-flags=--max-old-space-size=128',
          ] });
          try { browser = await launching; }
          catch (cause) {
            controller.signal.throwIfAborted();
            if (cause?.name === 'TimeoutError' || Date.now() >= end) throw failure('动态网页读取超时', 'browserTimeout', 502, cause);
            throw failure('动态网页浏览器无法启动', 'browserUnavailable', 503, cause);
          }
          controller.signal.throwIfAborted();
          const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
          const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [], viewport: { width: 1280, height: 900 }, locale: 'zh-CN', userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36` });
          await context.addInitScript(() => {
            for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocket', 'WebTransport']) Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
            Object.defineProperty(globalThis, 'open', { value: () => null, configurable: false, writable: false });
          });
          await context.routeWebSocket('**', socket => socket.close());
          const page = await context.newPage();
          context.on('page', popup => { if (popup !== page) popup.close().catch(error => { if (!controller.signal.aborted) controller.abort(error); }); });
          page.on('dialog', dialog => dialog.dismiss().catch(error => { if (!controller.signal.aborted) controller.abort(error); }));
          const lanes = Array.from({ length: 4 }, () => Promise.resolve());
          let requests = 0, documents = 0, bytes = 0, mainError, mainRedirect;
          await context.route('**/*', async route => {
            const incoming = route.request(), index = requests++ % lanes.length;
            const task = lanes[index].then(async () => {
              try {
                controller.signal.throwIfAborted();
                if (requests > 80) {
                  const error = failure('动态网页请求过多', 'browserFailed');
                  controller.abort(error);
                  throw error;
                }
                if (incoming.isNavigationRequest() && incoming.frame() !== page.mainFrame()) return await route.abort('blockedbyclient');
                if (incoming.isNavigationRequest() && ++documents > 6) throw failure('动态网页反复跳转，需要网站验证', 'browserBlocked');
                if (!['GET', 'HEAD'].includes(incoming.method()) || !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(incoming.resourceType())) return await route.abort('blockedbyclient');
                const target = validateUrl(incoming.url());
                if (incoming.isNavigationRequest() && verificationUrl(target)) throw failure('搜索网站要求验证码', 'browserBlocked');
                // This new context contains only temporary cookies created by the public site itself.
                const headers = Object.fromEntries(Object.entries(await incoming.allHeaders()).filter(([key]) => ['accept', 'accept-language', 'user-agent', 'origin', 'referer', 'cookie'].includes(key.toLowerCase())));
                // shortcut: redirected scripts/fetches keep their initial browser URL; revisit if relative imports depend on the final URL.
                const response = await safeRequest(target.href, { method: incoming.method(), headers, signal: controller.signal, timeout: Math.min(8000, remaining()) });
                if (incoming.isNavigationRequest() && response.finalUrl && verificationUrl(validateUrl(response.finalUrl))) {
                  response.destroy();
                  throw failure('搜索网站要求验证码', 'browserBlocked');
                }
                const status = response.statusCode || 200;
                if (incoming.isNavigationRequest() && incoming.frame() === page.mainFrame() && status >= 400) {
                  response.destroy();
                  throw failure(`动态网页返回 HTTP ${status}`, status === 403 || status === 429 ? 'browserBlocked' : 'browserFailed');
                }
                if (response.finalUrl && response.finalUrl !== target.href && incoming.isNavigationRequest() && incoming.frame() === page.mainFrame()) {
                  mainRedirect = validateUrl(response.finalUrl).href;
                  response.destroy();
                  return await route.abort('aborted');
                }
                const body = await readText(response, 2 * 1024 * 1024);
                if (incoming.isNavigationRequest() && /g-recaptcha|h-captcha|cf-chl-|our systems have detected|unusual traffic|<title[^>]*>[^<]*(?:验证码|安全验证|登录|sign\s?in|log\s?in)/i.test(body)) throw failure('公开网页需要登录或安全验证', 'browserBlocked');
                bytes += Buffer.byteLength(body);
                if (bytes > 16 * 1024 * 1024) {
                  const error = failure('动态网页响应过大', 'browserFailed');
                  controller.abort(error);
                  throw error;
                }
                const responseHeaders = Object.fromEntries(Object.entries(response.headers || {}).filter(([key, value]) => (typeof value === 'string' || key.toLowerCase() === 'set-cookie' && Array.isArray(value)) && !['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'alt-svc', 'report-to', 'nel'].includes(key.toLowerCase())).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : value]));
                await route.fulfill({ status, headers: { ...responseHeaders, 'cache-control': 'no-store' }, body });
              } catch (cause) {
                if (incoming.isNavigationRequest() && incoming.frame() === page.mainFrame()) { mainError = cause; controller.abort(cause); }
                try { await route.abort('blockedbyclient'); }
                catch (error) { if (!controller.signal.aborted && !page.isClosed()) controller.abort(error); }
              }
            });
            lanes[index] = task;
            await task;
          });
          try {
            const navigate = async target => {
              for (let redirect = 0; redirect <= 3; redirect++) {
                mainRedirect = undefined;
                mainError = undefined;
                try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: remaining() }); return; }
                catch (cause) {
                  if (!mainRedirect || mainError) throw cause;
                  if (redirect === 3) throw failure('动态网页重定向次数过多', 'browserFailed');
                  target = mainRedirect;
                }
              }
            };
            // Playwright does not route browser-followed redirects, so start a fresh routed navigation.
            await navigate(url);
            await page.waitForTimeout(Math.min(1000, remaining()));
            try { await page.waitForLoadState('networkidle', { timeout: Math.min(4000, remaining()) }); }
            catch (cause) { if (cause.name !== 'TimeoutError') throw cause; }
            if (mainRedirect) await navigate(mainRedirect);
            controller.signal.throwIfAborted();
            const snapshot = await page.evaluate(() => {
              const visible = element => {
                const style = getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0' && !element.hidden;
              };
              const root = document.body?.cloneNode(true);
              if (!root) return { title: document.title, text: '', body: '', metadata: '', links: [] };
              const originals = [...document.body.querySelectorAll('*')], clones = [...root.querySelectorAll('*')];
              for (let index = 0; index < originals.length; index++) {
                const original = originals[index], clone = clones[index];
                if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'IFRAME', 'EMBED', 'AUDIO', 'VIDEO'].includes(original.tagName.toUpperCase()) || !visible(original)) { clone.remove(); continue; }
                for (const attribute of [...clone.attributes]) if (!['class', 'id', 'href', 'datetime'].includes(attribute.name)) clone.removeAttribute(attribute.name);
                if (original.tagName === 'A') {
                  if (/^https?:/.test(original.href)) clone.setAttribute('href', original.href);
                  else clone.removeAttribute('href');
                }
              }
              const metadata = [...document.head.querySelectorAll('meta[property="og:title"],meta[property="article:published_time"],meta[itemprop="datePublished"],script[type="application/ld+json"]')].slice(0, 20).map(element => element.outerHTML).join('').slice(0, 32768);
              const links = [...root.querySelectorAll('a[href]')].slice(0, 300).map(anchor => ({ url: anchor.href, text: anchor.textContent.trim().slice(0, 1000) }));
              const mainText = document.querySelector('main,article')?.innerText.trim() || '';
              return { title: document.title.slice(0, 1000), text: document.body.innerText.slice(0, 120000), body: root.innerHTML, metadata, links, failed: /^(?:加载失败|页面加载失败|网络异常|network error|failed to load)(?:\s|$)/i.test(mainText) };
            });
            if (snapshot.failed) throw failure('公开网页加载失败', 'browserFailed');
            const html = `<!doctype html><html><head><title>${escape(snapshot.title)}</title>${snapshot.metadata}</head><body>${snapshot.body}</body></html>`;
            if (Buffer.byteLength(html) > 512 * 1024) throw failure('动态网页正文过大', 'browserFailed');
            return { url: validateUrl(page.url()).href, html, title: snapshot.title, text: snapshot.text, links: snapshot.links };
          } catch (cause) {
            if (mainError) throw mainError;
            if (controller.signal.aborted) throw controller.signal.reason;
            throw cause.quarkPoolReason ? cause : failure('无法读取动态网页', 'browserFailed', 502, cause);
          }
        })();
        return await Promise.race([operation, stopped.then(() => { throw controller.signal.reason; })]);
      } finally {
        if (!controller.signal.aborted) controller.abort(failure('网页渲染已结束', 'browserFinished'));
        // A cancelled launch still owns its child process until Playwright settles it.
        if (!browser && launching) browser = await launching.catch(() => null);
        await browser?.close();
      }
    }

    const queued = renderQueue.then(() => { started = true; return run(); });
    renderQueue = queued.catch(() => {});
    try {
      return await Promise.race([queued, stopped.then(() => started ? queued : Promise.reject(controller.signal.reason))]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      jobs.delete(controller);
    }
  }

  return {
    render,
    async close() {
      closed = true;
      for (const controller of jobs) controller.abort(failure('网页渲染器已关闭', 'browserUnavailable', 503));
      await renderQueue;
    },
  };
}

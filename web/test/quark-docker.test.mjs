import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { createQuarkSearchPool } from '../lib/quark-search-pool.mjs';
import { readText } from '../lib/network.mjs';

test('optional Quark search companion preserves Compose settings and accepts real search responses', {
  skip: process.env.GITHUB_ACTIONS !== 'true', timeout: 180_000,
}, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const name = `vipvideo-quark-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.pid}`;
  const files = ['-f', 'docker-compose.yml', '-f', 'compose.quark.yaml'];
  const compose = args => execFileSync('docker', ['compose', '-p', name, ...files, ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseline = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '--format', 'json'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const config = JSON.parse(compose(['config', '--format', 'json']));
  assert.equal(config.services.web.environment.APP_PASSWORD, baseline.services.web.environment.APP_PASSWORD);
  assert.deepEqual(config.services.web.ports, baseline.services.web.ports);
  assert.deepEqual(config.services.web.volumes, baseline.services.web.volumes);
  assert.equal(config.services.web.environment.QUARK_SEARCH_API, 'http://pansou:8888/api/search');
  assert.equal(config.services.pansou.ports?.length || 0, 0);
  assert.equal(config.services.pansou.read_only, true);
  assert.equal(config.services.pansou.volumes?.some(row => row.target === '/app/data') || false, false);
  assert.equal(config.services.pansou.cpus, 0.25);
  assert.equal(Number(config.services.pansou.mem_limit), 384 * 1024 * 1024);
  assert.equal(Number(config.services.pansou.memswap_limit), Number(config.services.pansou.mem_limit));
  assert.equal(config.services.pansou.environment.GOMAXPROCS, '1');
  assert.equal(config.services.pansou.environment.ASYNC_MAX_BACKGROUND_WORKERS, '1');
  assert.equal(config.services.web.cpus, 1);
  assert.equal(Number(config.services.web.mem_limit), 768 * 1024 * 1024);
  assert.equal(Number(config.services.web.memswap_limit), Number(config.services.web.mem_limit));
  const protectedBase = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'compose.plex-safe.yaml', 'config', '--format', 'json'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.deepEqual(Object.keys(protectedBase.services), Object.keys(baseline.services));
  assert.equal(protectedBase.services.web.environment.APP_PASSWORD, baseline.services.web.environment.APP_PASSWORD);
  assert.deepEqual(protectedBase.services.web.ports, baseline.services.web.ports);
  assert.deepEqual(protectedBase.services.web.volumes, baseline.services.web.volumes);
  assert.equal(protectedBase.services.web.environment.TRANSCODE_ALLOW_SOFTWARE, 'false');
  assert.equal(protectedBase.services.web.environment.BACKGROUND_MODE, 'low');
  assert.equal(protectedBase.services.web.devices?.length || 0, baseline.services.web.devices?.length || 0);
  const combined = JSON.parse(execFileSync('docker', ['compose', ...files, '-f', 'compose.gpu.yaml', '-f', 'compose.plex-safe.yaml', 'config', '--format', 'json'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RENDER_GID: '109' },
  }));
  assert.equal(combined.services.web.environment.APP_PASSWORD, baseline.services.web.environment.APP_PASSWORD);
  assert.deepEqual(combined.services.web.ports, baseline.services.web.ports);
  assert.deepEqual(combined.services.web.volumes, baseline.services.web.volumes);
  assert.equal(combined.services.web.environment.QUARK_SEARCH_API, 'http://pansou:8888/api/search');
  assert.equal(combined.services.web.environment.TRANSCODE_ACCEL, 'vaapi');
  assert.equal(combined.services.web.environment.TRANSCODE_ALLOW_SOFTWARE, 'false');
  assert.equal(combined.services.web.environment.BACKGROUND_MODE, 'low');
  assert.ok(combined.services.web.devices.some(device => device.source === '/dev/dri' && device.target === '/dev/dri'));
  assert.ok(combined.services.web.group_add.includes('109'));
  assert.equal(combined.services.web.cpus, 1);
  assert.equal(combined.services.web.cpu_shares, 256);
  assert.equal(Number(combined.services.web.mem_limit), 768 * 1024 * 1024);
  assert.equal(Number(combined.services.web.memswap_limit), Number(combined.services.web.mem_limit));
  assert.equal(combined.services.web.pids_limit, 128);
  assert.equal(combined.services.web.pull_policy, 'always');
  assert.equal(combined.services.web.blkio_config.weight, 100);
  assert.deepEqual(combined.services.web.tmpfs, ['/tmp:size=128m,mode=1777']);
  const nasYaml = readFileSync(join(root, 'docker-compose.nas.yml'), 'utf8');
  assert.doesNotMatch(nasYaml, /\$\{/);
  assert.equal(nasYaml.match(/填写_RENDER_GID/g)?.length, 1);
  const nasFile = join(tmpdir(), `${name}-nas.yml`);
  writeFileSync(nasFile, nasYaml.replace('填写_RENDER_GID', '109'), { flag: 'wx' });
  try {
    const nas = JSON.parse(execFileSync('docker', ['compose', '--project-directory', root, '-f', nasFile, 'config', '--format', 'json'], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    assert.equal(nas.name, 'vipvideo-web');
    assert.deepEqual(nas, combined, 'Single-file NAS settings must preserve the complete four-file configuration');
  } finally {
    unlinkSync(nasFile);
  }
  try {
    compose(['up', '-d', 'pansou']);
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      const id = compose(['ps', '-q', 'pansou']).trim();
      if (id && execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', id], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
      }).trim() === 'healthy') { healthy = true; break; }
      await wait(2000);
    }
    assert.ok(healthy, 'Optional PanSou companion must become healthy');
    const health = JSON.parse(compose(['exec', '-T', 'pansou', 'wget', '-qO-', 'http://127.0.0.1:8888/api/health']));
    assert.ok(health.status || health.success || health.code !== undefined);
    // A nonexistent plugin checks the real search contract without contacting upstream resources.
    const body = compose(['exec', '-T', 'pansou', 'wget', '-qO-',
      'http://127.0.0.1:8888/api/search?kw=vipvideo-protocol-selfcheck&src=plugin&plugins=vipvideo_no_such_plugin_90d5&res=results&cloud_types=quark&conc=1']);
    const wire = JSON.parse(body);
    assert.equal(wire.code, 0);
    assert.equal(wire.data.total, 0);
    assert.equal(wire.data.results, undefined, 'Pinned PanSou omits empty results');
    const metadata = new Map(); let primaryCalls = 0;
    const pool = createQuarkSearchPool({
      store: { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) },
      googleSearch: async () => [],
      request: async url => {
        const primary = new URL(url).hostname === 'pansou';
        if (primary) primaryCalls++;
        return Object.assign(Readable.from([primary ? body : '<rss><channel></channel></rss>']), { statusCode: 200, headers: {} });
      },
    });
    try {
      for (const title of ['协议验收甲', '协议验收乙']) {
        const url = new URL('http://pansou:8888/api/search'); url.searchParams.set('kw', title);
        const parsed = JSON.parse(await readText(await pool.request(url.href)));
        assert.deepEqual(parsed.results, []);
        assert.doesNotMatch(parsed.reason || '', /格式|暂停|不可用/);
      }
      assert.equal(primaryCalls, 2, 'A valid empty response must keep the primary available for another title');
    } finally { await pool.stop(); }
  } catch (error) {
    const log = spawnSync('docker', ['compose', '-p', name, ...files, 'logs', '--no-color', 'pansou'], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000,
    });
    if (log.stdout) process.stderr.write(log.stdout);
    if (log.stderr) process.stderr.write(log.stderr);
    throw error;
  } finally {
    const stopped = spawnSync('docker', ['compose', '-p', name, ...files, 'down', '--volumes', '--remove-orphans'], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    });
    if (stopped.stderr) process.stderr.write(stopped.stderr);
    assert.equal(stopped.status, 0, 'Optional companion cleanup failed');
  }
});

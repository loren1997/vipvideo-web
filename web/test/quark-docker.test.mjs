import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

test('optional Quark search companion preserves Compose settings and becomes healthy', {
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

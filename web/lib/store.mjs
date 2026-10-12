import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createStore(directory, defaults) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'app.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (
      kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY(kind, key)
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  `);
  const getMeta = db.prepare('SELECT value FROM meta WHERE key=?');
  const setMeta = db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  if (!getMeta.get('config')) setMeta.run('config', JSON.stringify(defaults));
  return {
    meta(key) { return getMeta.get(key)?.value; },
    setMeta(key, value) { setMeta.run(key, value); },
    config() { return JSON.parse(getMeta.get('config').value); },
    setConfig(value) { setMeta.run('config', JSON.stringify(value)); return value; },
    list(kind) {
      return db.prepare('SELECT data,updated FROM entries WHERE kind=? ORDER BY updated DESC,rowid DESC').all(kind)
        .map(({ data, updated }) => ({ ...JSON.parse(data), updated }));
    },
    save(kind, row) {
      const updated = Date.now();
      db.prepare('INSERT INTO entries VALUES (?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET data=excluded.data,updated=excluded.updated')
        .run(kind, row.key, JSON.stringify(row), updated);
      if (kind === 'history') db.prepare(`DELETE FROM entries WHERE kind='history' AND key NOT IN
        (SELECT key FROM entries WHERE kind='history' ORDER BY updated DESC,rowid DESC LIMIT 200)`).run();
      return { ...row, updated };
    },
    remove(kind, key) {
      if (key === null) db.prepare('DELETE FROM entries WHERE kind=?').run(kind);
      else db.prepare('DELETE FROM entries WHERE kind=? AND key=?').run(kind, key);
    },
    session(token, expires) {
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      db.prepare('INSERT INTO sessions VALUES (?,?)').run(token, expires);
    },
    authenticated(token) { return !!db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(token, Date.now()); },
    logout(token) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); },
    clearSessions() { db.exec('DELETE FROM sessions'); },
    close() { db.close(); },
  };
}

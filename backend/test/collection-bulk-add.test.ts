import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Bulk loading is what turns "play folder" from one request per track into a single request, so
 * these cover the parts that would otherwise be silent data corruption: ordering, replace mode,
 * copying from another collection, and what happens when an id no longer exists.
 */

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'bulk-db-')), 'test.db');

const { initDatabase, closeDatabase, getDb } = await import('../src/db/database.js');
const cq = await import('../src/db/collectionQueries.js');

let db;
const now = () => Math.floor(Date.now() / 1000);

function makeCollection(id, type = 'folder', trackIds = []) {
  db.prepare(`
    INSERT OR REPLACE INTO track_collections (id, name, type, parent_id, sort_order, is_ordered, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 0, 1, ?, ?)
  `).run(id, id, type, now(), now());
  db.prepare('DELETE FROM collection_tracks WHERE collection_id = ?').run(id);
  const link = db.prepare('INSERT INTO collection_tracks (collection_id, track_id, position, added_at) VALUES (?,?,?,?)');
  trackIds.forEach((trackId, i) => link.run(id, trackId, i, now()));
}

beforeAll(async () => {
  await initDatabase();
  db = getDb();
  const ts = now();
  const insert = db.prepare(`
    INSERT INTO tracks (id, filepath, filename, title, artist, album, duration, format, bitrate,
                        sample_rate, file_size, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'A', 'B', 200, 'M4A', 192, 44100, 1000, ?, ?)
  `);
  db.transaction(() => {
    for (let i = 0; i < 8; i++) insert.run(`t${i}`, `/music/t${i}.m4a`, `t${i}.m4a`, `Track ${i}`, ts, ts);
  })();
});

afterAll(() => closeDatabase());

beforeEach(() => {
  makeCollection('target', 'playlist', []);
  makeCollection('source', 'folder', ['t3', 't1', 't7']);
});

describe('addTracks', () => {
  it('appends in the given order after what is already there', () => {
    cq.addTracks(db, 'target', ['t0', 't2']);
    const second = cq.addTracks(db, 'target', ['t4']);
    expect(second.tracks.map((t) => t.id)).toEqual(['t0', 't2', 't4']);
    expect(second.tracks.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(second.added).toBe(1);
  });

  it('replaces the collection atomically when asked', () => {
    cq.addTracks(db, 'target', ['t0', 't1', 't2']);
    const replaced = cq.addTracks(db, 'target', ['t5'], { mode: 'replace' });
    expect(replaced.tracks.map((t) => t.id)).toEqual(['t5']);
    expect(replaced.tracks[0].position).toBe(0);
  });

  it('copies another collection and keeps its ordering without a client round trip', () => {
    const copied = cq.addTracks(db, 'target', [], { sourceCollectionId: 'source' });
    expect(copied.tracks.map((t) => t.id)).toEqual(['t3', 't1', 't7']);
    expect(copied.added).toBe(3);
  });

  it('appends a copied collection behind existing entries', () => {
    cq.addTracks(db, 'target', ['t6']);
    const copied = cq.addTracks(db, 'target', [], { sourceCollectionId: 'source' });
    expect(copied.tracks.map((t) => t.id)).toEqual(['t6', 't3', 't1', 't7']);
  });

  it('skips ids that are not in the library instead of failing the batch', () => {
    const result = cq.addTracks(db, 'target', ['t0', 'ghost', 't1']);
    expect(result.tracks.map((t) => t.id)).toEqual(['t0', 't1']);
    expect(result.added).toBe(2);
    expect(result.skipped).toEqual(['ghost']);
  });

  it('allows the same track more than once, like the per-track endpoint does', () => {
    const result = cq.addTracks(db, 'target', ['t0', 't0', 't0']);
    expect(result.tracks).toHaveLength(3);
    expect(result.tracks.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it('reports an empty append honestly', () => {
    const result = cq.addTracks(db, 'target', []);
    expect(result.added).toBe(0);
    expect(result.tracks).toHaveLength(0);
  });

  it('bumps the collection timestamp', () => {
    db.prepare('UPDATE track_collections SET updated_at = 1 WHERE id = ?').run('target');
    cq.addTracks(db, 'target', ['t0']);
    expect(db.prepare('SELECT updated_at FROM track_collections WHERE id = ?').get('target').updated_at).toBeGreaterThan(1);
  });
});

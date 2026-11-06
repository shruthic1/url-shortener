import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import pg from 'pg';
import { setupTestDb, quietApp, BASE_URL } from './helpers.js';

let pool;
let app;

before(async () => {
  pool = await setupTestDb();
  app = quietApp(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE links');
});

after(async () => {
  await pool.end();
});

describe('GET /', () => {
  test('serves the frontend page', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /URL Shortener/);
  });
});

describe('POST /api/shorten', () => {
  test('creates a short link for a valid URL', async () => {
    const res = await request(app).post('/api/shorten').send({ url: 'https://example.com/page' });
    assert.equal(res.status, 201);
    assert.match(res.body.code, /^[A-Za-z0-9]{7}$/);
    assert.equal(res.body.short_url, `${BASE_URL}/${res.body.code}`);
    assert.equal(res.body.long_url, 'https://example.com/page');

    const { rows } = await pool.query('SELECT long_url, used_count FROM links WHERE short_code = $1', [res.body.code]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].long_url, 'https://example.com/page');
    assert.equal(rows[0].used_count, 0);
  });

  test('shortening the same URL twice creates two codes', async () => {
    const a = await request(app).post('/api/shorten').send({ url: 'https://example.com/same' });
    const b = await request(app).post('/api/shorten').send({ url: 'https://example.com/same' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.code, b.body.code);
  });

  test('rejects a missing url', async () => {
    const res = await request(app).post('/api/shorten').send({});
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test('rejects a non-http protocol', async () => {
    const res = await request(app).post('/api/shorten').send({ url: 'ftp://example.com/file' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /http/);
  });

  test('rejects javascript: URLs', async () => {
    const res = await request(app).post('/api/shorten').send({ url: 'javascript:alert(1)' });
    assert.equal(res.status, 400);
  });

  test('rejects something that is not a URL', async () => {
    const res = await request(app).post('/api/shorten').send({ url: 'not a url' });
    assert.equal(res.status, 400);
  });

  test('rejects URLs longer than 2048 characters', async () => {
    const url = 'https://example.com/' + 'a'.repeat(2048);
    const res = await request(app).post('/api/shorten').send({ url });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /2048/);
  });

  test('rejects a link back to the app itself', async () => {
    const res = await request(app).post('/api/shorten').send({ url: `${BASE_URL}/abc1234` });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /this service/);
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/api/shorten')
      .set('Content-Type', 'application/json')
      .send('{"url": ');
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });
});

describe('GET /:code', () => {
  test('redirects and increments the click count', async () => {
    const created = await request(app).post('/api/shorten').send({ url: 'https://example.com/target' });
    const { code } = created.body;

    const first = await request(app).get(`/${code}`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'https://example.com/target');

    const second = await request(app).get(`/${code}`);
    assert.equal(second.status, 302);

    const { rows } = await pool.query('SELECT used_count FROM links WHERE short_code = $1', [code]);
    assert.equal(rows[0].used_count, 2);
  });

  test('returns 404 for an unknown but well-formed code', async () => {
    const res = await request(app).get('/zzzzzzz');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  test('returns 404 for a malformed code without touching the database', async () => {
    for (const bad of ['/abc', '/abcdefgh', '/abc-123', '/abc_1234']) {
      const res = await request(app).get(bad);
      assert.equal(res.status, 404, `expected 404 for ${bad}`);
    }
  });

  test('returns 404 for unknown API paths', async () => {
    const res = await request(app).get('/api/nope');
    assert.equal(res.status, 404);
  });
});

describe('GET /api/links', () => {
  test('returns an empty list when there are no links', async () => {
    const res = await request(app).get('/api/links');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('returns the 10 most recent links, newest first, with click counts', async () => {
    // Insert 12 rows with distinct timestamps so ordering is deterministic.
    for (let i = 0; i < 12; i++) {
      await pool.query(
        "INSERT INTO links (short_code, long_url, used_count, created_at) VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)",
        [`code${String(i).padStart(3, '0')}`, `https://example.com/${i}`, i, i]
      );
    }

    const res = await request(app).get('/api/links');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 10);
    assert.equal(res.body[0].code, 'code011');
    assert.equal(res.body[9].code, 'code002');

    const first = res.body[0];
    assert.deepEqual(Object.keys(first).sort(), ['code', 'created_at', 'long_url', 'short_url', 'used_count']);
    assert.equal(first.short_url, `${BASE_URL}/code011`);
    assert.equal(first.long_url, 'https://example.com/11');
    assert.equal(first.used_count, 11);
    assert.ok(!Number.isNaN(Date.parse(first.created_at)));
  });
});

describe('GET /health', () => {
  test('returns 200 when the database is reachable', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { app: 'ok', database: 'ok' });
  });

  test('returns 503 when the database is unreachable', async () => {
    // A pool pointed at a port nothing listens on; no mocks involved.
    const deadPool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'x', password: 'x', database: 'x', connectionTimeoutMillis: 1000 });
    const deadApp = quietApp(deadPool);
    try {
      const res = await request(deadApp).get('/health');
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { app: 'ok', database: 'error' });
    } finally {
      await deadPool.end();
    }
  });
});

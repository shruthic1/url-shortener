import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { generateCode, CODE_PATTERN } from './shortcode.js';
import { validateUrl } from './validate.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HEALTH_TIMEOUT_MS = 2000;
const MAX_INSERT_ATTEMPTS = 3;
const UNIQUE_VIOLATION = '23505';

// Builds the Express app without listening, so tests can drive it with supertest.
export function createApp({ pool, baseUrl, log = console.log, logError = console.error }) {
  if (!baseUrl) {
    throw new Error('BASE_URL is required');
  }
  const base = baseUrl.replace(/\/+$/, '');
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // One line per request: method, path, status, duration.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(PUBLIC_DIR));

  app.get('/health', async (req, res) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('health check timed out')), HEALTH_TIMEOUT_MS);
    });
    try {
      await Promise.race([pool.query('SELECT 1'), timeout]);
      res.json({ app: 'ok', database: 'ok' });
    } catch (err) {
      logError(`health check failed: ${err.message}`);
      res.status(503).json({ app: 'ok', database: 'error' });
    } finally {
      clearTimeout(timer);
    }
  });

  app.post('/api/shorten', async (req, res) => {
    const result = validateUrl(req.body?.url, base);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt++) {
      const code = generateCode();
      try {
        await pool.query('INSERT INTO links (short_code, long_url) VALUES ($1, $2)', [
          code,
          result.url,
        ]);
        return res.status(201).json({ code, short_url: `${base}/${code}`, long_url: result.url });
      } catch (err) {
        if (err.code !== UNIQUE_VIOLATION) {
          throw err;
        }
        logError(`short code collision on attempt ${attempt}, retrying`);
      }
    }
    return res.status(500).json({ error: 'Could not generate a unique short code' });
  });

  app.get('/api/links', async (req, res) => {
    const { rows } = await pool.query(
      'SELECT short_code, long_url, used_count, created_at FROM links ORDER BY created_at DESC LIMIT 10'
    );
    res.json(
      rows.map((row) => ({
        code: row.short_code,
        short_url: `${base}/${row.short_code}`,
        long_url: row.long_url,
        used_count: row.used_count,
        created_at: row.created_at,
      }))
    );
  });

  app.get('/:code', async (req, res, next) => {
    const { code } = req.params;
    if (!CODE_PATTERN.test(code)) {
      return next();
    }
    const { rows } = await pool.query(
      'UPDATE links SET used_count = used_count + 1 WHERE short_code = $1 RETURNING long_url',
      [code]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Short link not found' });
    }
    res.redirect(302, rows[0].long_url);
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Errors from any handler land here (Express 5 forwards rejected promises).
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Request body too large' });
    }
    logError(err.stack || err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

import { createApp } from './app.js';
import { createPool } from './db.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = process.env.BASE_URL;
const SHUTDOWN_GRACE_MS = 10000;

if (!BASE_URL) {
  console.error('BASE_URL is required');
  process.exit(1);
}

let pool;
try {
  pool = await createPool();
} catch (err) {
  console.error(`failed to configure database: ${err.message}`);
  process.exit(1);
}

const app = createApp({ pool, baseUrl: BASE_URL });

const server = app.listen(PORT, HOST, () => {
  console.log(`listening on http://${HOST}:${PORT} (base url ${BASE_URL})`);
});

server.on('error', (err) => {
  console.error(`server error: ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  // Stop accepting connections, finish in-flight requests, then close the pool.
  const forceExit = setTimeout(() => {
    console.error('shutdown timed out, exiting');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close(async (err) => {
    if (err) console.error(`error closing server: ${err.message}`);
    try {
      await pool.end();
    } catch (poolErr) {
      console.error(`error closing pool: ${poolErr.message}`);
    }
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Applies db/schema.sql using the same connection code (and password lookup) as the app.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from '../src/db.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql');

let pool;
try {
  pool = await createPool();
  const sql = readFileSync(schemaPath, 'utf8');
  console.log(`applying ${schemaPath} to database ${pool.options.database} on ${pool.options.host}`);
  await pool.query(sql);
  console.log('migration complete');
} catch (err) {
  console.error(`migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}

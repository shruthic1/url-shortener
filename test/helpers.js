import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';

export const BASE_URL = 'http://localhost:3000';
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql');

// Connects to the dedicated test database (never the dev one) and applies the schema.
export async function setupTestDb() {
  process.env.DB_NAME = process.env.TEST_DB_NAME || 'urlshortener_test';
  const pool = await createPool();
  await pool.query(readFileSync(schemaPath, 'utf8'));
  return pool;
}

export function quietApp(pool, baseUrl = BASE_URL) {
  return createApp({ pool, baseUrl, log: () => {}, logError: () => {} });
}

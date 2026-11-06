import { readFileSync } from 'node:fs';
import pg from 'pg';

// Password comes from SSM Parameter Store on EC2 (DB_PASSWORD_PARAM) or from
// the environment locally (DB_PASSWORD). Nothing else is accepted.
export async function resolvePassword() {
  const paramName = process.env.DB_PASSWORD_PARAM;
  if (paramName) {
    // Loaded lazily so local runs and tests never touch the AWS SDK.
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const client = new SSMClient({});
    const result = await client.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true })
    );
    const value = result.Parameter?.Value;
    if (!value) {
      throw new Error(`SSM parameter ${paramName} is empty or missing`);
    }
    return value;
  }
  if (process.env.DB_PASSWORD) {
    return process.env.DB_PASSWORD;
  }
  throw new Error('Database password not configured: set DB_PASSWORD_PARAM or DB_PASSWORD');
}

// When DB_SSL=true the server certificate is always verified against the CA bundle.
export function sslConfig() {
  if (process.env.DB_SSL !== 'true') {
    return false;
  }
  const caPath = process.env.DB_SSL_CA_PATH;
  if (!caPath) {
    throw new Error('DB_SSL=true requires DB_SSL_CA_PATH to point at the CA bundle');
  }
  return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') };
}

export async function createPool() {
  const password = await resolvePassword();
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'urlshortener',
    user: process.env.DB_USER || 'shortener',
    password,
    ssl: sslConfig(),
    max: 10,
    connectionTimeoutMillis: 5000,
  });
}

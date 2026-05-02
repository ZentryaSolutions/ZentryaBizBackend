/**
 * PostgreSQL via Supabase (or any Postgres). Set DATABASE_URL in backend/.env
 * or DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD.
 */
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function sslOption() {
  const url = process.env.DATABASE_URL || '';
  const host = process.env.DB_HOST || '';
  if (url.includes('supabase') || host.includes('supabase')) {
    return { rejectUnauthorized: false };
  }
  if (process.env.DB_SSL === 'true') {
    return { rejectUnauthorized: false };
  }
  return false;
}

function isLikelyRemotePostgres(connStr, host) {
  const c = connStr || '';
  const h = host || '';
  return (
    c.includes('supabase') ||
    c.includes('neon.tech') ||
    c.includes('amazonaws.com') ||
    /\.pooler\.supabase/i.test(c) ||
    h.includes('supabase')
  );
}

function buildPoolConfig() {
  const conn = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  const remote = isLikelyRemotePostgres(conn, process.env.DB_HOST || '');
  // Remote DBs: longer connect/idle timeouts so zb-simple-session survives cold pools & network jitter.
  const defaultIdleMs = remote ? 60000 : 10000;
  const defaultConnectMs = remote ? 30000 : 10000;
  const poolMax = Number(process.env.DB_POOL_MAX) || (remote ? 8 : 5);
  const idleTimeoutMillis =
    process.env.DB_IDLE_TIMEOUT_MS !== undefined
      ? Number(process.env.DB_IDLE_TIMEOUT_MS)
      : defaultIdleMs;
  const connectionTimeoutMillis =
    process.env.DB_CONNECTION_TIMEOUT_MS !== undefined
      ? Number(process.env.DB_CONNECTION_TIMEOUT_MS)
      : defaultConnectMs;
  if (conn) {
    return {
      connectionString: conn,
      ssl: conn.includes('supabase') ? { rejectUnauthorized: false } : sslOption(),
      max: poolMax,
      idleTimeoutMillis,
      connectionTimeoutMillis,
      keepAlive: true,
      // Do not aggressively tear down the pool on idle — avoids stale first query after idle.
      allowExitOnIdle: remote ? false : true,
    };
  }

  const password = (process.env.DB_PASSWORD || '').replace(/^["']|["']$/g, '');
  if (!password) {
    return null;
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password,
    ssl: sslOption(),
    max: poolMax,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    keepAlive: true,
    allowExitOnIdle: remote ? false : true,
  };
}

const poolConfig = buildPoolConfig();
const pool = poolConfig ? new Pool(poolConfig) : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle PostgreSQL client', err.message);
  });
}

const isDatabaseConfigured = () => !!pool;

function isRetriableDbError(error) {
  const code = String(error?.code || '').toLowerCase();
  const msg = String(error?.message || '').toLowerCase();
  const causeMsg = String(error?.cause?.message || '').toLowerCase();
  const combined = `${msg} ${causeMsg}`;
  return (
    [
      '53300', // too_many_connections
      '57p03', // cannot_connect_now
      '08000',
      '08001',
      '08003',
      '08004',
      '08006',
      '08007',
      '08p01',
      '57p01', // admin_shutdown
      'etimedout',
      'econnreset',
      'econnrefused',
    ].includes(code) ||
    combined.includes('max clients reached') ||
    combined.includes('emaxconnsession') ||
    combined.includes('connection terminated') ||
    combined.includes('terminated unexpectedly') ||
    combined.includes('connection timeout') ||
    combined.includes('client has encountered a connection error')
  );
}

const query = async (text, params, retries = 5) => {
  if (!pool) {
    const e = new Error(
      'Database not configured. Set DATABASE_URL or DB_* in backend/.env (see .env.example).'
    );
    e.code = 'DB_NOT_CONFIGURED';
    throw e;
  }
  const start = Date.now();
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      if (duration > 1000 || attempt > 1) {
        const preview = text.length > 100 ? `${text.substring(0, 100)}...` : text;
        console.log('Executed query', { text: preview, duration, rows: res.rowCount });
      }
      return res;
    } catch (error) {
      const retriable = isRetriableDbError(error);
      if (attempt === retries || !retriable) {
        console.error('Database query error (final):', error.message);
        throw error;
      }
      const backoff = Math.min(4000, 750 * attempt);
      console.warn(`⚠️ Retrying DB query (${attempt}/${retries}) due to transient error:`, error.message);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
};

const testConnection = async (maxRetries = 5, retryDelay = 2000) => {
  if (!pool) {
    console.warn('[db] No DATABASE_URL / DB_PASSWORD — running without database.');
    return false;
  }
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pool.query('SELECT NOW()');
      console.log('✅ Database connection verified');
      return true;
    } catch (error) {
      if (attempt === maxRetries) {
        console.error(`❌ Database connection failed after ${maxRetries} attempts:`, error.message);
        return false;
      }
      console.warn(
        `⚠️ Database attempt ${attempt}/${maxRetries} failed, retrying...`,
        error.message
      );
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
  return false;
};

const getClient = async () => {
  if (!pool) {
    const e = new Error('Database not configured');
    e.code = 'DB_NOT_CONFIGURED';
    throw e;
  }
  return pool.connect();
};

module.exports = {
  query,
  getClient,
  pool,
  testConnection,
  isDatabaseConfigured,
};

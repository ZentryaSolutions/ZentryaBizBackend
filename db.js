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

function buildPoolConfig() {
  const conn = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  if (conn) {
    return {
      connectionString: conn,
      ssl: conn.includes('supabase') ? { rejectUnauthorized: false } : sslOption(),
      max: Number(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
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
    max: Number(process.env.DB_POOL_MAX) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
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

const query = async (text, params, retries = 3) => {
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
      if (attempt === retries) {
        console.error('Database query error (final):', error.message);
        throw error;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
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

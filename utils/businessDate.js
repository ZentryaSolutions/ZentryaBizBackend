/**
 * Shop calendar date — must match between INSERT into sales.date and /reports/dashboard "today".
 * Supabase/Postgres CURRENT_DATE is often UTC; POS users expect local business day (e.g. Pakistan).
 * Set BUSINESS_TIMEZONE in backend .env (IANA name), e.g. Asia/Karachi, Asia/Dubai.
 */
const DEFAULT_TZ = process.env.BUSINESS_TIMEZONE || 'Asia/Karachi';
const defaultDb = require('../db');

/**
 * @param {import('pg').Pool | import('pg').PoolClient} [dbConn] — defaults to app pool
 * @returns {Promise<string>} YYYY-MM-DD in business timezone
 */
async function getBusinessTodayDateString(dbConn) {
  const db = dbConn || defaultDb;
  const { rows } = await db.query(
    `SELECT to_char((timezone($1, now()))::date, 'YYYY-MM-DD') AS d`,
    [DEFAULT_TZ]
  );
  return rows[0].d;
}

module.exports = { DEFAULT_TZ, getBusinessTodayDateString };

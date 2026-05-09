/**
 * Browsers/devices that have completed OTP for zb-simple-session (x-device-id).
 */

const db = require('../db');

let ready = null;

async function ensureTrustedDevicesTable() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.zb_trusted_devices (
        user_id INTEGER NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, device_id)
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_zb_trusted_devices_user_id ON public.zb_trusted_devices(user_id)`
    );
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

function normalizeDeviceId(deviceId) {
  const d = String(deviceId || '').trim();
  return d;
}

/**
 * Unknown / missing device id cannot be distinguished across browsers — require verification.
 */
function isUsableDeviceId(deviceId) {
  const d = normalizeDeviceId(deviceId);
  return Boolean(d && d !== 'unknown');
}

async function isDeviceTrusted(userId, deviceId) {
  if (!db.isDatabaseConfigured() || !userId) return false;
  if (!isUsableDeviceId(deviceId)) return false;
  await ensureTrustedDevicesTable();
  const r = await db.query(
    `SELECT 1 FROM public.zb_trusted_devices WHERE user_id = $1 AND device_id = $2 LIMIT 1`,
    [userId, normalizeDeviceId(deviceId)]
  );
  return Boolean(r.rows?.length);
}

async function addTrustedDevice(userId, deviceId) {
  if (!db.isDatabaseConfigured() || !userId || !isUsableDeviceId(deviceId)) return;
  await ensureTrustedDevicesTable();
  const d = normalizeDeviceId(deviceId);
  await db.query(
    `INSERT INTO public.zb_trusted_devices (user_id, device_id, last_seen_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen_at = NOW()`,
    [userId, d]
  );
}

module.exports = {
  ensureTrustedDevicesTable,
  isDeviceTrusted,
  addTrustedDevice,
  isUsableDeviceId,
  normalizeDeviceId,
};

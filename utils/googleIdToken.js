/**
 * Verify Google Identity Services (GIS) credential JWT.
 * Set GOOGLE_OAUTH_CLIENT_ID (same Web client ID as REACT_APP_GOOGLE_CLIENT_ID on frontend).
 */

function getGoogleClientId() {
  return String(process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.REACT_APP_GOOGLE_CLIENT_ID || '').trim();
}

/**
 * @param {string} idToken
 * @returns {Promise<{ sub: string, email: string, emailVerified: boolean, name: string }>}
 */
async function verifyGoogleIdToken(idToken) {
  const clientId = getGoogleClientId();
  if (!clientId) {
    const err = new Error('Google sign-in is not configured on the server (GOOGLE_OAUTH_CLIENT_ID).');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }

  const token = String(idToken || '').trim();
  if (!token) {
    const err = new Error('Google credential missing');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.error) {
    const err = new Error(data.error_description || data.error || 'Invalid Google token');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  if (data.aud !== clientId) {
    const err = new Error('Google token audience mismatch');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const email = String(data.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    const err = new Error('Google account has no email');
    err.code = 'NO_EMAIL';
    throw err;
  }

  const verified = data.email_verified === true || data.email_verified === 'true';
  if (!verified) {
    const err = new Error('Google email is not verified');
    err.code = 'EMAIL_NOT_VERIFIED';
    throw err;
  }

  return {
    sub: String(data.sub || ''),
    email,
    emailVerified: verified,
    name: String(data.name || email.split('@')[0] || 'User').trim(),
  };
}

module.exports = { verifyGoogleIdToken, getGoogleClientId };

/**
 * Send mail via Microsoft Graph (client credentials). No Supabase email.
 * Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, MS_GRAPH_MAILBOX.
 */

const axios = require('axios');

let cached = { token: null, expiresAt: 0 };

function isConfigured() {
  return Boolean(
    process.env.MS_GRAPH_TENANT_ID &&
      process.env.MS_GRAPH_CLIENT_ID &&
      process.env.MS_GRAPH_CLIENT_SECRET &&
      process.env.MS_GRAPH_MAILBOX
  );
}

async function getAccessToken() {
  const tenant = process.env.MS_GRAPH_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET;
  const now = Date.now();
  if (cached.token && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const { data, status } = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000,
    validateStatus: () => true,
  });

  if (status < 200 || status >= 300 || !data?.access_token) {
    const msg = typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error(`Microsoft token request failed (${status}): ${msg}`);
  }

  cached = {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
  };
  return cached.token;
}

/**
 * @param {{ to: string, subject: string, text: string, html: string, attachments?: Array<{filename:string,content:Buffer|string,contentType?:string,cid?:string}> }} opts
 */
async function sendMail(opts) {
  const mailbox = process.env.MS_GRAPH_MAILBOX;
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`;

  const html =
    opts.html ||
    `<pre style="font-family:system-ui,sans-serif">${String(opts.text || '').replace(/</g, '&lt;')}</pre>`;

  const attachments = Array.isArray(opts.attachments)
    ? opts.attachments
        .filter((a) => a && a.filename && a.content != null)
        .map((a) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: String(a.filename),
          contentType: String(a.contentType || 'application/octet-stream'),
          contentBytes: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content)).toString('base64'),
          isInline: Boolean(a.cid),
          ...(a.cid ? { contentId: String(a.cid) } : {}),
        }))
    : [];

  const payload = {
    message: {
      subject: opts.subject,
      body: {
        contentType: 'HTML',
        content: html,
      },
      toRecipients: [{ emailAddress: { address: opts.to } }],
      ...(attachments.length ? { attachments } : {}),
    },
    saveToSentItems: true,
  };

  const { status, data } = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (status < 200 || status >= 300) {
    const msg = data ? JSON.stringify(data) : `HTTP ${status}`;
    throw new Error(`Graph sendMail failed: ${msg}`);
  }
}

module.exports = {
  isConfigured,
  getAccessToken,
  sendMail,
};

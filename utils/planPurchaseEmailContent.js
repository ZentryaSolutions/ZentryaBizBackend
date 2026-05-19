/**
 * Subscription purchase confirmation email (HTML + plain text).
 */

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PLAN_COPY = {
  pro: {
    label: 'Growth',
    priceLine: 'Rs 1,500 / month',
    shopsLine: '1 shop included',
    features: [
      'Everything in trial',
      'Advanced reports',
      'CSV export',
      'Priority support',
    ],
  },
  premium: {
    label: 'Business',
    priceLine: 'Rs 2,500 / month',
    shopsLine: 'Unlimited shops',
    features: [
      'All Growth features',
      'Unlimited shops',
      'Multi-location scale',
      'Dedicated support',
    ],
  },
  starter: {
    label: 'Starter',
    priceLine: 'Monthly subscription',
    shopsLine: '1 shop included',
    features: ['Full POS access', 'Billing & inventory', 'Customer ledger'],
  },
};

/**
 * @param {{ planKey: string, amountLine?: string, periodEnd?: string|null, appName?: string, shopsUrl?: string }} p
 */
function buildPlanPurchaseEmail(p) {
  const planKey = String(p.planKey || 'pro').toLowerCase();
  const meta = PLAN_COPY[planKey] || PLAN_COPY.pro;
  const appName = escapeHtml(p.appName || 'Zentrya Biz');
  const amountLine = escapeHtml(p.amountLine || meta.priceLine);
  const periodEnd = p.periodEnd
    ? escapeHtml(new Date(p.periodEnd).toLocaleDateString('en-PK', { dateStyle: 'medium' }))
    : null;
  const shopsUrl = escapeHtml(p.shopsUrl || '');

  const featuresHtml = meta.features
    .map((f) => `<li style="margin:6px 0;">${escapeHtml(f)}</li>`)
    .join('');

  const subject = `Your ${meta.label} plan is active — ${appName}`;

  const text = [
    `Thank you for subscribing to ${meta.label} on ${p.appName || 'Zentrya Biz'}.`,
    '',
    `Plan: ${meta.label}`,
    `Amount: ${p.amountLine || meta.priceLine}`,
    `Shops: ${meta.shopsLine}`,
    ...(periodEnd ? [`Renews on: ${periodEnd}`] : []),
    '',
    'Included:',
    ...meta.features.map((f) => `• ${f}`),
    '',
    shopsUrl ? `Manage shops: ${shopsUrl}` : '',
    '',
    'If you did not make this purchase, contact support immediately.',
  ]
    .filter(Boolean)
    .join('\n');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f3ef;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ef;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#1e1b4b 0%,#4f46e5 100%);padding:28px 32px;color:#fff;">
            <div style="font-size:13px;opacity:.85;letter-spacing:.06em;text-transform:uppercase;">Payment confirmed</div>
            <div style="font-size:26px;font-weight:800;margin-top:8px;">${escapeHtml(meta.label)} plan</div>
            <div style="font-size:14px;opacity:.9;margin-top:6px;">${appName}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;color:#1e293b;">
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">Your subscription is now active. Here is what you purchased:</p>
            <table role="presentation" width="100%" style="background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
              <tr><td style="padding:16px 20px;">
                <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Amount</div>
                <div style="font-size:22px;font-weight:800;color:#4f46e5;margin-top:4px;">${amountLine}</div>
                <div style="margin-top:16px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Shops allowed</div>
                <div style="font-size:16px;font-weight:700;margin-top:4px;">${escapeHtml(meta.shopsLine)}</div>
                ${periodEnd ? `<div style="margin-top:16px;font-size:13px;color:#64748b;">Next billing: <strong style="color:#334155;">${periodEnd}</strong></div>` : ''}
              </td></tr>
            </table>
            <p style="margin:24px 0 10px;font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.04em;">Features included</p>
            <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.5;color:#334155;">${featuresHtml}</ul>
            ${
              shopsUrl
                ? `<p style="margin:28px 0 0;text-align:center;">
              <a href="${shopsUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:10px;">Open My Shops</a>
            </p>`
                : ''
            }
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 24px;font-size:12px;color:#94a3b8;text-align:center;border-top:1px solid #f1f5f9;">
            Receipt is also available in Stripe. Questions? Reply to this email or contact your administrator.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  return { subject, text, html };
}

module.exports = { buildPlanPurchaseEmail, PLAN_COPY };

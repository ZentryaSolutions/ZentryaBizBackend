/**
 * Email copy when an admin adds a staff member (cashier / admin) to a shop.
 */

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{ storeName: string, roleLabel: string }} p
 */
function buildStaffAddedEmail({ storeName, roleLabel }) {
  const store = escapeHtml(storeName);
  const role = escapeHtml(roleLabel);
  const subject = `You've been added to ${storeName}`;
  const text = [
    `You have been added as ${roleLabel} at ${storeName}.`,
    '',
    'Sign in to Biz (POS) with your email address and the password your administrator set for you.',
    '',
    'If you did not expect this message, you can ignore it.',
  ].join('\n');

  const html = `
<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#101828;">
  <p>You have been added as <strong>${role}</strong> at <strong>${store}</strong>.</p>
  <p>Sign in to <strong>Biz</strong> using your <strong>email address</strong> and the password your administrator set for you.</p>
  <p style="color:#667085;font-size:13px;">If you did not expect this message, you can ignore it.</p>
</body></html>`.trim();

  return { subject, text, html };
}

module.exports = { buildStaffAddedEmail };

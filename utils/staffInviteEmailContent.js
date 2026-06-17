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

/**
 * @param {{ storeName: string, roleLabel: string, acceptUrl: string, rejectUrl: string, logoCid?: string }} p
 */
function buildStaffInvitationEmail({ storeName, roleLabel, acceptUrl, rejectUrl, logoCid = 'zentrya-company-logo' }) {
  const store = escapeHtml(storeName);
  const role = escapeHtml(roleLabel);
  const subject = `Invitation to join ${storeName}`;
  const text = [
    `You have been invited as ${roleLabel} for ${storeName}.`,
    '',
    `Accept invitation: ${acceptUrl}`,
    `Reject invitation: ${rejectUrl}`,
    '',
    'This invitation expires in 48 hours.',
  ].join('\n');

  const html = `
      <div style="margin:0;padding:18px;background:#eef2ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
        <div style="max-width:620px;margin:0 auto;background:linear-gradient(145deg,#ffffff,#f8faff);border:1px solid #dde5ff;border-radius:16px;overflow:hidden;box-shadow:0 10px 28px rgba(30,41,59,.12)">
          <div style="padding:16px 18px;background:linear-gradient(90deg,#4f46e5,#6366f1);color:#fff">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
              <tr>
                <td width="56" valign="middle" style="width:56px;vertical-align:middle;padding-right:10px">
                  <img src="cid:${logoCid}" alt="Zentrya Biz" width="44" height="44" style="display:block;width:44px;height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.45);background:#fff" />
                </td>
                <td valign="middle" style="vertical-align:middle">
                  <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.9;line-height:1.3">Zentrya Biz</div>
                  <div style="font-size:20px;font-weight:800;line-height:1.25;margin-top:2px">Store Team Invitation</div>
                </td>
              </tr>
            </table>
          </div>
          <div style="padding:18px">
            <p style="margin:0 0 10px;font-size:15px;color:#334155">You have been invited as <strong>${role}</strong> for <strong>${store}</strong>.</p>
            <p style="margin:0 0 14px;color:#475467">Join your team to start billing, inventory, and daily sales workflows.</p>
            <div style="margin:16px 0">
              <a href="${acceptUrl}" style="display:inline-block;padding:11px 16px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:10px;margin-right:8px;font-weight:700">Accept</a>
              <a href="${rejectUrl}" style="display:inline-block;padding:11px 16px;background:#fff;color:#b42318;text-decoration:none;border:1px solid #fecaca;border-radius:10px;font-weight:600">Reject</a>
            </div>
            <div style="margin:12px 0;padding:10px 12px;background:#eef4ff;border:1px solid #dbe5ff;border-radius:10px;color:#1e3a8a;font-size:13px">
              Already registered on this app? Click <strong>Accept</strong> and choose <strong>Yes</strong> on next page.
            </div>
            <p style="margin:10px 0 0;font-size:12px;color:#667085">This invitation expires in 48 hours.</p>
          </div>
        </div>
      </div>
    `;

  return { subject, text, html, logoCid };
}

module.exports = { buildStaffAddedEmail, buildStaffInvitationEmail };

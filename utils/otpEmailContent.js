function buildOtpEmailContent(code, purpose) {
  const appName = process.env.APP_NAME || 'Zentrya Biz';
  const subject = `${appName} verification code`;
  let safePurpose = 'verify your request';
  if (purpose === 'signup') safePurpose = 'complete your signup';
  else if (purpose === 'reset') safePurpose = 'reset your password';
  else if (purpose === 'login') safePurpose = 'sign in to your account';

  const text =
    `Your ${appName} verification code is: ${code}\n\n` +
    `Use this code to ${safePurpose}. This code expires in 15 minutes.\n\n` +
    `If you did not request this code, you can ignore this email.`;

  const html = `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#f7f8fb; padding:24px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border:1px solid #e6e8ef; border-radius:14px; overflow:hidden;">
      <div style="padding:18px 20px; background:linear-gradient(135deg,#4f46e5,#6366f1); color:#fff;">
        <div style="font-weight:700; font-size:16px;">${appName}</div>
        <div style="opacity:.9; font-size:13px; margin-top:4px;">Email verification</div>
      </div>
      <div style="padding:20px;">
        <div style="font-size:14px; color:#111827;">Use the verification code below to ${safePurpose}.</div>
        <div style="margin:18px 0; text-align:center;">
          <div style="display:inline-block; letter-spacing:10px; font-weight:800; font-size:28px; background:#f3f4f6; padding:14px 18px; border-radius:12px; color:#111827;">
            ${code}
          </div>
        </div>
        <div style="font-size:13px; color:#6b7280;">This code expires in 15 minutes. If you didn't request it, you can safely ignore this email.</div>
      </div>
      <div style="padding:14px 20px; border-top:1px solid #eef0f5; font-size:12px; color:#6b7280;">
        Sent by ${appName}
      </div>
    </div>
  </div>`;

  return { subject, text, html };
}

module.exports = { buildOtpEmailContent };

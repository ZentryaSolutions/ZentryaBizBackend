/**
 * Turn a raw User-Agent header into a short label for emails (e.g. "Google Chrome 148 on Windows").
 * All browsers include "Mozilla" and often "Safari" for compatibility — that does not mean three browsers.
 */

function parseUserAgent(ua) {
  const s = String(ua || '').trim();
  if (!s) return 'Unknown browser';

  let browser = 'Unknown browser';
  let version = '';

  const edg = s.match(/Edg\/(\d+)/);
  const opr = s.match(/OPR\/(\d+)/);
  const chrome = s.match(/Chrome\/(\d+)/);
  const firefox = s.match(/Firefox\/(\d+)/);
  const safariVersion = s.match(/Version\/(\d+).*Safari/);

  if (edg) {
    browser = 'Microsoft Edge';
    version = edg[1];
  } else if (opr) {
    browser = 'Opera';
    version = opr[1];
  } else if (chrome && !edg) {
    browser = 'Google Chrome';
    version = chrome[1];
  } else if (firefox) {
    browser = 'Firefox';
    version = firefox[1];
  } else if (/Safari\//.test(s) && !chrome) {
    browser = 'Safari';
    version = (safariVersion && safariVersion[1]) || '';
  }

  let os = 'Unknown OS';
  if (/Windows NT 10\.0/.test(s)) os = 'Windows 10/11';
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Linux/.test(s)) os = 'Linux';

  const browserLabel = version ? `${browser} ${version}` : browser;
  return `${browserLabel} on ${os}`;
}

module.exports = { parseUserAgent };

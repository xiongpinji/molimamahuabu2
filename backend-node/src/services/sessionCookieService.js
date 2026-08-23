const COOKIE_NAME = 'moli_media_session';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function baseOptions(secure) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: Boolean(secure),
    path: '/',
  };
}

function setSessionCookie(res, token, secure) {
  if (typeof res.cookie !== 'function') return;
  res.cookie(COOKIE_NAME, token, {
    ...baseOptions(secure),
    maxAge: MAX_AGE_MS,
  });
}

function clearSessionCookie(res, secure) {
  if (typeof res.clearCookie !== 'function') return;
  res.clearCookie(COOKIE_NAME, baseOptions(secure));
}

function readSessionCookie(req) {
  const header = String(req.get('cookie') || '');
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0 || pair.slice(0, index).trim() !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(pair.slice(index + 1).trim());
    } catch (_) {
      return '';
    }
  }
  return '';
}

module.exports = {
  COOKIE_NAME,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
};

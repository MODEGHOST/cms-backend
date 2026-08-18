import { config } from "./config.js";

const COOKIE_NAME = "token";
export const PORTAL_COOKIE_NAME = "lfb_token";

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    domain: config.cookie.domain,
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  };
}

export function setSessionCookie(res, token) {
  const options = cookieOptions();
  res.cookie(COOKIE_NAME, token, options);
  res.cookie(PORTAL_COOKIE_NAME, token, options);
}

export function clearSessionCookie(res) {
  const options = { ...cookieOptions(), maxAge: 0 };
  res.clearCookie(COOKIE_NAME, options);
  res.clearCookie(PORTAL_COOKIE_NAME, options);
}

export function readTokenFromRequest(req) {
  const header = req.headers.authorization || "";
  const tokenFromHeader = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (tokenFromHeader) return tokenFromHeader;
  const cookies = req.cookies || {};
  return cookies[PORTAL_COOKIE_NAME] || cookies[COOKIE_NAME] || null;
}

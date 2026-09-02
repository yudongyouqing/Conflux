const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

function parseHttpUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url;
}

function parseOrigin(value) {
  const url = parseHttpUrl(value);
  if (!url) return null;
  return url;
}

function isAllowedNavigation(url, appOrigin) {
  const candidate = parseHttpUrl(url);
  const origin = parseOrigin(appOrigin);
  if (!candidate || !origin) return false;
  return candidate.origin === origin.origin;
}

function externalLinkDecision(url, appOrigin) {
  if (isAllowedNavigation(url, appOrigin)) return { action: "allow" };

  const candidate = parseHttpUrl(url);
  if (!candidate) return { action: "deny" };
  return { action: "external", url: candidate.href };
}

function productionCsp(appOrigin) {
  const origin = parseOrigin(appOrigin);
  if (!origin) throw new TypeError("appOrigin must be an absolute HTTP(S) origin");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${origin.origin}`,
    "form-action 'self'",
  ].join("; ");
}

module.exports = {
  isAllowedNavigation,
  externalLinkDecision,
  productionCsp,
};

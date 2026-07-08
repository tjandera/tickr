// Browser-facing security headers, hand-rolled (no extra dependency).
//
// The CSP is deliberately honest about how the app is built: the frontend is
// single-file HTML with inline <script>/<style>, so 'unsafe-inline' is required
// there. The policy still buys real protection — no external scripts can ever
// load, nothing can frame the app (clickjacking), plugins are dead, and images/
// fonts are pinned to the exact CDNs the UI uses (jsdelivr fonts, parqet ticker
// logos, YouTube thumbnails). Tightening script-src further means moving the
// inline code into .js files served from /static — a good future refactor.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' https://cdn.jsdelivr.net data:",
  "img-src 'self' data: https://assets.parqet.com https://i.ytimg.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY"); // legacy twin of frame-ancestors
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Only meaningful (and only safe to send) when the app is actually on HTTPS.
  if ((process.env.APP_URL || "").trim().startsWith("https")) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains"); // 180 days
  }
  next();
}

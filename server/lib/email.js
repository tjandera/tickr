// Transactional email via Resend. Two messages: verify-your-email (after signup)
// and your-login-code (the OTP on each login). If RESEND_API is missing, we log
// the link/code to the server console instead so local dev still works.
import { Resend } from "resend";

const KEY = () => (process.env.RESEND_API || process.env.RESEND_API_KEY || "").trim();
const FROM = () => (process.env.EMAIL_FROM || "onboarding@resend.dev").trim();
const APP_URL = () => (process.env.APP_URL || "http://localhost:3005").trim();

let client = null;
function resend() {
  if (!KEY()) return null;
  if (!client) client = new Resend(KEY());
  return client;
}

async function send({ to, subject, html }) {
  const r = resend();
  if (!r) {
    // No provider configured — surface the content in the log for local testing.
    process.stderr.write(`[email] (no RESEND_API) would send "${subject}" to ${to}\n`);
    return { delivered: false };
  }
  const { error } = await r.emails.send({ from: FROM(), to, subject, html });
  if (error) throw new Error(error.message || "email send failed");
  return { delivered: true };
}

const shell = (title, body) => `
  <div style="font-family:Inter,system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#0f172a">
    <div style="font-size:20px;font-weight:700;color:#2563eb;margin-bottom:16px">Tickr</div>
    <h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
    ${body}
    <p style="font-size:12px;color:#94a3b8;margin-top:24px">If you did not request this, you can safely ignore this email.</p>
  </div>`;

export function sendVerificationEmail(to, rawToken) {
  const link = `${APP_URL()}/api/auth/verify?token=${rawToken}`;
  return send({
    to,
    subject: "Confirm your Tickr account",
    html: shell(
      "Confirm your email",
      `<p style="font-size:14px;line-height:1.6">Welcome to Tickr. Click the button below to confirm your email and activate your account.</p>
       <p style="margin:20px 0"><a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Confirm email</a></p>
       <p style="font-size:12px;color:#64748b">Or paste this link into your browser:<br>${link}</p>`
    ),
  });
}

export function sendLoginOtp(to, code) {
  return send({
    to,
    subject: `Your Tickr login code: ${code}`,
    html: shell(
      "Your login code",
      `<p style="font-size:14px;line-height:1.6">Enter this code to finish signing in. It expires in 10 minutes.</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:20px 0;color:#2563eb">${code}</p>`
    ),
  });
}

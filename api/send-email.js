// api/send-email.js
// Vercel Serverless Function — receives the contact form POST from the
// portfolio page and sends an email using the Resend API.
//
// Env vars required (set in Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY   - your Resend API key (https://resend.com/api-keys)
//   CONTACT_TO_EMAIL - the inbox that should receive messages (e.g. cchaithanya252@gmail.com)
//   CONTACT_FROM_EMAIL - the "from" address Resend sends as.
//                        Must be on a domain you've verified in Resend,
//                        e.g. "Portfolio <contact@yourdomain.com>".
//                        For quick testing before you verify a domain, you can use
//                        "Portfolio <onboarding@resend.dev>" (Resend's shared test sender).

export const config = {
  api: {
    bodyParser: true,
  },
};

// very small in-memory rate limiter (per serverless instance — best-effort only)
const rateLimit = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 3;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  rateLimit.set(ip, entry);
  return entry.count > MAX_REQUESTS;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  // CORS (loosen/tighten as you like — same-origin form doesn't strictly need this,
  // but it's handy if you ever call the API from a different origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const ip =
    req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Please try again in a minute.' });
  }

  try {
    const { name, phone, email, subject, message, website } = req.body || {};

    // Honeypot: a hidden "website" field that real users never fill in.
    // If it's populated, silently pretend success (don't tip off bots).
    if (website) {
      return res.status(200).json({ success: true });
    }

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, error: 'Name, email, and message are required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
    }
    if (String(message).length > 5000) {
      return res.status(400).json({ success: false, error: 'Message is too long.' });
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const TO_EMAIL = process.env.CONTACT_TO_EMAIL;
    const FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || 'Portfolio <onboarding@resend.dev>';

    if (!RESEND_API_KEY || !TO_EMAIL) {
      console.error('Missing RESEND_API_KEY or CONTACT_TO_EMAIL env vars');
      return res.status(500).json({ success: false, error: 'Server email is not configured yet.' });
    }

    const safeName = escapeHtml(name);
    const safePhone = escapeHtml(phone || '—');
    const safeEmail = escapeHtml(email);
    const safeSubject = escapeHtml(subject || '(no subject)');
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br/>');

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">New portfolio contact message</h2>
        <p style="color:#666;margin-top:0;">via chaithanyakumarsadu.dev contact form</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:6px 0;color:#888;width:90px;">Name</td><td style="padding:6px 0;">${safeName}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Email</td><td style="padding:6px 0;">${safeEmail}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Phone</td><td style="padding:6px 0;">${safePhone}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Subject</td><td style="padding:6px 0;">${safeSubject}</td></tr>
        </table>
        <div style="padding:14px;background:#f5f5f5;border-radius:8px;line-height:1.6;">${safeMessage}</div>
      </div>
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [TO_EMAIL],
        reply_to: email, // lets you hit "reply" and answer the sender directly
        subject: `Portfolio contact: ${subject || 'New message from ' + name}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend API error:', resendRes.status, errBody);
      return res.status(502).json({ success: false, error: 'Failed to send email. Please try again later.' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Unhandled error in send-email:', err);
    return res.status(500).json({ success: false, error: 'Unexpected server error.' });
  }
}
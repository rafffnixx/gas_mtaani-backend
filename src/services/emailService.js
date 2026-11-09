// 📁 backend/src/services/emailService.js
//
// Uses Brevo HTTP API (not SMTP) because Render blocks outbound SMTP ports.
// API endpoint: https://api.brevo.com/v3/smtp/email

const crypto = require('crypto');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || 'gasmtaani@raffcodes.tech';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Gas Mtaani';

// Startup sanity check
if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is not set in environment — emails will fail');
} else {
  console.log('✅ Brevo API configured (key present)');
}

function generateVerificationCode() {
  return String(crypto.randomInt(100000, 999999));
}

async function sendEmailViaBrevo({ to, subject, html }) {
  if (!BREVO_API_KEY) {
    console.error('❌ Cannot send email — BREVO_API_KEY missing');
    return { ok: false, error: 'Missing BREVO_API_KEY' };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`❌ Brevo API error [${response.status}]:`, errorBody);
      return { ok: false, error: `HTTP ${response.status}: ${errorBody.slice(0, 200)}` };
    }

    const result = await response.json();
    const messageId = result.messageId || result.messageIds?.[0] || '(no id)';
    console.log(`📧 Email sent to ${to} via Brevo: ${messageId}`);
    return { ok: true, id: messageId };
  } catch (err) {
    console.error('❌ Brevo request failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendVerificationCodeEmail({ to, fullName, code }) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #FF6B00; margin-bottom: 8px;">Welcome to Gas Mtaani, ${fullName}!</h2>
      <p style="color: #333; font-size: 15px;">Use the code below to verify your email address:</p>

      <div style="background: #F5F5F5; border: 2px dashed #FF6B00; border-radius: 12px;
                  padding: 24px; text-align: center; margin: 30px 0;">
        <div style="font-size: 42px; font-weight: bold; letter-spacing: 12px;
                    color: #FF6B00; font-family: 'Courier New', monospace;">
          ${code}
        </div>
      </div>

      <p style="color: #333; font-size: 15px;">Enter this code in the Gas Mtaani app to complete your registration.</p>

      <p style="color: #666; font-size: 13px; margin-top: 30px;">
        ⏱ This code expires in <strong>10 minutes</strong>.<br>
        🔒 If you didn't sign up for Gas Mtaani, you can safely ignore this email.
      </p>
    </div>
  `;

  return sendEmailViaBrevo({
    to,
    subject: `Your Gas Mtaani verification code: ${code}`,
    html,
  });
}

async function sendPasswordResetCodeEmail({ to, fullName, code }) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #FF6B00; margin-bottom: 8px;">Reset your Gas Mtaani password</h2>
      <p style="color: #333; font-size: 15px;">Hi ${fullName},</p>
      <p style="color: #333; font-size: 15px;">Use the code below to reset your password:</p>

      <div style="background: #F5F5F5; border: 2px dashed #FF6B00; border-radius: 12px;
                  padding: 24px; text-align: center; margin: 30px 0;">
        <div style="font-size: 42px; font-weight: bold; letter-spacing: 12px;
                    color: #FF6B00; font-family: 'Courier New', monospace;">
          ${code}
        </div>
      </div>

      <p style="color: #333; font-size: 15px;">Enter this code in the Gas Mtaani app to set a new password.</p>

      <p style="color: #666; font-size: 13px; margin-top: 30px;">
        ⏱ This code expires in <strong>15 minutes</strong>.<br>
        🔒 If you didn't request this, ignore this email — your password will stay the same.
      </p>
    </div>
  `;

  return sendEmailViaBrevo({
    to,
    subject: `Reset your Gas Mtaani password: ${code}`,
    html,
  });
}

module.exports = {
  generateVerificationCode,
  sendVerificationCodeEmail,
  sendPasswordResetCodeEmail,
};
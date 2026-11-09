// 📁 backend/src/services/emailService.js
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Configure the SMTP transporter for Hostinger
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.hostinger.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: true, // true for 465 (SSL)
  auth: {
    user: process.env.SMTP_USER, // e.g., noreply@raffcodes.tech
    pass: process.env.SMTP_PASS, // The password you set in hPanel
  },
  // These options help with Hostinger connection stability 
  secureConnection: false,
  tls: {
    ciphers: 'SSLv3',
  },
  requireTLS: true,
  connectionTimeout: 10000,
});

// Verify connection on startup (check Render logs for this)
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ SMTP Connection Error:', error.message);
  } else {
    console.log('✅ SMTP Server is ready to send emails via Hostinger');
  }
});

const FROM_EMAIL = process.env.EMAIL_FROM || '"Gas Mtaani" <noreply@raffcodes.tech>';

function generateVerificationCode() {
  return String(crypto.randomInt(100000, 999999));
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

  try {
    const info = await transporter.sendMail({
      from: FROM_EMAIL,
      to,
      subject: `Your Gas Mtaani verification code: ${code}`,
      html,
    });
    console.log(`📧 Verification code sent to ${to}:`, info.messageId);
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error('❌ Verification email failed:', err.message);
    return { ok: false, error: err.message };
  }
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

  try {
    const info = await transporter.sendMail({
      from: FROM_EMAIL,
      to,
      subject: `Reset your Gas Mtaani password: ${code}`,
      html,
    });
    console.log(`📧 Password reset code sent to ${to}:`, info.messageId);
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error('❌ Reset email failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  generateVerificationCode,
  sendVerificationCodeEmail,
  sendPasswordResetCodeEmail,
};
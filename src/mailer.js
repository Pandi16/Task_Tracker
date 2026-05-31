const nodemailer = require('nodemailer');
require('dotenv').config();

function isEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransporter() {
  if (!isEmailConfigured()) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendEmail(to, subject, text) {
  const transporter = createTransporter();
  if (!transporter) return false;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'NX Tracker <no-reply@example.com>',
    to,
    subject,
    text,
  });

  return true;
}

module.exports = { sendEmail, isEmailConfigured };

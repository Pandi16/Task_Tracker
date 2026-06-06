require('dotenv').config();

function isEmailConfigured() {
  return Boolean(process.env.APPS_SCRIPT_WEBAPP_URL && process.env.APPS_SCRIPT_SECRET);
}

async function sendEmail(to, subject, text) {
  if (!isEmailConfigured()) return false;

  const response = await fetch(process.env.APPS_SCRIPT_WEBAPP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      secret: process.env.APPS_SCRIPT_SECRET,
      to,
      subject,
      body: text,
      fromName: process.env.MAIL_FROM_NAME || 'NX Tracker'
    })
  });

  const rawResponse = await response.text();
  let parsed;

  try {
    parsed = JSON.parse(rawResponse);
  } catch (err) {
    throw new Error(`Apps Script mailer returned a non-JSON response: ${rawResponse.slice(0, 200)}`);
  }

  if (!parsed.ok) {
    throw new Error(parsed.error || 'Apps Script mailer failed');
  }

  return true;
}

module.exports = { sendEmail, isEmailConfigured };

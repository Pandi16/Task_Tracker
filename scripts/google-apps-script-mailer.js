const SECRET = 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET';

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: 'Missing request body' });
    }

    const data = JSON.parse(e.postData.contents);

    if (data.secret !== SECRET) {
      return jsonResponse({ ok: false, error: 'Unauthorized request' });
    }

    if (!data.to || !data.subject || !data.body) {
      return jsonResponse({ ok: false, error: 'Missing to, subject, or body' });
    }

    const mailOptions = {
      to: data.to,
      subject: data.subject,
      body: data.body,
      name: data.fromName || 'NX Tracker'
    };

    if (data.htmlBody) {
      mailOptions.htmlBody = data.htmlBody;
    }

    MailApp.sendEmail(mailOptions);

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function testMail() {
  MailApp.sendEmail({
    to: 'your-email@example.com',
    subject: 'NX Tracker Apps Script test',
    body: 'MailApp authorization test',
    name: 'NX Tracker'
  });
}

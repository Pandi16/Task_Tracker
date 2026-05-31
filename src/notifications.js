const cron = require('node-cron');
const { query } = require('./db');
const { sendEmail } = require('./mailer');

async function createNotification(userId, itemId, message) {
  if (!userId) return;
  await query(
    'INSERT INTO notifications (user_id, item_id, message) VALUES ($1, $2, $3)',
    [userId, itemId, message]
  );
}

async function notifyUser(userId, itemId, subject, message) {
  if (!userId) return;
  await createNotification(userId, itemId, message);
  const user = await query('SELECT email FROM users WHERE id = $1', [userId]);
  if (user.rows[0]?.email) {
    try {
      await sendEmail(user.rows[0].email, subject, message);
    } catch (err) {
      console.error('Email failed:', err.message);
    }
  }
}

function startReminderJob() {
  cron.schedule('0 * * * *', async () => {
    try {
      const overdue = await query(`
        SELECT i.id, i.item_code, i.title, i.owner_id, i.waiting_for_id, i.due_date
        FROM items i
        WHERE i.status IN ('Waiting For', 'In Progress', 'Ready for Review')
          AND i.due_date IS NOT NULL
          AND i.due_date < CURRENT_DATE
      `);

      for (const item of overdue.rows) {
        const targetUser = item.waiting_for_id || item.owner_id;
        const message = `${item.item_code} is overdue. Title: ${item.title}. Due date: ${item.due_date.toISOString().slice(0, 10)}.`;
        await createNotification(targetUser, item.id, message);
      }
    } catch (err) {
      console.error('Reminder job failed:', err.message);
    }
  });
}

module.exports = { createNotification, notifyUser, startReminderJob };

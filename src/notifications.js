const cron = require('node-cron');
const { query } = require('./db');
const { sendEmail, isEmailConfigured } = require('./mailer');

function formatDate(value) {
  if (!value) return 'Not set';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeText(value) {
  return value && String(value).trim() ? String(value).trim() : 'Not provided';
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function createNotification(userId, itemId, message) {
  if (!userId) return;
  await query(
    'INSERT INTO notifications (user_id, item_id, message) VALUES ($1, $2, $3)',
    [userId, itemId || null, message]
  );
}

async function hasNotificationToday(userId, itemId, message) {
  if (!userId) return true;

  const existing = await query(
    `SELECT id
     FROM notifications
     WHERE user_id = $1
       AND item_id IS NOT DISTINCT FROM $2
       AND message = $3
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, itemId || null, message]
  );

  return existing.rows.length > 0;
}

async function notifyUser(userId, itemId, subject, message) {
  if (!userId) return;

  await createNotification(userId, itemId, message);

  const user = await query('SELECT email FROM users WHERE id = $1 AND is_active = TRUE', [userId]);
  const email = user.rows[0]?.email;

  if (!email) return;

  if (!isEmailConfigured()) {
    console.log(`Email not configured. Notification saved in app for user ${userId}: ${subject}`);
    return;
  }

  try {
    await sendEmail(email, subject, message);
  } catch (err) {
    console.error('Email failed:', err.message);
  }
}

async function getItemForWaitingEmail(itemId) {
  const result = await query(`
    SELECT
      i.*,
      waiter.name AS waiting_for_name,
      waiter.email AS waiting_for_email,
      owner.name AS owner_name,
      creator.name AS created_by_name
    FROM items i
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users creator ON creator.id = i.created_by
    WHERE i.id = $1
  `, [itemId]);

  return result.rows[0];
}

function buildWaitingForEmailText(item, reasonLabel) {
  const intro = reasonLabel === 'created'
    ? 'A new task has been created and is waiting for your input.'
    : 'A task has been updated and is now waiting for your input.';

  return [
    `Hello ${item.waiting_for_name || 'there'},`,
    '',
    intro,
    '',
    `Task: ${item.item_code} - ${item.title}`,
    `Status: ${item.status}`,
    `Priority: ${item.priority}`,
    `Component: ${normalizeText(item.component)}`,
    `Due date: ${formatDate(item.due_date)}`,
    `Reminder date: ${formatDate(item.reminder_date)}`,
    `Created by: ${item.created_by_name || 'Not available'}`,
    `Owner: ${item.owner_name || 'Not assigned'}`,
    '',
    'Description:',
    normalizeText(item.description),
    '',
    'Please review this item and update the tracker once your action is completed.',
    '',
    'This is an automated notification from NX Services Tracker.'
  ].join('\n');
}

async function notifyWaitingForItem(itemId, reasonLabel = 'updated') {
  const item = await getItemForWaitingEmail(itemId);
  if (!item || !item.waiting_for_id || !item.waiting_for_email) return;

  const subject = `Action needed: ${item.item_code} is waiting for you`;
  const message = buildWaitingForEmailText(item, reasonLabel);

  await createNotification(item.waiting_for_id, item.id, `${item.item_code} is waiting for your input.`);

  if (!isEmailConfigured()) {
    console.log(`Email not configured. Waiting-for notification saved in app for user ${item.waiting_for_id}: ${subject}`);
    return;
  }

  try {
    await sendEmail(item.waiting_for_email, subject, message);
  } catch (err) {
    console.error('Waiting-for email failed:', err.message);
  }
}

function isDailyReminderTimeReached() {
  const now = new Date();
  const hour = Number(process.env.DAILY_REMINDER_HOUR || 10);
  const minute = Number(process.env.DAILY_REMINDER_MINUTE || 0);

  if (now.getHours() > hour) return true;
  if (now.getHours() === hour && now.getMinutes() >= minute) return true;
  return false;
}

async function getWaitingItemsGroupedByUser() {
  const result = await query(`
    SELECT
      i.*,
      waiter.id AS waiting_for_user_id,
      waiter.name AS waiting_for_name,
      waiter.email AS waiting_for_email,
      owner.name AS owner_name,
      creator.name AS created_by_name,
      CASE
        WHEN i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE THEN TRUE
        ELSE FALSE
      END AS is_overdue
    FROM items i
    JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users creator ON creator.id = i.created_by
    WHERE i.status = 'Waiting For'
      AND waiter.is_active = TRUE
    ORDER BY waiter.name ASC, i.due_date ASC NULLS LAST, i.updated_at ASC
  `);

  const grouped = new Map();
  for (const item of result.rows) {
    if (!grouped.has(item.waiting_for_user_id)) {
      grouped.set(item.waiting_for_user_id, {
        userId: item.waiting_for_user_id,
        name: item.waiting_for_name,
        email: item.waiting_for_email,
        items: []
      });
    }
    grouped.get(item.waiting_for_user_id).items.push(item);
  }

  return Array.from(grouped.values());
}

function buildDailyDigestEmailText(userGroup) {
  const lines = [
    `Hello ${userGroup.name || 'there'},`,
    '',
    `This is your daily 10 AM reminder for tasks currently waiting for your input.`,
    '',
    `Pending tasks: ${userGroup.items.length}`,
    ''
  ];

  userGroup.items.forEach((item, index) => {
    const overdueText = item.is_overdue ? 'Overdue' : 'Pending';
    lines.push(`${index + 1}. ${item.item_code} - ${item.title}`);
    lines.push(`   Status: ${overdueText}`);
    lines.push(`   Priority: ${item.priority}`);
    lines.push(`   Due date: ${formatDate(item.due_date)}`);
    lines.push(`   Created by: ${item.created_by_name || 'Not available'}`);
    lines.push(`   Owner: ${item.owner_name || 'Not assigned'}`);
    lines.push(`   Component: ${normalizeText(item.component)}`);
    lines.push(`   Description: ${normalizeText(item.description)}`);
    lines.push('');
  });

  lines.push('Please update the tracker once your action is completed.');
  lines.push('This reminder will continue daily while the task status remains Waiting For.');
  lines.push('');
  lines.push('This is an automated notification from NX Services Tracker.');

  return lines.join('\n');
}

async function sendDailyDigestForUser(userGroup) {
  const todayKey = getTodayKey();
  const notificationMessage = `Daily waiting task digest sent for ${todayKey}`;
  const alreadySentToday = await hasNotificationToday(userGroup.userId, null, notificationMessage);
  if (alreadySentToday) return;

  await createNotification(userGroup.userId, null, notificationMessage);

  if (!userGroup.email) return;

  const subject = `Daily reminder: ${userGroup.items.length} task(s) waiting for you`;
  const message = buildDailyDigestEmailText(userGroup);

  if (!isEmailConfigured()) {
    console.log(`Email not configured. Daily digest saved in app for user ${userGroup.userId}: ${subject}`);
    return;
  }

  try {
    await sendEmail(userGroup.email, subject, message);
  } catch (err) {
    console.error('Daily digest email failed:', err.message);
  }
}

function startReminderJob() {
  // Checks every 15 minutes. Once the configured daily time is reached, it sends one digest per user per day.
  // Default time is 10:00 AM based on the Windows VM local time.
  cron.schedule('*/15 * * * *', async () => {
    try {
      if (!isDailyReminderTimeReached()) return;

      const userGroups = await getWaitingItemsGroupedByUser();
      for (const userGroup of userGroups) {
        if (userGroup.items.length > 0) {
          await sendDailyDigestForUser(userGroup);
        }
      }
    } catch (err) {
      console.error('Daily reminder job failed:', err.message);
    }
  });
}

module.exports = {
  createNotification,
  notifyUser,
  notifyWaitingForItem,
  startReminderJob
};

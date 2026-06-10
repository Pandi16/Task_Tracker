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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getReminderHour() {
  const hour = Number(process.env.DAILY_REMINDER_HOUR || 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 10;
}

function getReminderMinute() {
  const minute = Number(process.env.DAILY_REMINDER_MINUTE || 0);
  return Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0;
}

function getReminderTimeZone() {
  return process.env.DAILY_REMINDER_TIMEZONE || 'Asia/Kolkata';
}

function getZonedDateParts(date = new Date()) {
  const timeZone = getReminderTimeZone();

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });

    const parts = Object.fromEntries(
      formatter.formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    );

    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      timeZone
    };
  } catch (err) {
    // If an invalid timezone is configured, fall back to the VM local time.
    const fallback = new Date(date);
    return {
      year: fallback.getFullYear(),
      month: fallback.getMonth() + 1,
      day: fallback.getDate(),
      hour: fallback.getHours(),
      minute: fallback.getMinutes(),
      timeZone: 'VM local time'
    };
  }
}

function getReminderDateKey(date = new Date()) {
  const parts = getZonedDateParts(date);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dailyReminderTimeReached() {
  const now = getZonedDateParts();
  const hour = getReminderHour();
  const minute = getReminderMinute();

  if (now.hour > hour) return true;
  if (now.hour === hour && now.minute >= minute) return true;
  return false;
}

function getConfiguredReminderTimeLabel() {
  const hour = getReminderHour();
  const minute = getReminderMinute();
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${getReminderTimeZone()}`;
}

async function createNotification(userId, itemId, message) {
  if (!userId) return;
  await query(
    'INSERT INTO notifications (user_id, item_id, message) VALUES ($1, $2, $3)',
    [userId, itemId || null, message]
  );
}

async function reserveDailyDigestSlot(userId) {
  const sentOn = getReminderDateKey();
  const result = await query(`
    INSERT INTO daily_digest_log (user_id, sent_on)
    VALUES ($1, $2::date)
    ON CONFLICT (user_id, sent_on) DO NOTHING
    RETURNING id
  `, [userId, sentOn]);

  return result.rows.length > 0;
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
      creator.name AS created_by_name,
      CASE
        WHEN i.due_date IS NOT NULL AND i.due_date < $2::date THEN 'overdue'
        WHEN i.due_date IS NOT NULL AND i.due_date <= $2::date + INTERVAL '1 day' THEN 'due_soon'
        ELSE 'normal'
      END AS due_state
    FROM items i
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users creator ON creator.id = i.created_by
    WHERE i.id = $1
  `, [itemId, getReminderDateKey()]);

  return result.rows[0];
}

function dueStatusLabel(item) {
  if (item.due_state === 'overdue') return 'Overdue';
  if (item.due_state === 'due_soon') return 'Due soon';
  return 'Pending';
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
    `Due status: ${dueStatusLabel(item)}`,
    `Priority: ${item.priority}`,
    `Component: ${normalizeText(item.component)}`,
    `Due date: ${formatDate(item.due_date)}`,
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

function buildWaitingForEmailHtml(item, reasonLabel) {
  const intro = reasonLabel === 'created'
    ? 'A new task has been created and is waiting for your input.'
    : 'A task has been updated and is now waiting for your input.';
  const dueState = item.due_state || 'normal';
  const dueClass = dueState === 'overdue' ? '#fde2e2' : dueState === 'due_soon' ? '#fff3cd' : '#ffffff';
  const dueBorder = dueState === 'overdue' ? '#b91c1c' : dueState === 'due_soon' ? '#ca8a04' : '#e2e8f0';

  return `
    <div style="font-family:Arial,sans-serif;color:#172033;line-height:1.45;">
      <p>Hello ${escapeHtml(item.waiting_for_name || 'there')},</p>
      <p>${escapeHtml(intro)}</p>
      <table style="border-collapse:collapse;width:100%;max-width:720px;border:1px solid #e2e8f0;">
        <tr style="background:#f8fafc;"><th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Field</th><th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;">Task</td><td style="padding:8px;border:1px solid #e2e8f0;"><strong>${escapeHtml(item.item_code)} - ${escapeHtml(item.title)}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;">Status</td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(item.status)}</td></tr>
        <tr style="background:${dueClass};"><td style="padding:8px;border:1px solid ${dueBorder};">Due status</td><td style="padding:8px;border:1px solid ${dueBorder};"><strong>${escapeHtml(dueStatusLabel(item))}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;">Due date</td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(formatDate(item.due_date))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;">Priority</td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(item.priority)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;">Component</td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(normalizeText(item.component))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;">Created by</td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(item.created_by_name || 'Not available')}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;">Owner</td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(item.owner_name || 'Not assigned')}</td></tr>
      </table>
      <p><strong>Description:</strong><br>${escapeHtml(normalizeText(item.description)).replace(/\n/g, '<br>')}</p>
      <p>Please review this item and update the tracker once your action is completed.</p>
      <p style="color:#64748b;font-size:12px;">This is an automated notification from NX Services Tracker.</p>
    </div>`;
}

async function notifyWaitingForItem(itemId, reasonLabel = 'updated') {
  const item = await getItemForWaitingEmail(itemId);
  if (!item || !item.waiting_for_id || !item.waiting_for_email) return;

  const subject = `Action needed: ${item.item_code} is waiting for you`;
  const text = buildWaitingForEmailText(item, reasonLabel);
  const html = buildWaitingForEmailHtml(item, reasonLabel);

  await createNotification(item.waiting_for_id, item.id, `${item.item_code} is waiting for your input.`);

  if (!isEmailConfigured()) {
    console.log(`Email not configured. Waiting-for notification saved in app for user ${item.waiting_for_id}: ${subject}`);
    return;
  }

  try {
    await sendEmail(item.waiting_for_email, subject, text, html);
  } catch (err) {
    console.error('Waiting-for email failed:', err.message);
  }
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
        WHEN i.due_date IS NOT NULL AND i.due_date < $1::date THEN 'overdue'
        WHEN i.due_date IS NOT NULL AND i.due_date <= $1::date + INTERVAL '1 day' THEN 'due_soon'
        ELSE 'normal'
      END AS due_state
    FROM items i
    JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users creator ON creator.id = i.created_by
    WHERE i.waiting_for_id IS NOT NULL
      AND i.status <> 'Completed'
      AND waiter.is_active = TRUE
    ORDER BY waiter.name ASC, i.due_date ASC NULLS LAST, i.updated_at ASC
  `, [getReminderDateKey()]);

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
  const reminderTime = getConfiguredReminderTimeLabel();
  const lines = [
    `Hello ${userGroup.name || 'there'},`,
    '',
    `This is your daily ${reminderTime} reminder for tasks currently assigned in the Waiting For field under your name.`,
    '',
    `Open waiting-for tasks: ${userGroup.items.length}`,
    ''
  ];

  userGroup.items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.item_code} - ${item.title}`);
    lines.push(`   Status: ${item.status}`);
    lines.push(`   Due status: ${dueStatusLabel(item)}`);
    lines.push(`   Priority: ${item.priority}`);
    lines.push(`   Due date: ${formatDate(item.due_date)}`);
    lines.push(`   Created by: ${item.created_by_name || 'Not available'}`);
    lines.push(`   Owner: ${item.owner_name || 'Not assigned'}`);
    lines.push(`   Component: ${normalizeText(item.component)}`);
    lines.push(`   Description: ${normalizeText(item.description)}`);
    lines.push('');
  });
  
  lines.push('Open NX Services Tracker:');
  lines.push('http://ustr-mvm-8134.na.uis.unisys.com:3000/items');
  lines.push('');

  lines.push('Please update the tracker once your action is completed.');
  lines.push('This reminder will continue daily while your name remains in the Waiting For field and the task is not Completed.');
  lines.push('Due soon tasks are due today or tomorrow. Overdue tasks have already crossed the due date.');
  lines.push('');
  lines.push('This is an automated notification from NX Services Tracker.');

  return lines.join('\n');
}

function buildDailyDigestEmailHtml(userGroup) {
  const reminderTime = getConfiguredReminderTimeLabel();
  const rows = userGroup.items.map((item) => {
    const dueState = item.due_state || 'normal';
    const bg = dueState === 'overdue' ? '#fde2e2' : dueState === 'due_soon' ? '#fff3cd' : '#ffffff';
    const border = dueState === 'overdue' ? '#b91c1c' : dueState === 'due_soon' ? '#ca8a04' : '#e2e8f0';
    return `
      <tr style="background:${bg};">
        <td style="padding:8px;border:1px solid ${border};"><strong>${escapeHtml(item.item_code)}</strong></td>
        <td style="padding:8px;border:1px solid ${border};">${escapeHtml(item.title)}</td>
        <td style="padding:8px;border:1px solid ${border};">${escapeHtml(item.status)}</td>
        <td style="padding:8px;border:1px solid ${border};"><strong>${escapeHtml(dueStatusLabel(item))}</strong></td>
        <td style="padding:8px;border:1px solid ${border};">${escapeHtml(formatDate(item.due_date))}</td>
        <td style="padding:8px;border:1px solid ${border};">${escapeHtml(item.priority)}</td>
        <td style="padding:8px;border:1px solid ${border};">${escapeHtml(item.created_by_name || 'Not available')}</td>
        <td style="padding:8px;border:1px solid ${border};">${escapeHtml(item.owner_name || 'Not assigned')}</td>
        <td style="padding:8px;border:1px solid ${border};">${escapeHtml(normalizeText(item.description))}</td>
      </tr>`;
  }).join('');

  return `
    <div style="font-family:Arial,sans-serif;color:#172033;line-height:1.45;">
      <p>Hello ${escapeHtml(userGroup.name || 'there')},</p>
      <p>This is your daily <strong>${escapeHtml(reminderTime)}</strong> reminder for tasks currently assigned in the Waiting For field under your name.</p>
      <p><strong>Open waiting-for tasks:</strong> ${userGroup.items.length}</p>
      <p><span style="background:#fff3cd;padding:4px 8px;border-radius:8px;">Yellow = due today/tomorrow</span>
         <span style="background:#fde2e2;padding:4px 8px;border-radius:8px;">Red = overdue</span></p>
      <table style="border-collapse:collapse;width:100%;border:1px solid #e2e8f0;font-size:13px;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Code</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Task</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Status</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Due status</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Due date</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Priority</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Created by</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Owner</th>
            <th style="text-align:left;padding:8px;border:1px solid #e2e8f0;">Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;">
        <strong>Open NX Services Tracker:</strong>
        <a href="http://ustr-mvm-8134.na.uis.unisys.com:3000/items" target="_blank">
          http://ustr-mvm-8134.na.uis.unisys.com:3000/items
        </a>
      </p>
      <p>Please update the tracker once your action is completed.</p>
      <p style="color:#64748b;font-size:12px;">This reminder will continue daily while your name remains in the Waiting For field and the task is not Completed. This is an automated notification from NX Services Tracker.</p>
    </div>`;
}

async function sendDailyDigestForUser(userGroup) {
  const reserved = await reserveDailyDigestSlot(userGroup.userId);
  if (!reserved) return;

  const subject = `Daily reminder: ${userGroup.items.length} task(s) waiting for you`;
  const text = buildDailyDigestEmailText(userGroup);
  const html = buildDailyDigestEmailHtml(userGroup);

  await createNotification(userGroup.userId, null, `Daily waiting task digest sent for today`);

  if (!userGroup.email) return;

  if (!isEmailConfigured()) {
    console.log(`Email not configured. Daily digest saved in app for user ${userGroup.userId}: ${subject}`);
    return;
  }

  try {
    await sendEmail(userGroup.email, subject, text, html);
  } catch (err) {
    console.error('Daily digest email failed:', err.message);
  }
}

function startReminderJob() {
  // Checks every 15 minutes. Once the configured daily time is reached, it sends one digest per user per day.
  // Time is read in 24-hour format and uses DAILY_REMINDER_TIMEZONE, defaulting to Asia/Kolkata.
  console.log(`Daily reminder configured for ${getConfiguredReminderTimeLabel()}`);

  cron.schedule('*/15 * * * *', async () => {
    try {
      if (!dailyReminderTimeReached()) return;

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

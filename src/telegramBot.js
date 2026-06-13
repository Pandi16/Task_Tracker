require('dotenv').config();
const { query } = require('./db');
const { getTelegramUpdates, sendTelegramMessage, isTelegramPollingEnabled, getTelegramPollIntervalMs } = require('./telegram');
const { notifyWaitingForItem } = require('./notifications');

const COMPONENT_NAME = 'NX/Services';
const STATUSES = ['New', 'Triaged', 'Assigned', 'In Progress', 'Waiting For', 'Ready for Review', 'Completed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

let isPolling = false;
let bootstrapped = false;
let pollTimer = null;

function normalizeItemCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return raw;
  if (/^NX-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `NX-${String(Number(raw)).padStart(4, '0')}`;
  return raw;
}

function cleanOptionalText(value) {
  return value && String(value).trim() ? String(value).trim() : null;
}

function cleanOptionalDate(value) {
  return value && String(value).trim() ? String(value).trim() : null;
}

function formatDateOnly(value) {
  if (!value) return 'Not set';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function getSetting(key) {
  const result = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return result.rows[0]?.value || null;
}

async function setSetting(key, value) {
  await query(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [key, String(value)]);
}

async function getUserByChatId(chatId) {
  const result = await query(`
    SELECT id, name, email, role, telegram_chat_id
    FROM users
    WHERE is_active = TRUE
      AND telegram_opt_in = TRUE
      AND telegram_chat_id = $1
  `, [String(chatId)]);
  return result.rows[0] || null;
}

async function findActiveUserByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  const lowered = value.toLowerCase();

  const exact = await query(
    `SELECT id, name, email FROM users
     WHERE is_active = TRUE AND (LOWER(email) = $1 OR LOWER(name) = $1)`,
    [lowered]
  );
  if (exact.rows.length === 1) return exact.rows[0];
  if (exact.rows.length > 1) throw new Error(`Multiple users matched '${value}'. Use the email address.`);

  const partial = await query(
    `SELECT id, name, email FROM users
     WHERE is_active = TRUE AND (LOWER(email) LIKE $1 OR LOWER(name) LIKE $1)
     ORDER BY name`,
    [`%${lowered}%`]
  );
  if (partial.rows.length === 1) return partial.rows[0];
  if (partial.rows.length > 1) {
    const names = partial.rows.map((u) => `${u.name} <${u.email}>`).join(', ');
    throw new Error(`Multiple users matched '${value}': ${names}. Use the email address.`);
  }
  return null;
}

async function listMyTasks(user) {
  const result = await query(`
    SELECT i.item_code, i.title, i.status, i.priority, i.due_date, owner.name AS owner_name
    FROM items i
    LEFT JOIN users owner ON owner.id = i.owner_id
    WHERE i.waiting_for_id = $1
      AND i.status <> 'Completed'
    ORDER BY i.due_date ASC NULLS LAST, i.updated_at ASC
    LIMIT 15
  `, [user.id]);

  if (result.rows.length === 0) {
    return 'No open tracker items are currently waiting for you.';
  }

  const lines = [`Open tracker items waiting for you: ${result.rows.length}`, ''];
  for (const item of result.rows) {
    lines.push(`${item.item_code} - ${item.title}`);
    lines.push(`Status: ${item.status} | Priority: ${item.priority} | Due: ${formatDateOnly(item.due_date)}`);
    if (item.owner_name) lines.push(`Owner: ${item.owner_name}`);
    lines.push('');
  }
  lines.push(`Open tracker: ${(process.env.TRACKER_BASE_URL || 'http://ustr-mvm-8134.na.uis.unisys.com:3000').replace(/\/$/, '')}/items`);
  return lines.join('\n');
}

async function completeItem(user, args) {
  const [code, ...noteParts] = args.trim().split(/\s+/);
  const itemCode = normalizeItemCode(code);
  const note = noteParts.join(' ') || 'Marked completed from Telegram.';
  if (!itemCode) return 'Usage: /done NX-0013 optional note';

  const existing = await query('SELECT * FROM items WHERE UPPER(item_code) = $1', [itemCode]);
  const item = existing.rows[0];
  if (!item) return `Item not found: ${itemCode}`;

  await query('UPDATE items SET status=$1, updated_at=NOW() WHERE id=$2', ['Completed', item.id]);
  if (item.status !== 'Completed') {
    await query(`
      INSERT INTO activity_log (item_id, changed_by, old_status, new_status, change_note)
      VALUES ($1, $2, $3, $4, $5)
    `, [item.id, user.id, item.status, 'Completed', note]);
  }

  return `${item.item_code} moved to Completed.`;
}

function parseStatusArgs(args) {
  const parts = args.trim().split(/\s+/);
  const code = normalizeItemCode(parts.shift());
  const rest = parts.join(' ').trim();

  const sortedStatuses = [...STATUSES].sort((a, b) => b.length - a.length);
  const matched = sortedStatuses.find((status) => rest.toLowerCase().startsWith(status.toLowerCase()));
  if (!code || !matched) return null;

  const note = rest.slice(matched.length).trim() || `Status changed to ${matched} from Telegram.`;
  return { code, status: matched, note };
}

async function updateStatus(user, args) {
  const parsed = parseStatusArgs(args);
  if (!parsed) return `Usage: /status NX-0013 In Progress optional note\nAllowed statuses: ${STATUSES.join(', ')}`;

  const existing = await query('SELECT * FROM items WHERE UPPER(item_code) = $1', [parsed.code]);
  const item = existing.rows[0];
  if (!item) return `Item not found: ${parsed.code}`;

  await query('UPDATE items SET status=$1, updated_at=NOW() WHERE id=$2', [parsed.status, item.id]);
  if (item.status !== parsed.status) {
    await query(`
      INSERT INTO activity_log (item_id, changed_by, old_status, new_status, change_note)
      VALUES ($1, $2, $3, $4, $5)
    `, [item.id, user.id, item.status, parsed.status, parsed.note]);
  }

  return `${item.item_code} moved from ${item.status} to ${parsed.status}.`;
}

async function addComment(user, args) {
  const [code, ...commentParts] = args.trim().split(/\s+/);
  const itemCode = normalizeItemCode(code);
  const comment = commentParts.join(' ').trim();
  if (!itemCode || !comment) return 'Usage: /comment NX-0013 your comment text';

  const itemResult = await query('SELECT id, item_code FROM items WHERE UPPER(item_code) = $1', [itemCode]);
  const item = itemResult.rows[0];
  if (!item) return `Item not found: ${itemCode}`;

  await query('INSERT INTO comments (item_id, user_id, comment_text) VALUES ($1, $2, $3)', [item.id, user.id, comment]);
  await query('UPDATE items SET updated_at=NOW() WHERE id=$1', [item.id]);
  return `Comment added to ${item.item_code}.`;
}

function parseCreateArgs(args) {
  const parts = String(args || '').split('|').map((part) => part.trim());
  if (parts.length < 2) return null;
  return {
    title: parts[0],
    waitingFor: parts[1],
    dueDate: parts[2] || null,
    priority: parts[3] || 'Medium',
    description: parts[4] || null
  };
}

async function createItem(user, args) {
  const parsed = parseCreateArgs(args);
  if (!parsed || !parsed.title || !parsed.waitingFor) {
    return [
      'Usage:',
      '/create Title | Waiting For | Due YYYY-MM-DD | Priority | Description',
      '',
      'Example:',
      '/create IC verification pending | Jayaram | 2026-06-20 | Medium | Please verify the IC request.'
    ].join('\n');
  }
  if (!PRIORITIES.includes(parsed.priority)) {
    return `Invalid priority. Allowed: ${PRIORITIES.join(', ')}`;
  }

  const waitingUser = await findActiveUserByIdentifier(parsed.waitingFor);
  if (!waitingUser) return `Waiting For user not found: ${parsed.waitingFor}`;

  const idResult = await query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM items');
  const itemCode = `NX-${String(idResult.rows[0].next_id).padStart(4, '0')}`;

  const result = await query(`
    INSERT INTO items (item_code, title, description, component, priority, status, owner_id, waiting_for_id, due_date, reminder_date, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)
    RETURNING id, item_code
  `, [
    itemCode,
    parsed.title,
    cleanOptionalText(parsed.description),
    COMPONENT_NAME,
    parsed.priority,
    'Waiting For',
    user.id,
    waitingUser.id,
    cleanOptionalDate(parsed.dueDate),
    user.id
  ]);

  const newItem = result.rows[0];
  await notifyWaitingForItem(newItem.id, 'created');
  return `${newItem.item_code} created and assigned in Waiting For to ${waitingUser.name}.`;
}

function helpText(chatId) {
  return [
    'NX Tracker Telegram commands:',
    '',
    '/id - show your Telegram chat ID',
    '/mytasks - list tasks waiting for you',
    '/done NX-0013 optional note - mark item Completed',
    '/status NX-0013 In Progress optional note - change item status',
    '/comment NX-0013 comment text - add comment',
    '/create Title | Waiting For | Due YYYY-MM-DD | Priority | Description - create task',
    '',
    `Your chat ID: ${chatId}`,
    'Ask the tracker admin to add this chat ID in the Users page and enable Telegram reminders.'
  ].join('\n');
}

async function handleCommand(chatId, text) {
  const trimmed = String(text || '').trim();
  const commandMatch = trimmed.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!commandMatch) return null;

  const command = commandMatch[1].toLowerCase();
  const args = commandMatch[2] || '';

  if (command === 'start' || command === 'help') return helpText(chatId);
  if (command === 'id') return `Your Telegram chat ID is: ${chatId}`;

  const user = await getUserByChatId(chatId);
  if (!user) {
    return [
      'Your Telegram account is not linked to an active NX Tracker user yet.',
      `Chat ID: ${chatId}`,
      '',
      'Ask the tracker admin to open Users page, paste this value in Telegram Chat ID, and enable Telegram reminders.'
    ].join('\n');
  }

  switch (command) {
    case 'mytasks': return listMyTasks(user);
    case 'done': return completeItem(user, args);
    case 'status': return updateStatus(user, args);
    case 'comment': return addComment(user, args);
    case 'create': return createItem(user, args);
    default: return helpText(chatId);
  }
}

async function processUpdate(update) {
  if (!update.message || !update.message.chat) return;
  const chatId = update.message.chat.id;
  const text = update.message.text;
  if (!text) return;

  try {
    const response = await handleCommand(String(chatId), text);
    if (response) await sendTelegramMessage(chatId, response);
  } catch (err) {
    console.error('Telegram command failed:', err.message);
    await sendTelegramMessage(chatId, `Command failed: ${err.message}`);
  }
}

async function bootstrapOffset() {
  const existing = await getSetting('telegram_last_update_id');
  if (existing) return Number(existing);

  const updates = await getTelegramUpdates(null, 0);
  const maxUpdateId = updates.reduce((max, update) => Math.max(max, update.update_id || 0), 0);
  if (maxUpdateId > 0) await setSetting('telegram_last_update_id', maxUpdateId);
  return maxUpdateId;
}

async function pollOnce() {
  if (isPolling || !isTelegramPollingEnabled()) return;
  isPolling = true;

  try {
    let lastUpdateId = Number(await getSetting('telegram_last_update_id') || 0);
    if (!bootstrapped) {
      lastUpdateId = await bootstrapOffset();
      bootstrapped = true;
    }

    const updates = await getTelegramUpdates(lastUpdateId ? lastUpdateId + 1 : null, 0);
    for (const update of updates) {
      await processUpdate(update);
      if (update.update_id && update.update_id > lastUpdateId) {
        lastUpdateId = update.update_id;
        await setSetting('telegram_last_update_id', lastUpdateId);
      }
    }
  } catch (err) {
    console.error('Telegram polling failed:', err.message);
  } finally {
    isPolling = false;
  }
}

function startTelegramBot() {
  if (!isTelegramPollingEnabled()) {
    if (String(process.env.TELEGRAM_ENABLED || '').toLowerCase() === 'true') {
      console.log('Telegram notifications enabled. Telegram command polling is disabled.');
    }
    return;
  }

  const intervalMs = getTelegramPollIntervalMs();
  console.log(`Telegram command polling enabled. Checking every ${intervalMs / 1000} seconds.`);
  pollOnce();
  pollTimer = setInterval(pollOnce, intervalMs);
}

module.exports = { startTelegramBot };

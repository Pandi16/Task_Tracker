const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const methodOverride = require('method-override');
const { pool, query } = require('./db');
const { initDb } = require('./initDb');
const { createNotification, notifyWaitingForItem, startReminderJob } = require('./notifications');
const { startTelegramBot } = require('./telegramBot');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.APP_PORT || 3000);

const COMPONENT_NAME = 'NX/Services';
const STATUSES = ['New', 'Triaged', 'Assigned', 'In Progress', 'Waiting For', 'Ready for Review', 'Completed'];
const CREATE_STATUSES = ['Waiting For', 'In Progress', 'Ready for Review', 'Completed', 'New'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const ROLES = ['member', 'viewer', 'admin'];
const SUPER_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
const RECENT_ITEMS_LIMIT = Number(process.env.RECENT_ITEMS_LIMIT || 10);
const API_KEY = process.env.TRACKER_API_KEY || '';
const REMINDER_TIMEZONE = /^[A-Za-z0-9_\/+-]+$/.test(process.env.DAILY_REMINDER_TIMEZONE || '')
  ? process.env.DAILY_REMINDER_TIMEZONE
  : 'Asia/Kolkata';
const TODAY_IN_REMINDER_TIMEZONE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE '${REMINDER_TIMEZONE}')::date`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Only admin can perform this action');
  }
  next();
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({ ok: false, error: 'TRACKER_API_KEY is not configured on the tracker server.' });
  }
  const provided = req.get('x-api-key') || req.query.api_key;
  if (provided !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing API key.' });
  }
  next();
}

function apiError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
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
  if (exact.rows.length > 1) {
    const err = new Error(`Multiple users matched '${value}'. Use the email address.`);
    err.status = 400;
    throw err;
  }

  const partial = await query(
    `SELECT id, name, email FROM users
     WHERE is_active = TRUE AND (LOWER(email) LIKE $1 OR LOWER(name) LIKE $1)
     ORDER BY name`,
    [`%${lowered}%`]
  );
  if (partial.rows.length === 1) return partial.rows[0];
  if (partial.rows.length > 1) {
    const names = partial.rows.map((u) => `${u.name} <${u.email}>`).join(', ');
    const err = new Error(`Multiple users matched '${value}': ${names}. Use the email address.`);
    err.status = 400;
    throw err;
  }
  return null;
}

function normalizeItemCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return raw;
  if (/^NX-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `NX-${String(Number(raw)).padStart(4, '0')}`;
  return raw;
}

function rowToApiItem(row) {
  return {
    id: row.id,
    code: row.item_code,
    title: row.title,
    description: row.description,
    component: row.component,
    priority: row.priority,
    status: row.status,
    owner: row.owner_name || null,
    waitingFor: row.waiting_for_name || null,
    dueDate: formatDateOnly(row.due_date) || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function cleanOptionalId(value) {
  return value ? Number(value) : null;
}

function cleanOptionalText(value) {
  return value && value.trim() ? value.trim() : null;
}

function cleanOptionalDate(value) {
  return value || null;
}

function formatDateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function getDueBadgeLabel(dueState) {
  if (dueState === 'overdue') return 'Overdue';
  if (dueState === 'due_soon') return 'Due soon';
  return '';
}

function itemSelectColumns() {
  return `
    i.*,
    CASE
      WHEN i.due_date IS NOT NULL AND i.due_date < ${TODAY_IN_REMINDER_TIMEZONE_SQL} THEN 'overdue'
      WHEN i.due_date IS NOT NULL AND i.due_date <= ${TODAY_IN_REMINDER_TIMEZONE_SQL} + INTERVAL '1 day' THEN 'due_soon'
      ELSE 'normal'
    END AS due_state
  `;
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.statuses = STATUSES;
  res.locals.createStatuses = CREATE_STATUSES;
  res.locals.priorities = PRIORITIES;
  res.locals.roles = ROLES;
  res.locals.componentName = COMPONENT_NAME;
  res.locals.superAdminEmail = SUPER_ADMIN_EMAIL;
  res.locals.recentItemsLimit = RECENT_ITEMS_LIMIT;
  res.locals.formatDateOnly = formatDateOnly;
  res.locals.getDueBadgeLabel = getDueBadgeLabel;
  next();
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = (email || '').trim().toLowerCase();
  const result = await query('SELECT * FROM users WHERE LOWER(email) = $1 AND is_active = TRUE', [normalizedEmail]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    return res.render('login', { error: 'Invalid email or password' });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireLogin, async (req, res) => {
  const counts = await query(`SELECT status, COUNT(*)::int AS count FROM items WHERE status = ANY($1) GROUP BY status ORDER BY status`, [STATUSES]);
  const waiting = await query(`
    SELECT u.name AS waiting_for, COUNT(i.id)::int AS count, MIN(i.updated_at) AS oldest
    FROM items i
    LEFT JOIN users u ON u.id = i.waiting_for_id
    WHERE i.waiting_for_id IS NOT NULL
      AND i.status <> 'Completed'
    GROUP BY u.name
    ORDER BY count DESC
  `);
  const recent = await query(`
    SELECT ${itemSelectColumns()}, owner.name AS owner_name, waiter.name AS waiting_for_name
    FROM items i
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    ORDER BY i.updated_at DESC
    LIMIT $1
  `, [RECENT_ITEMS_LIMIT]);
  const notifications = await query(`
    SELECT n.*, i.item_code
    FROM notifications n
    LEFT JOIN items i ON i.id = n.item_id
    WHERE n.user_id = $1 AND n.is_read = FALSE
    ORDER BY n.created_at DESC
    LIMIT 5
  `, [req.session.user.id]);

  res.render('dashboard', { counts: counts.rows, waiting: waiting.rows, recent: recent.rows, notifications: notifications.rows });
});

app.get('/items', requireLogin, async (req, res) => {
  const { status, priority, q } = req.query;
  const params = [];
  const where = [];

  if (status) {
    params.push(status);
    where.push(`i.status = $${params.length}`);
  }
  if (priority) {
    params.push(priority);
    where.push(`i.priority = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(i.title ILIKE $${params.length} OR i.item_code ILIKE $${params.length} OR i.component ILIKE $${params.length})`);
  }

  const result = await query(`
    SELECT ${itemSelectColumns()}, owner.name AS owner_name, waiter.name AS waiting_for_name
    FROM items i
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.updated_at DESC
  `, params);

  res.render('items', { items: result.rows, filters: req.query });
});

app.get('/items/new', requireLogin, async (req, res) => {
  const users = await query('SELECT id, name FROM users WHERE is_active = TRUE ORDER BY name');
  res.render('item-form', { item: { component: COMPONENT_NAME, status: 'Waiting For' }, users: users.rows, mode: 'create', error: null });
});

app.post('/items', requireLogin, async (req, res) => {
  const { title, description, priority, status, owner_id, waiting_for_id, due_date } = req.body;
  const finalStatus = status || 'Waiting For';

  if (finalStatus === 'Waiting For' && !waiting_for_id) {
    const users = await query('SELECT id, name FROM users WHERE is_active = TRUE ORDER BY name');
    return res.status(400).render('item-form', {
      item: { title, description, priority, status: finalStatus, owner_id: cleanOptionalId(owner_id), due_date, component: COMPONENT_NAME },
      users: users.rows,
      mode: 'create',
      error: 'Please select a Waiting For user when status is Waiting For.'
    });
  }

  const idResult = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM items`);
  const itemCode = `NX-${String(idResult.rows[0].next_id).padStart(4, '0')}`;

  const result = await query(`
    INSERT INTO items (item_code, title, description, component, priority, status, owner_id, waiting_for_id, due_date, reminder_date, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)
    RETURNING id, item_code
  `, [
    itemCode,
    title.trim(),
    cleanOptionalText(description),
    COMPONENT_NAME,
    priority || 'Medium',
    finalStatus,
    cleanOptionalId(owner_id),
    cleanOptionalId(waiting_for_id),
    cleanOptionalDate(due_date),
    req.session.user.id
  ]);

  const newItem = result.rows[0];
  if (owner_id) {
    await createNotification(owner_id, newItem.id, `${newItem.item_code} has been assigned to you.`);
  }
  if (waiting_for_id) {
    await notifyWaitingForItem(newItem.id, 'created');
  }

  res.redirect(`/items/${newItem.id}`);
});

app.get('/items/:id/edit', requireLogin, async (req, res) => {
  const itemResult = await query('SELECT * FROM items WHERE id = $1', [req.params.id]);
  const item = itemResult.rows[0];
  if (!item) return res.status(404).send('Item not found');

  const users = await query('SELECT id, name FROM users WHERE is_active = TRUE ORDER BY name');
  res.render('item-form', { item, users: users.rows, mode: 'edit', error: null });
});

app.get('/items/:id', requireLogin, async (req, res) => {
  const itemResult = await query(`
    SELECT ${itemSelectColumns()}, owner.name AS owner_name, waiter.name AS waiting_for_name, creator.name AS created_by_name
    FROM items i
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users creator ON creator.id = i.created_by
    WHERE i.id = $1
  `, [req.params.id]);

  if (!itemResult.rows[0]) return res.status(404).send('Item not found');

  const users = await query('SELECT id, name FROM users WHERE is_active = TRUE ORDER BY name');
  const comments = await query(`
    SELECT c.*, COALESCE(u.name, 'Deleted user') AS user_name
    FROM comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.item_id = $1
    ORDER BY c.created_at ASC
  `, [req.params.id]);
  const logs = await query(`
    SELECT l.*, COALESCE(u.name, 'Deleted user') AS changed_by_name
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.changed_by
    WHERE l.item_id = $1
    ORDER BY l.created_at DESC
  `, [req.params.id]);

  res.render('item-detail', { item: itemResult.rows[0], users: users.rows, comments: comments.rows, logs: logs.rows, error: null });
});

async function updateItem(req, res) {
  const existingResult = await query('SELECT * FROM items WHERE id = $1', [req.params.id]);
  const existing = existingResult.rows[0];
  if (!existing) return res.status(404).send('Item not found');

  const { title, description, priority, status, owner_id, waiting_for_id, due_date, change_note } = req.body;

  if (status === 'Waiting For' && !waiting_for_id) {
    return res.status(400).send('Please select a Waiting For user when status is Waiting For.');
  }

  await query(`
    UPDATE items
    SET title=$1, description=$2, component=$3, priority=$4, status=$5, owner_id=$6, waiting_for_id=$7,
        due_date=$8, reminder_date=NULL, updated_at=NOW()
    WHERE id=$9
  `, [
    title.trim(),
    cleanOptionalText(description),
    COMPONENT_NAME,
    priority,
    status,
    cleanOptionalId(owner_id),
    cleanOptionalId(waiting_for_id),
    cleanOptionalDate(due_date),
    req.params.id
  ]);

  if (existing.status !== status) {
    await query(`
      INSERT INTO activity_log (item_id, changed_by, old_status, new_status, change_note)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.params.id, req.session.user.id, existing.status, status, cleanOptionalText(change_note)]);
  }

  if (existing.owner_id !== cleanOptionalId(owner_id) && owner_id) {
    await createNotification(owner_id, req.params.id, `${existing.item_code} has been assigned to you.`);
  }

  const newWaitingForId = cleanOptionalId(waiting_for_id);
  if (newWaitingForId && existing.waiting_for_id !== newWaitingForId) {
    await notifyWaitingForItem(req.params.id, existing.waiting_for_id ? 'updated' : 'created');
  }

  res.redirect(`/items/${req.params.id}`);
}

app.post('/items/:id/update', requireLogin, updateItem);
app.put('/items/:id', requireLogin, updateItem);

app.post('/items/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  const item = await query('SELECT item_code FROM items WHERE id = $1', [req.params.id]);
  if (!item.rows[0]) return res.status(404).send('Item not found');

  await query('DELETE FROM items WHERE id = $1', [req.params.id]);
  res.redirect('/items');
});

app.post('/items/:id/comments', requireLogin, async (req, res) => {
  const { comment_text } = req.body;
  if (comment_text?.trim()) {
    await query('INSERT INTO comments (item_id, user_id, comment_text) VALUES ($1, $2, $3)', [req.params.id, req.session.user.id, comment_text.trim()]);
    await query('UPDATE items SET updated_at = NOW() WHERE id = $1', [req.params.id]);
  }
  res.redirect(`/items/${req.params.id}`);
});

app.get('/waiting', requireLogin, async (req, res) => {
  const result = await query(`
    SELECT ${itemSelectColumns()}, waiter.name AS waiting_for_name, owner.name AS owner_name
    FROM items i
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users owner ON owner.id = i.owner_id
    WHERE i.waiting_for_id IS NOT NULL
      AND i.status <> 'Completed'
    ORDER BY waiter.name, i.due_date ASC NULLS LAST, i.updated_at ASC
  `);
  res.render('waiting', { items: result.rows });
});

app.post('/notifications/:id/read', requireLogin, async (req, res) => {
  await query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
  res.redirect('/');
});

app.get('/profile', requireLogin, (req, res) => {
  res.render('profile', { error: null, success: null });
});

app.post('/profile/password', requireLogin, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const userId = req.session.user.id;
  const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const user = userResult.rows[0];

  if (!user || !(await bcrypt.compare(current_password || '', user.password_hash))) {
    return res.status(400).render('profile', { error: 'Current password is incorrect.', success: null });
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('profile', { error: 'New password must be at least 8 characters.', success: null });
  }
  if (new_password !== confirm_password) {
    return res.status(400).render('profile', { error: 'New password and confirmation do not match.', success: null });
  }

  const hash = await bcrypt.hash(new_password, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  res.render('profile', { error: null, success: 'Password changed successfully.' });
});

app.get('/users', requireLogin, requireAdmin, async (req, res) => {
  const users = await query('SELECT id, name, email, role, is_active, telegram_chat_id, telegram_opt_in, created_at FROM users ORDER BY name');
  res.render('users', { users: users.rows, error: null, success: null });
});

app.post('/users', requireLogin, requireAdmin, async (req, res) => {
  const { name, email, role, password, telegram_chat_id, telegram_opt_in } = req.body;
  const normalizedEmail = (email || '').trim().toLowerCase();
  try {
    const duplicate = await query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (duplicate.rows.length > 0) {
      throw new Error('A user with this email already exists.');
    }

    const hash = await bcrypt.hash(password, 10);
    await query('INSERT INTO users (name, email, role, password_hash, is_active, telegram_chat_id, telegram_opt_in) VALUES ($1, $2, $3, $4, TRUE, $5, $6)', [name.trim(), normalizedEmail, role || 'member', hash, cleanOptionalText(telegram_chat_id), Boolean(telegram_opt_in)]);
    res.redirect('/users');
  } catch (err) {
    const users = await query('SELECT id, name, email, role, is_active, telegram_chat_id, telegram_opt_in, created_at FROM users ORDER BY name');
    res.status(400).render('users', { users: users.rows, error: err.message, success: null });
  }
});

app.post('/users/:id/update', requireLogin, requireAdmin, async (req, res) => {
  const { name, email, role, telegram_chat_id, telegram_opt_in } = req.body;
  const userId = Number(req.params.id);

  if (!ROLES.includes(role)) {
    return res.status(400).send('Invalid role');
  }

  const normalizedEmail = (email || '').trim().toLowerCase();
  const duplicate = await query('SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2', [normalizedEmail, userId]);
  if (duplicate.rows.length > 0) {
    return res.status(400).send('A different user already has this email.');
  }

  await query(
    'UPDATE users SET name=$1, email=$2, role=$3, telegram_chat_id=$4, telegram_opt_in=$5 WHERE id=$6',
    [name.trim(), normalizedEmail, role, cleanOptionalText(telegram_chat_id), Boolean(telegram_opt_in), userId]
  );

  if (req.session.user.id === userId) {
    req.session.user.name = name.trim();
    req.session.user.email = normalizedEmail;
    req.session.user.role = role;
  }

  res.redirect('/users');
});

app.post('/users/:id/password', requireLogin, async (req, res) => {
  const userId = Number(req.params.id);
  const { password } = req.body;
  const canResetAnyPassword = String(req.session.user.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
  const isOwnAccount = req.session.user.id === userId;

  if (!canResetAnyPassword && !isOwnAccount) {
    return res.status(403).send(`Only ${SUPER_ADMIN_EMAIL} can reset another user's password.`);
  }
  if (!password || password.trim().length < 8) {
    return res.status(400).send('Password must be at least 8 characters.');
  }

  const hash = await bcrypt.hash(password.trim(), 10);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);

  if (isOwnAccount && req.get('referer') && req.get('referer').includes('/profile')) {
    return res.redirect('/profile');
  }
  res.redirect('/users');
});

app.post('/users/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);

  if (req.session.user.id === userId) {
    return res.status(400).send('You cannot delete your own logged-in account.');
  }

  const target = await query('SELECT email FROM users WHERE id = $1', [userId]);
  if (!target.rows[0]) return res.status(404).send('User not found');
  if (String(target.rows[0].email || '').toLowerCase() === SUPER_ADMIN_EMAIL) {
    return res.status(400).send(`The main admin account (${SUPER_ADMIN_EMAIL}) cannot be deleted.`);
  }

  await query('BEGIN');
  try {
    await query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await query('UPDATE items SET owner_id = NULL WHERE owner_id = $1', [userId]);
    await query('UPDATE items SET waiting_for_id = NULL WHERE waiting_for_id = $1', [userId]);
    await query('UPDATE items SET created_by = NULL WHERE created_by = $1', [userId]);
    await query('UPDATE activity_log SET changed_by = NULL WHERE changed_by = $1', [userId]);
    await query('UPDATE comments SET user_id = NULL WHERE user_id = $1', [userId]);
    await query('DELETE FROM daily_digest_log WHERE user_id = $1', [userId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }

  res.redirect('/users');
});


// API used by OpenClaw / automation clients. Keep this behind TRACKER_API_KEY.
app.get('/api/openclaw/health', requireApiKey, async (req, res) => {
  res.json({ ok: true, app: 'NX Services Tracker', version: '1.0.8' });
});

app.get('/api/openclaw/users', requireApiKey, async (req, res) => {
  const result = await query('SELECT id, name, email, role FROM users WHERE is_active = TRUE ORDER BY name');
  res.json({ ok: true, users: result.rows });
});

app.get('/api/openclaw/items', requireApiKey, async (req, res) => {
  const { status, q, waitingFor, owner, limit } = req.query;
  const params = [];
  const where = [];

  if (status) {
    params.push(status);
    where.push(`i.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(i.title ILIKE $${params.length} OR i.item_code ILIKE $${params.length} OR i.description ILIKE $${params.length})`);
  }
  if (waitingFor) {
    params.push(`%${String(waitingFor).toLowerCase()}%`);
    where.push(`(LOWER(waiter.name) LIKE $${params.length} OR LOWER(waiter.email) LIKE $${params.length})`);
  }
  if (owner) {
    params.push(`%${String(owner).toLowerCase()}%`);
    where.push(`(LOWER(owner.name) LIKE $${params.length} OR LOWER(owner.email) LIKE $${params.length})`);
  }

  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 100);
  params.push(safeLimit);

  const result = await query(`
    SELECT i.*, owner.name AS owner_name, waiter.name AS waiting_for_name
    FROM items i
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.updated_at DESC
    LIMIT $${params.length}
  `, params);

  res.json({ ok: true, items: result.rows.map(rowToApiItem) });
});

app.post('/api/openclaw/items', requireApiKey, async (req, res) => {
  try {
    const {
      title,
      description,
      priority = 'Medium',
      status = 'Waiting For',
      owner,
      ownerEmail,
      waitingFor,
      waitingForEmail,
      dueDate,
      createdBy,
      createdByEmail
    } = req.body || {};

    if (!title || !String(title).trim()) return apiError(res, 400, 'title is required');
    if (!STATUSES.includes(status)) return apiError(res, 400, `Invalid status. Allowed: ${STATUSES.join(', ')}`);
    if (!PRIORITIES.includes(priority)) return apiError(res, 400, `Invalid priority. Allowed: ${PRIORITIES.join(', ')}`);

    const ownerUser = await findActiveUserByIdentifier(ownerEmail || owner);
    const waitingUser = await findActiveUserByIdentifier(waitingForEmail || waitingFor);
    const creatorUser = await findActiveUserByIdentifier(createdByEmail || createdBy);

    const idResult = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM items`);
    const itemCode = `NX-${String(idResult.rows[0].next_id).padStart(4, '0')}`;

    const result = await query(`
      INSERT INTO items (item_code, title, description, component, priority, status, owner_id, waiting_for_id, due_date, reminder_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)
      RETURNING id, item_code
    `, [
      itemCode,
      String(title).trim(),
      cleanOptionalText(description),
      COMPONENT_NAME,
      priority,
      status,
      ownerUser?.id || null,
      waitingUser?.id || null,
      cleanOptionalDate(dueDate),
      creatorUser?.id || null
    ]);

    const newItem = result.rows[0];
    if (ownerUser?.id) await createNotification(ownerUser.id, newItem.id, `${newItem.item_code} has been assigned to you.`);
    if (waitingUser?.id) await notifyWaitingForItem(newItem.id, 'created');

    res.status(201).json({ ok: true, item: { id: newItem.id, code: newItem.item_code } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/openclaw/items/:code/status', requireApiKey, async (req, res) => {
  try {
    const itemCode = normalizeItemCode(req.params.code);
    const { status, changeNote, changedBy, changedByEmail } = req.body || {};
    if (!STATUSES.includes(status)) return apiError(res, 400, `Invalid status. Allowed: ${STATUSES.join(', ')}`);

    const existingResult = await query('SELECT * FROM items WHERE UPPER(item_code) = $1', [itemCode]);
    const existing = existingResult.rows[0];
    if (!existing) return apiError(res, 404, 'Item not found');

    const changedByUser = await findActiveUserByIdentifier(changedByEmail || changedBy);
    await query('UPDATE items SET status=$1, updated_at=NOW() WHERE id=$2', [status, existing.id]);

    if (existing.status !== status) {
      await query(`
        INSERT INTO activity_log (item_id, changed_by, old_status, new_status, change_note)
        VALUES ($1, $2, $3, $4, $5)
      `, [existing.id, changedByUser?.id || null, existing.status, status, cleanOptionalText(changeNote)]);
    }

    res.json({ ok: true, item: { id: existing.id, code: existing.item_code, oldStatus: existing.status, newStatus: status } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/openclaw/items/:code/waiting-for', requireApiKey, async (req, res) => {
  try {
    const itemCode = normalizeItemCode(req.params.code);
    const waitingUser = await findActiveUserByIdentifier(req.body?.waitingForEmail || req.body?.waitingFor);
    if (!waitingUser) return apiError(res, 400, 'waitingFor or waitingForEmail must match one active user');

    const existingResult = await query('SELECT * FROM items WHERE UPPER(item_code) = $1', [itemCode]);
    const existing = existingResult.rows[0];
    if (!existing) return apiError(res, 404, 'Item not found');

    await query('UPDATE items SET waiting_for_id=$1, updated_at=NOW() WHERE id=$2', [waitingUser.id, existing.id]);
    if (existing.waiting_for_id !== waitingUser.id) {
      await notifyWaitingForItem(existing.id, existing.waiting_for_id ? 'updated' : 'created');
    }

    res.json({ ok: true, item: { id: existing.id, code: existing.item_code, waitingFor: waitingUser.name, waitingForEmail: waitingUser.email } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/openclaw/items/:code/comment', requireApiKey, async (req, res) => {
  try {
    const itemCode = normalizeItemCode(req.params.code);
    const { comment, user, userEmail } = req.body || {};
    if (!comment || !String(comment).trim()) return apiError(res, 400, 'comment is required');

    const itemResult = await query('SELECT id, item_code FROM items WHERE UPPER(item_code) = $1', [itemCode]);
    const item = itemResult.rows[0];
    if (!item) return apiError(res, 404, 'Item not found');

    const commentUser = await findActiveUserByIdentifier(userEmail || user);
    await query('INSERT INTO comments (item_id, user_id, comment_text) VALUES ($1, $2, $3)', [item.id, commentUser?.id || null, String(comment).trim()]);
    await query('UPDATE items SET updated_at=NOW() WHERE id=$1', [item.id]);

    res.json({ ok: true, item: { id: item.id, code: item.item_code } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/openclaw/items/:code/complete', requireApiKey, async (req, res) => {
  try {
    const itemCode = normalizeItemCode(req.params.code);
    const { changeNote, changedBy, changedByEmail } = req.body || {};
    const existingResult = await query('SELECT * FROM items WHERE UPPER(item_code) = $1', [itemCode]);
    const existing = existingResult.rows[0];
    if (!existing) return apiError(res, 404, 'Item not found');

    const changedByUser = await findActiveUserByIdentifier(changedByEmail || changedBy);
    await query('UPDATE items SET status=$1, updated_at=NOW() WHERE id=$2', ['Completed', existing.id]);

    if (existing.status !== 'Completed') {
      await query(`
        INSERT INTO activity_log (item_id, changed_by, old_status, new_status, change_note)
        VALUES ($1, $2, $3, $4, $5)
      `, [existing.id, changedByUser?.id || null, existing.status, 'Completed', cleanOptionalText(changeNote)]);
    }

    res.json({ ok: true, item: { id: existing.id, code: existing.item_code, oldStatus: existing.status, newStatus: 'Completed' } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

initDb()
  .then(() => {
    startReminderJob();
    startTelegramBot();
    app.listen(PORT, '0.0.0.0', () => console.log(`NX Services Tracker running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const methodOverride = require('method-override');
const { pool, query } = require('./db');
const { initDb } = require('./initDb');
const { createNotification, notifyWaitingForItem, startReminderJob } = require('./notifications');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.APP_PORT || 3000);

const STATUSES = ['New', 'Triaged', 'Assigned', 'In Progress', 'Waiting For', 'Ready for Review', 'Completed', 'Blocked', 'Reopened', 'Cancelled'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const ROLES = ['member', 'viewer', 'admin'];

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

function cleanOptionalId(value) {
  return value ? Number(value) : null;
}

function cleanOptionalText(value) {
  return value && value.trim() ? value.trim() : null;
}

function cleanOptionalDate(value) {
  return value || null;
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.statuses = STATUSES;
  res.locals.priorities = PRIORITIES;
  res.locals.roles = ROLES;
  next();
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await query('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('login', { error: 'Invalid email or password' });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireLogin, async (req, res) => {
  const counts = await query(`SELECT status, COUNT(*)::int AS count FROM items GROUP BY status ORDER BY status`);
  const waiting = await query(`
    SELECT u.name AS waiting_for, COUNT(i.id)::int AS count, MIN(i.updated_at) AS oldest
    FROM items i
    LEFT JOIN users u ON u.id = i.waiting_for_id
    WHERE i.status = 'Waiting For'
    GROUP BY u.name
    ORDER BY count DESC
  `);
  const recent = await query(`
    SELECT i.*, owner.name AS owner_name, waiter.name AS waiting_for_name
    FROM items i
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    ORDER BY i.updated_at DESC
    LIMIT 8
  `);
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
    SELECT i.*, owner.name AS owner_name, waiter.name AS waiting_for_name
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
  res.render('item-form', { item: {}, users: users.rows, mode: 'create' });
});

app.post('/items', requireLogin, async (req, res) => {
  const { title, description, component, priority, status, owner_id, waiting_for_id, due_date, reminder_date } = req.body;

  const idResult = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM items`);
  const itemCode = `NX-${String(idResult.rows[0].next_id).padStart(4, '0')}`;

  const result = await query(`
    INSERT INTO items (item_code, title, description, component, priority, status, owner_id, waiting_for_id, due_date, reminder_date, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id, item_code
  `, [
    itemCode,
    title.trim(),
    cleanOptionalText(description),
    cleanOptionalText(component),
    priority || 'Medium',
    status || 'New',
    cleanOptionalId(owner_id),
    cleanOptionalId(waiting_for_id),
    cleanOptionalDate(due_date),
    cleanOptionalDate(reminder_date),
    req.session.user.id
  ]);

  const newItem = result.rows[0];
  if (owner_id) {
    await createNotification(owner_id, newItem.id, `${newItem.item_code} has been assigned to you.`);
  }
  if (status === 'Waiting For' && waiting_for_id) {
    await notifyWaitingForItem(newItem.id, 'created');
  }

  res.redirect(`/items/${newItem.id}`);
});

app.get('/items/:id/edit', requireLogin, async (req, res) => {
  const itemResult = await query('SELECT * FROM items WHERE id = $1', [req.params.id]);
  const item = itemResult.rows[0];
  if (!item) return res.status(404).send('Item not found');

  const users = await query('SELECT id, name FROM users WHERE is_active = TRUE ORDER BY name');
  res.render('item-form', { item, users: users.rows, mode: 'edit' });
});

app.get('/items/:id', requireLogin, async (req, res) => {
  const itemResult = await query(`
    SELECT i.*, owner.name AS owner_name, waiter.name AS waiting_for_name, creator.name AS created_by_name
    FROM items i
    LEFT JOIN users owner ON owner.id = i.owner_id
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users creator ON creator.id = i.created_by
    WHERE i.id = $1
  `, [req.params.id]);

  if (!itemResult.rows[0]) return res.status(404).send('Item not found');

  const users = await query('SELECT id, name FROM users WHERE is_active = TRUE ORDER BY name');
  const comments = await query(`
    SELECT c.*, u.name AS user_name
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.item_id = $1
    ORDER BY c.created_at ASC
  `, [req.params.id]);
  const logs = await query(`
    SELECT l.*, u.name AS changed_by_name
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.changed_by
    WHERE l.item_id = $1
    ORDER BY l.created_at DESC
  `, [req.params.id]);

  res.render('item-detail', { item: itemResult.rows[0], users: users.rows, comments: comments.rows, logs: logs.rows });
});

async function updateItem(req, res) {
  const existingResult = await query('SELECT * FROM items WHERE id = $1', [req.params.id]);
  const existing = existingResult.rows[0];
  if (!existing) return res.status(404).send('Item not found');

  const { title, description, component, priority, status, owner_id, waiting_for_id, due_date, reminder_date, change_note } = req.body;

  await query(`
    UPDATE items
    SET title=$1, description=$2, component=$3, priority=$4, status=$5, owner_id=$6, waiting_for_id=$7,
        due_date=$8, reminder_date=$9, updated_at=NOW()
    WHERE id=$10
  `, [
    title.trim(),
    cleanOptionalText(description),
    cleanOptionalText(component),
    priority,
    status,
    cleanOptionalId(owner_id),
    cleanOptionalId(waiting_for_id),
    cleanOptionalDate(due_date),
    cleanOptionalDate(reminder_date),
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

  if (status === 'Waiting For' && waiting_for_id && (existing.status !== 'Waiting For' || existing.waiting_for_id !== cleanOptionalId(waiting_for_id))) {
    await notifyWaitingForItem(req.params.id, existing.status === 'Waiting For' ? 'updated' : 'created');
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
    SELECT i.*, waiter.name AS waiting_for_name, owner.name AS owner_name
    FROM items i
    LEFT JOIN users waiter ON waiter.id = i.waiting_for_id
    LEFT JOIN users owner ON owner.id = i.owner_id
    WHERE i.status = 'Waiting For'
    ORDER BY waiter.name, i.updated_at ASC
  `);
  res.render('waiting', { items: result.rows });
});

app.post('/notifications/:id/read', requireLogin, async (req, res) => {
  await query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
  res.redirect('/');
});

app.get('/users', requireLogin, requireAdmin, async (req, res) => {
  const users = await query('SELECT id, name, email, role, is_active, created_at FROM users ORDER BY is_active DESC, name');
  res.render('users', { users: users.rows, error: null });
});

app.post('/users', requireLogin, requireAdmin, async (req, res) => {
  const { name, email, role, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await query('INSERT INTO users (name, email, role, password_hash, is_active) VALUES ($1, $2, $3, $4, TRUE)', [name.trim(), email.trim(), role || 'member', hash]);
    res.redirect('/users');
  } catch (err) {
    const users = await query('SELECT id, name, email, role, is_active, created_at FROM users ORDER BY is_active DESC, name');
    res.render('users', { users: users.rows, error: err.message });
  }
});

app.post('/users/:id/update', requireLogin, requireAdmin, async (req, res) => {
  const { name, email, role, password } = req.body;
  const userId = Number(req.params.id);

  if (!ROLES.includes(role)) {
    return res.status(400).send('Invalid role');
  }

  if (password && password.trim()) {
    const hash = await bcrypt.hash(password.trim(), 10);
    await query(
      'UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4 WHERE id=$5',
      [name.trim(), email.trim(), role, hash, userId]
    );
  } else {
    await query(
      'UPDATE users SET name=$1, email=$2, role=$3 WHERE id=$4',
      [name.trim(), email.trim(), role, userId]
    );
  }

  if (req.session.user.id === userId) {
    req.session.user.name = name.trim();
    req.session.user.email = email.trim();
    req.session.user.role = role;
  }

  res.redirect('/users');
});

app.post('/users/:id/deactivate', requireLogin, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (req.session.user.id === userId) {
    return res.status(400).send('You cannot deactivate your own account while logged in.');
  }

  await query('UPDATE users SET is_active = FALSE WHERE id = $1', [userId]);
  res.redirect('/users');
});

app.post('/users/:id/activate', requireLogin, requireAdmin, async (req, res) => {
  await query('UPDATE users SET is_active = TRUE WHERE id = $1', [req.params.id]);
  res.redirect('/users');
});

initDb()
  .then(() => {
    startReminderJob();
    app.listen(PORT, '0.0.0.0', () => console.log(`NX Services Tracker running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });

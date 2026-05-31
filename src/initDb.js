const bcrypt = require('bcryptjs');
const { query } = require('./db');
require('dotenv').config();

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(180) UNIQUE NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'member',
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      item_code VARCHAR(30) UNIQUE NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      component VARCHAR(120),
      priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
      status VARCHAR(40) NOT NULL DEFAULT 'New',
      owner_id INTEGER REFERENCES users(id),
      waiting_for_id INTEGER REFERENCES users(id),
      due_date DATE,
      reminder_date DATE,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      comment_text TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      changed_by INTEGER REFERENCES users(id),
      old_status VARCHAR(40),
      new_status VARCHAR(40),
      change_note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const existing = await query('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (existing.rows.length === 0) {
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    const hash = await bcrypt.hash(password, 10);
    await query(
      'INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, $3, $4)',
      [process.env.ADMIN_NAME || 'Admin', adminEmail, 'admin', hash]
    );
  }
}

module.exports = { initDb };

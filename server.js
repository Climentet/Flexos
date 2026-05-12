const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const helmet = require('helmet');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const PgSession = require('connect-pg-simple')(session);

const app = express();

const ALLOWED_PARTICIPANTS = [
  'Gykas Coleman',
  'Legionario Makri',
  'Bochenko Matamoros',
  'Dei V',
  'Clayment',
  'THE F*KING BERNI',
  'Kekong Kekongo'
];

const usePostgres = Boolean(process.env.DATABASE_URL);
const isProduction = process.env.NODE_ENV === 'production';

const pgPool = usePostgres
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' || !isProduction ? false : { rejectUnauthorized: false }
    })
  : null;

const sqliteDb = usePostgres ? null : new sqlite3.Database(path.join(__dirname, 'data.db'));

app.use(helmet());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Use PostgreSQL session store in production, memory store for development
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
};

if (usePostgres) {
  sessionConfig.store = new PgSession({
    pool: pgPool,
    tableName: 'session',
    ttl: 1000 * 60 * 60 * 24 // 24 hours
  });
}

app.use(session(sessionConfig));

function normalizeParticipant(name) {
  const value = String(name || '').trim();
  if (value === 'Dei v:' || value === 'Dei V:') return 'Dei V';
  if (value.startsWith('Pola')) return 'Pola';
  return value;
}

function query(sql, params = []) {
  if (usePostgres) {
    return pgPool.query(sql, params);
  }

  return new Promise((resolve, reject) => {
    const isSelect = /^\s*select/i.test(sql);
    if (isSelect) {
      sqliteDb.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve({ rows });
      });
      return;
    }

    sqliteDb.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes, rows: [] });
    });
  });
}

async function initDatabase() {
  if (usePostgres) {
    // Create session table for connect-pg-simple
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid varchar NOT NULL COLLATE "default",
        sess json NOT NULL,
        expire timestamp(6) NOT NULL,
        PRIMARY KEY (sid)
      )
    `);
    
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS entries (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        exercise TEXT NOT NULL,
        count INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgPool.query(`DELETE FROM entries WHERE NOT (name = ANY($1::text[]))`, [ALLOWED_PARTICIPANTS]);
    await pgPool.query(`UPDATE entries SET name = 'Dei V' WHERE name IN ('Dei v:', 'Dei V:')`);
    await pgPool.query(`UPDATE entries SET name = 'Pola' WHERE name ILIKE 'Pola%'`);
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      exercise TEXT NOT NULL,
      count INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const placeholders = ALLOWED_PARTICIPANTS.map(() => '?').join(',');
  await query(`DELETE FROM entries WHERE name NOT IN (${placeholders})`, ALLOWED_PARTICIPANTS);
  await query(`UPDATE entries SET name = 'Dei V' WHERE name IN ('Dei v:', 'Dei V:')`);
  await query(`UPDATE entries SET name = 'Pola' WHERE name LIKE 'Pola%'`);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function requirePageAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/');
}

app.post('/login', (req, res) => {
  const pw = req.body.password;
  const PASS = process.env.CHALLENGE_PASSWORD || 'Makrichonda';
  if (pw === PASS) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/app.html', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/app.js', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

app.use('/api', requireAuth);

app.get('/api/ranking', async (req, res) => {
  try {
    const ex = req.query.exercise;
    let sql;
    let params;

    if (ex === 'abdominales' || ex === 'flexiones') {
      sql = usePostgres
        ? `SELECT name, SUM(count) AS total
           FROM entries
           WHERE exercise = $1 AND name = ANY($2::text[])
           GROUP BY name
           ORDER BY total DESC`
        : `SELECT name, SUM(count) as total
           FROM entries
           WHERE exercise = ? AND name IN (${ALLOWED_PARTICIPANTS.map(() => '?').join(',')})
           GROUP BY name
           ORDER BY total DESC`;
      params = usePostgres ? [ex, ALLOWED_PARTICIPANTS] : [ex, ...ALLOWED_PARTICIPANTS];
    } else {
      sql = usePostgres
        ? `SELECT name,
             SUM(CASE WHEN exercise='abdominales' THEN count ELSE 0 END) AS abdominales,
             SUM(CASE WHEN exercise='flexiones' THEN count ELSE 0 END) AS flexiones,
             SUM(count) AS total
           FROM entries
           WHERE name = ANY($1::text[])
           GROUP BY name
           ORDER BY total DESC`
        : `SELECT name,
             SUM(CASE WHEN exercise='abdominales' THEN count ELSE 0 END) as abdominales,
             SUM(CASE WHEN exercise='flexiones' THEN count ELSE 0 END) as flexiones,
             SUM(count) as total
           FROM entries
           WHERE name IN (${ALLOWED_PARTICIPANTS.map(() => '?').join(',')})
           GROUP BY name
           ORDER BY total DESC`;
      params = usePostgres ? [ALLOWED_PARTICIPANTS] : [...ALLOWED_PARTICIPANTS];
    }

    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/entry', async (req, res) => {
  try {
    const { name, exercise, count } = req.body;
    if (!name || !exercise || !count) return res.status(400).json({ error: 'missing' });

    const participant = normalizeParticipant(name);
    if (!ALLOWED_PARTICIPANTS.includes(participant)) {
      return res.status(400).json({ error: 'invalid participant' });
    }

    const c = parseInt(count, 10);
    if (Number.isNaN(c) || c <= 0) return res.status(400).json({ error: 'invalid count' });

    const sql = usePostgres
      ? 'INSERT INTO entries (name, exercise, count) VALUES ($1, $2, $3) RETURNING id'
      : 'INSERT INTO entries (name, exercise, count) VALUES (?,?,?)';
    const params = [participant, exercise, c];

    const result = await query(sql, params);
    const insertedId = usePostgres ? result.rows[0].id : result.lastID;
    res.json({ ok: true, id: insertedId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });

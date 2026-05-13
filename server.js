const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const helmet = require('helmet');
const webpush = require('web-push');
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

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@operacion-pollon.local';
const runtimeVapidKeys = (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY)
  ? webpush.generateVAPIDKeys()
  : null;

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || runtimeVapidKeys.publicKey;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || runtimeVapidKeys.privateKey;

webpush.setVapidDetails(VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey);

if (runtimeVapidKeys) {
  console.warn('VAPID keys were auto-generated. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in env for persistent subscriptions.');
}

async function getSubscriptions() {
  const sql = usePostgres
    ? `SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions`
    : `SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions`;
  const { rows } = await query(sql);
  return rows.map((row) => ({
    endpoint: row.endpoint,
    keys: {
      p256dh: row.keys_p256dh,
      auth: row.keys_auth
    }
  }));
}

async function saveSubscription(subscription) {
  if (!subscription || !subscription.endpoint || !subscription.keys) return;
  const params = [
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth
  ];

  if (usePostgres) {
    await query(
      `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint)
       DO UPDATE SET keys_p256dh = EXCLUDED.keys_p256dh, keys_auth = EXCLUDED.keys_auth, updated_at = NOW()`,
      params
    );
    return;
  }

  await query(
    `INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, created_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    params
  );
}

async function deleteSubscription(endpoint) {
  if (!endpoint) return;
  const sql = usePostgres
    ? `DELETE FROM push_subscriptions WHERE endpoint = $1`
    : `DELETE FROM push_subscriptions WHERE endpoint = ?`;
  await query(sql, [endpoint]);
}

async function sendPushToAll(payload) {
  const subscriptions = await getSubscriptions();
  if (!subscriptions.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        sent += 1;
      } catch (error) {
        failed += 1;
        if (error.statusCode === 404 || error.statusCode === 410) {
          await deleteSubscription(subscription.endpoint);
        }
      }
    })
  );

  return { sent, failed };
}

function rankIndex(rows, name) {
  return rows.findIndex((row) => row.name === name);
}

function findOvertaken(beforeRows, afterRows, name) {
  const beforePos = rankIndex(beforeRows, name);
  const afterPos = rankIndex(afterRows, name);
  if (beforePos === -1 || afterPos === -1 || afterPos >= beforePos) return null;

  const beforeAhead = new Set(beforeRows.slice(0, beforePos).map((row) => row.name));
  const nowBehind = afterRows.slice(afterPos + 1).map((row) => row.name);
  return nowBehind.find((candidate) => beforeAhead.has(candidate)) || null;
}

async function getExerciseRanking(exercise) {
  const sql = usePostgres
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
  const params = usePostgres ? [exercise, ALLOWED_PARTICIPANTS] : [exercise, ...ALLOWED_PARTICIPANTS];
  const { rows } = await query(sql, params);
  return rows;
}

function buildAutoPushMessage({ name, exercise, count, beforeRows, afterRows }) {
  const newRank = rankIndex(afterRows, name);
  const overtaken = findOvertaken(beforeRows, afterRows, name);
  const movement = rankIndex(beforeRows, name) - newRank;
  const exLabel = exercise === 'abdominales' ? 'abdominales' : 'flexiones';

  if (overtaken) {
    return `${name} mete ${count} ${exLabel} y adelanta a ${overtaken}.`;
  }

  if (movement > 0) {
    return `${name} sube ${movement} puestos con ${count} ${exLabel}.`;
  }

  if (count >= 50) {
    return `${name} la esta partiendo con ${count} ${exLabel}.`;
  }

  return `${name} suma ${count} ${exLabel} al marcador.`;
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
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id BIGSERIAL PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
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
  await query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
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

app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'invalid subscription' });
    }

    await saveSubscription(subscription);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });
    await deleteSubscription(endpoint);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/push/broadcast', async (req, res) => {
  try {
    const title = String(req.body.title || 'OPERACION POLLON').slice(0, 64);
    const message = String(req.body.message || '').slice(0, 160);
    const url = String(req.body.url || '/app.html');

    if (!message) return res.status(400).json({ error: 'missing message' });

    const result = await sendPushToAll({
      title,
      body: message,
      url
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

    const beforeRows = await getExerciseRanking(exercise);

    const sql = usePostgres
      ? 'INSERT INTO entries (name, exercise, count) VALUES ($1, $2, $3) RETURNING id'
      : 'INSERT INTO entries (name, exercise, count) VALUES (?,?,?)';
    const params = [participant, exercise, c];

    const result = await query(sql, params);
    const insertedId = usePostgres ? result.rows[0].id : result.lastID;

    const afterRows = await getExerciseRanking(exercise);
    const autoBody = buildAutoPushMessage({
      name: participant,
      exercise,
      count: c,
      beforeRows,
      afterRows
    });

    await sendPushToAll({
      title: 'OPERACION POLLON',
      body: autoBody,
      url: '/app.html'
    });

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

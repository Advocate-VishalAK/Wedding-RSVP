const path = require('path');
const express = require('express');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0655';

// Local dev: falls back to a local SQLite file. Production (Render): point these
// env vars at your Turso database so data survives restarts/redeploys.
const db = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: 'file:' + path.join(__dirname, 'wedding.db') }
);

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS families (
      phone TEXT PRIMARY KEY,
      side TEXT,
      rsvp INTEGER,
      travel_mode TEXT,
      members TEXT,
      flight_details TEXT,
      return_ticket TEXT,
      timestamp INTEGER,
      head_name TEXT
    )
  `);
  try {
    await db.execute('ALTER TABLE families ADD COLUMN head_name TEXT');
  } catch (e) {
    // column already exists on databases created before this field was added
  }
}

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

function rowToRecord(row) {
  return {
    phone: row.phone,
    side: row.side,
    rsvp: !!row.rsvp,
    travelMode: row.travel_mode,
    members: row.members ? JSON.parse(row.members) : [],
    flightDetails: row.flight_details ? JSON.parse(row.flight_details) : null,
    returnTicket: row.return_ticket,
    timestamp: row.timestamp
  };
}

function requireAdmin(req, res, next) {
  const pass = req.get('x-admin-password') || req.query.pass;
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect admin password' });
  }
  next();
}

const app = express();
app.use(express.json());

app.post('/api/save', async (req, res) => {
  const { phone, side, rsvp, travelMode, members, flightDetails, returnTicket } = req.body || {};
  if (!/^\d{10}$/.test(phone || '')) {
    return res.status(400).json({ error: 'Valid 10-digit phone number required' });
  }
  const timestamp = Date.now();
  const headName = normalizeName(members && members[0] && members[0].name);
  await db.execute({
    sql: `
      INSERT INTO families (phone, side, rsvp, travel_mode, members, flight_details, return_ticket, timestamp, head_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        side=excluded.side, rsvp=excluded.rsvp, travel_mode=excluded.travel_mode,
        members=excluded.members, flight_details=excluded.flight_details,
        return_ticket=excluded.return_ticket, timestamp=excluded.timestamp, head_name=excluded.head_name
    `,
    args: [
      phone,
      side || null,
      rsvp ? 1 : 0,
      travelMode || null,
      JSON.stringify(members || []),
      flightDetails ? JSON.stringify(flightDetails) : null,
      returnTicket || null,
      timestamp,
      headName || null
    ]
  });
  res.json({ ok: true, timestamp });
});

app.get('/api/check/:phone', async (req, res) => {
  const phone = req.params.phone;
  if (!/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Valid 10-digit phone number required' });
  }
  const result = await db.execute({ sql: 'SELECT * FROM families WHERE phone = ?', args: [phone] });
  if (result.rows.length === 0) return res.status(404).json({ found: false });
  res.json({ found: true, record: rowToRecord(result.rows[0]) });
});

app.get('/api/check-by-name/:name', async (req, res) => {
  const name = normalizeName(req.params.name);
  if (!name) return res.json({ found: false });
  const result = await db.execute({
    sql: 'SELECT * FROM families WHERE head_name = ? ORDER BY timestamp DESC LIMIT 1',
    args: [name]
  });
  if (result.rows.length === 0) return res.json({ found: false });
  res.json({ found: true, record: rowToRecord(result.rows[0]) });
});

app.get('/api/all', requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT * FROM families ORDER BY timestamp DESC');
  res.json({ records: result.rows.map(rowToRecord) });
});

app.get('/api/export.csv', requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT * FROM families ORDER BY timestamp DESC');
  const records = result.rows.map(rowToRecord);
  const rows = [['Phone', 'Side', 'RSVP', 'Travel Mode', 'Member Name', 'Relation', 'DOB', 'Gender', 'Govt ID', 'Berth', 'Return Ticket']];
  records.forEach(r => {
    if (r.members && r.members.length) {
      r.members.forEach(m => {
        rows.push([r.phone, r.side, r.rsvp, r.travelMode, m.name, m.relation || 'Head', m.dob, m.gender, m.govId, m.berth, r.returnTicket]);
      });
    } else {
      rows.push([r.phone, r.side, r.rsvp, r.travelMode, '', '', '', '', '', '', r.returnTicket]);
    }
  });
  const csv = rows.map(row => row.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wedding-rsvps.csv"');
  res.send(csv);
});

app.use(express.static(path.join(__dirname, 'public')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Wedding RSVP server listening on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});

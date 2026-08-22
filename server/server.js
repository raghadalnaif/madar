// =========================================================
//  مدارك — خادم تخزين بيانات متعدد المدارس (Multi-tenant)
//  كل مدرسة (Tenant) لها بياناتها المعزولة تماماً: تسجّل أو
//  يضيفها مزوّد الخدمة، ثم تسجّل دخولها باسم مستخدم وكلمة مرور
//  خاصين بها. مزوّد الخدمة (المدير العام للمنصة) يتحكم بنوع
//  العضوية (روضة / حضانة - دار ضيافة / مدرسة بكل مراحلها) ومدة
//  الاشتراك (فصل أول/ثاني أو أشهر) وتفعيل/تعليق كل مدرسة.
//  تخزين key→value في SQLite لكل مدرسة + مزامنة لحظية عبر SSE.
// =========================================================
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
// PLATFORM_TOKEN: سرّ مزوّد الخدمة (صاحب المنصة) — يدير كل المدارس.
// نُبقي دعم اسم المتغيّر القديم API_TOKEN لتوافقيّة الإعداد الحالي.
const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN || process.env.API_TOKEN || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const BODY_LIMIT = process.env.BODY_LIMIT || '30mb'; // يكفي للمرفقات base64
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // صلاحية جلسة المدرسة: 30 يوماً

if (!PLATFORM_TOKEN) {
  console.error('[madarek-api] ⚠️  PLATFORM_TOKEN (أو API_TOKEN) غير محدد — اضبطه في متغيرات البيئة قبل التشغيل.');
  process.exit(1);
}

// ---------- قاعدة البيانات ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    contact_person TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    membership_type TEXT DEFAULT 'school',
    term_type TEXT DEFAULT '',
    sub_start TEXT DEFAULT '',
    sub_end TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    notes TEXT DEFAULT '',
    created_at INTEGER
  );
`);

// ---------- ترحيل: تحويل جدول kv القديم (بدون فصل مدارس) إلى tenant افتراضي ----------
(function migrateLegacyKv() {
  const cols = db.prepare("PRAGMA table_info(kv)").all();
  const hasTenantId = cols.some(c => c.name === 'tenant_id');
  if (cols.length && !hasTenantId) {
    db.exec('ALTER TABLE kv RENAME TO kv_legacy');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (tenant_id, key)
    );
  `);
  const legacyExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv_legacy'").get();
  if (legacyExists) {
    const rows = db.prepare('SELECT key, value, updated_at FROM kv_legacy').all();
    if (rows.length) {
      const existingDefault = db.prepare('SELECT id FROM tenants WHERE id = ?').get('default');
      if (!existingDefault) {
        const password = crypto.randomBytes(9).toString('base64url');
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(password, salt, 64).toString('hex');
        db.prepare(`INSERT INTO tenants
          (id,name,username,password_hash,salt,contact_person,phone,email,membership_type,term_type,sub_start,sub_end,status,notes,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run('default', 'المدرسة الحالية (تم ترحيلها)', 'madarek', hash, salt, '', '', '', 'school', 'full_year', '', '', 'active', 'تم إنشاؤها تلقائياً أثناء الترحيل من نظام المدرسة الواحدة', Date.now());
        const line = `\n[madarek-api] تم ترحيل بياناتك القديمة إلى مدرسة افتراضية.\n  اسم المستخدم: madarek\n  كلمة المرور: ${password}\n  (يمكن تغييرها لاحقاً من لوحة مزوّد الخدمة)\n`;
        console.log(line);
        try { fs.writeFileSync(path.join(__dirname, 'default-tenant-credentials.txt'), line, { mode: 0o600 }); } catch (e) {}
      }
      const insertKv = db.prepare('INSERT OR REPLACE INTO kv (tenant_id,key,value,updated_at) VALUES (?,?,?,?)');
      const tx = db.transaction((list) => { for (const r of list) insertKv.run('default', r.key, r.value, r.updated_at); });
      tx(rows);
      db.exec('DROP TABLE kv_legacy');
      console.log(`[madarek-api] تم ترحيل ${rows.length} سجلاً من التخزين القديم إلى المدرسة الافتراضية (default).`);
    } else {
      db.exec('DROP TABLE kv_legacy');
    }
  }
})();

const qGetAllForTenant = db.prepare('SELECT key, value FROM kv WHERE tenant_id = ?');
const qUpsert = db.prepare(
  'INSERT INTO kv(tenant_id, key, value, updated_at) VALUES(?, ?, ?, ?) ' +
  'ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
);

// ---------- سرّ توقيع الجلسات (يُنشأ مرة ويُحفظ في قاعدة البيانات) ----------
function getSessionSecret() {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('session_secret');
  if (row) return row.v;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('session_secret', secret);
  return secret;
}
const SESSION_SECRET = getSessionSecret();

function signToken(tenantId) {
  const payload = Buffer.from(JSON.stringify({ tid: tenantId, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.tid || !data.exp || data.exp < Date.now()) return null;
    return data.tid;
  } catch (e) { return null; }
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function bearerFrom(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
}

function tenantToPublic(t) {
  return {
    id: t.id, name: t.name, username: t.username, contactPerson: t.contact_person, phone: t.phone, email: t.email,
    membershipType: t.membership_type, termType: t.term_type, subStart: t.sub_start, subEnd: t.sub_end,
    status: t.status, notes: t.notes, createdAt: t.created_at,
  };
}
function subscriptionActive(t) {
  if (t.status !== 'active') return false;
  if (t.sub_end && t.sub_end < todayStr()) return false;
  return true;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ---------- التطبيق ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: BODY_LIMIT }));
// CORS: التوثيق يعتمد على Bearer token في كل طلب (لا كوكيز)، فالسماح بأصول متعددة هنا آمن.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// توثيق مزوّد الخدمة (صاحب المنصة) — سرّ واحد ثابت
function platformAuth(req, res, next) {
  if (bearerFrom(req) !== PLATFORM_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}
// توثيق مدرسة (Tenant) — توكن موقّع صادر عن /api/tenant/login
function tenantAuth(req, res, next) {
  const tid = verifyToken(bearerFrom(req));
  if (!tid) return res.status(401).json({ error: 'unauthorized' });
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  if (!t) return res.status(401).json({ error: 'unauthorized' });
  if (!subscriptionActive(t)) return res.status(403).json({ error: 'subscription_inactive', tenant: tenantToPublic(t) });
  req.tenantId = tid;
  next();
}

// =========================================================
//  تسجيل / دخول المدارس
// =========================================================
app.post('/api/tenant/register', (req, res) => {
  const { name, contactPerson, phone, email, membershipType, username, password } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'missing_fields' });
  if (String(password).length < 6) return res.status(400).json({ error: 'weak_password' });
  const validTypes = ['nursery', 'kindergarten', 'school'];
  const mtype = validTypes.includes(membershipType) ? membershipType : 'school';
  const uname = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(uname)) return res.status(400).json({ error: 'invalid_username' });
  const exists = db.prepare('SELECT id FROM tenants WHERE username = ?').get(uname);
  if (exists) return res.status(409).json({ error: 'username_taken' });
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  db.prepare(`INSERT INTO tenants
    (id,name,username,password_hash,salt,contact_person,phone,email,membership_type,term_type,sub_start,sub_end,status,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, String(name).trim(), uname, hash, salt, contactPerson || '', phone || '', email || '', mtype, '', '', '', 'pending', '', Date.now());
  res.json({ ok: true, status: 'pending' });
});

app.post('/api/tenant/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  const t = db.prepare('SELECT * FROM tenants WHERE username = ?').get(uname);
  if (!t) return res.status(401).json({ error: 'invalid_credentials' });
  const hash = hashPassword(password || '', t.salt);
  if (hash !== t.password_hash) return res.status(401).json({ error: 'invalid_credentials' });
  const token = signToken(t.id);
  res.json({ ok: true, token, tenant: tenantToPublic(t), active: subscriptionActive(t) });
});

// =========================================================
//  لوحة مزوّد الخدمة — إدارة المدارس المشتركة في المنصة
// =========================================================
app.get('/api/platform/tenants', platformAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  res.json(rows.map(tenantToPublic));
});

app.post('/api/platform/tenants', platformAuth, (req, res) => {
  const { name, contactPerson, phone, email, membershipType, termType, subStart, subEnd, status, username, password } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'missing_fields' });
  const uname = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(uname)) return res.status(400).json({ error: 'invalid_username' });
  const exists = db.prepare('SELECT id FROM tenants WHERE username = ?').get(uname);
  if (exists) return res.status(409).json({ error: 'username_taken' });
  const validTypes = ['nursery', 'kindergarten', 'school'];
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  db.prepare(`INSERT INTO tenants
    (id,name,username,password_hash,salt,contact_person,phone,email,membership_type,term_type,sub_start,sub_end,status,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, String(name).trim(), uname, hash, salt, contactPerson || '', phone || '', email || '',
        validTypes.includes(membershipType) ? membershipType : 'school', termType || '', subStart || '', subEnd || '',
        ['active', 'pending', 'suspended'].includes(status) ? status : 'active', '', Date.now());
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  res.json({ ok: true, tenant: tenantToPublic(t) });
});

app.put('/api/platform/tenants/:id', platformAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const validTypes = ['nursery', 'kindergarten', 'school'];
  const next = {
    name: b.name !== undefined ? String(b.name).trim() : t.name,
    contact_person: b.contactPerson !== undefined ? b.contactPerson : t.contact_person,
    phone: b.phone !== undefined ? b.phone : t.phone,
    email: b.email !== undefined ? b.email : t.email,
    membership_type: validTypes.includes(b.membershipType) ? b.membershipType : t.membership_type,
    term_type: b.termType !== undefined ? b.termType : t.term_type,
    sub_start: b.subStart !== undefined ? b.subStart : t.sub_start,
    sub_end: b.subEnd !== undefined ? b.subEnd : t.sub_end,
    status: ['active', 'pending', 'suspended'].includes(b.status) ? b.status : t.status,
    notes: b.notes !== undefined ? b.notes : t.notes,
  };
  db.prepare(`UPDATE tenants SET name=?,contact_person=?,phone=?,email=?,membership_type=?,term_type=?,sub_start=?,sub_end=?,status=?,notes=? WHERE id=?`)
    .run(next.name, next.contact_person, next.phone, next.email, next.membership_type, next.term_type, next.sub_start, next.sub_end, next.status, next.notes, t.id);
  if (b.password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(b.password, salt);
    db.prepare('UPDATE tenants SET password_hash=?, salt=? WHERE id=?').run(hash, salt, t.id);
  }
  const updated = db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id);
  res.json({ ok: true, tenant: tenantToPublic(updated) });
});

// ---------- مزامنة لحظية (SSE) — لكل مدرسة قناة مستقلة ----------
const clients = new Map(); // clientId -> { res, tenantId }

app.get('/api/stream', (req, res) => {
  const tid = verifyToken((req.query.token || '').toString());
  if (!tid) return res.status(401).end();
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  if (!t || !subscriptionActive(t)) return res.status(403).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // مهم: يمنع nginx من حجز البث
  });
  res.flushHeaders();
  const id = (req.query.clientId || crypto.randomUUID()).toString();
  clients.set(id, { res, tenantId: tid });
  res.write('retry: 3000\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ clientId: id })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(id); });
});

function broadcast(tenantId, key, value, exceptId) {
  const payload = `data: ${JSON.stringify({ key, value })}\n\n`;
  for (const [id, c] of clients) {
    if (id === exceptId || c.tenantId !== tenantId) continue;
    try { c.res.write(payload); } catch (e) { clients.delete(id); }
  }
}

// ---------- قراءة كل بيانات المدرسة (تحميل أولي) ----------
app.get('/api/data', tenantAuth, (req, res) => {
  const out = {};
  for (const row of qGetAllForTenant.all(req.tenantId)) {
    try { out[row.key] = JSON.parse(row.value); } catch (e) {}
  }
  res.json(out);
});

// ---------- حفظ مجموعة واحدة ----------
app.put('/api/data/:key', tenantAuth, (req, res) => {
  const key = String(req.params.key || '').slice(0, 100);
  if (!key) return res.status(400).json({ error: 'missing key' });
  const value = (req.body && Object.prototype.hasOwnProperty.call(req.body, '__value'))
    ? req.body.__value
    : req.body;
  let str;
  try { str = JSON.stringify(value); } catch (e) { return res.status(400).json({ error: 'bad value' }); }
  qUpsert.run(req.tenantId, key, str, Date.now());
  broadcast(req.tenantId, key, value, req.get('x-client-id') || '');
  res.json({ ok: true });
});

// ---------- نقل جماعي (للترحيل من Firebase دفعة واحدة) ----------
app.post('/api/bulk', tenantAuth, (req, res) => {
  const obj = req.body || {};
  const now = Date.now();
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) qUpsert.run(req.tenantId, k, JSON.stringify(v), now);
  });
  const entries = Object.entries(obj);
  tx(entries);
  for (const [k, v] of entries) broadcast(req.tenantId, k, v, req.get('x-client-id') || '');
  res.json({ ok: true, count: entries.length });
});

app.get('/api/health', (req, res) => {
  const tenantCount = db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
  res.json({ ok: true, tenants: tenantCount, clients: clients.size });
});

app.listen(PORT, HOST, () => {
  console.log(`[madarek-api] يعمل على http://${HOST}:${PORT} — قاعدة البيانات: ${DB_PATH}`);
});

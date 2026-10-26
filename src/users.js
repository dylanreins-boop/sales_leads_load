const crypto = require('node:crypto');
const { HttpError } = require('./leads');

const ROLES = ['admin', 'sales', 'shop'];
const ROLE_LABEL = { admin: 'Admin', sales: 'Sales', shop: 'Shop' };
const MIN_PASSWORD = 8;
const now = () => new Date().toISOString();
const norm = (name) => String(name).trim().toLowerCase();

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

// Logins: the ones set on the server (APP_USERS / APP_PASSWORD) plus the ones admins add in the app.
function createUserService(db, { serverUsers = [] } = {}) {
  const stmt = (sql) => db.prepare(sql);
  // Checking a password is deliberately slow, so remember logins that already checked out.
  const passed = new Map();
  const seen = new Map();

  const get = (id) => stmt('SELECT * FROM users WHERE id = ?').get(id);
  const findByName = (name) => stmt('SELECT * FROM users WHERE name_norm = ?').get(norm(name));
  const anyLogins = () => serverUsers.length > 0 || stmt('SELECT COUNT(*) AS n FROM users').get().n > 0;

  function log(userName, action, detail, byUser) {
    stmt('INSERT INTO user_events (user_name, action, detail, by_user, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userName, action, detail ?? null, byUser ?? null, now());
  }

  function authenticate(name, password) {
    if (!name || password == null) return null;
    // Compare against every server login so timing doesn't reveal which names exist.
    let found = null;
    for (const u of serverUsers) {
      if (safeEqual(norm(name), norm(u.name)) && safeEqual(password, u.password)) found = u;
    }
    if (found) return { name: found.name, role: found.role };

    const user = findByName(name);
    if (!user || !user.active) return null;
    const key = `${user.id}:${user.updated_at}:${crypto.createHash('sha256').update(password).digest('hex')}`;
    if (!passed.has(key)) {
      if (!checkPassword(password, user.password_hash)) return null;
      passed.set(key, true);
    }
    // Record when each person was last in the app (at most once a minute).
    if (Date.now() - (seen.get(user.id) || 0) > 60000) {
      seen.set(user.id, Date.now());
      stmt('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
    }
    return { name: user.name, role: user.role };
  }

  function list() {
    const added = stmt(`SELECT id, name, role, active, created_at, created_by, updated_at, last_seen_at
                        FROM users ORDER BY active DESC, name_norm`).all()
      .map((u) => ({ ...u, active: Boolean(u.active), source: 'app' }));
    const server = serverUsers.map((u) => ({ id: null, name: u.name, role: u.role, active: true, source: 'server' }));
    return [...server, ...added];
  }

  const activeAdmins = () => serverUsers.filter((u) => u.role === 'admin').length
    + stmt("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

  function validRole(role) {
    if (!ROLES.includes(role)) throw new HttpError(400, 'Pick a level: Admin, Sales or Shop.');
    return role;
  }

  function validPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
    }
    return password;
  }

  function create({ name, password, role } = {}, { user: by } = {}) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new HttpError(400, 'Add the person\'s name.');
    if (clean.length > 40) throw new HttpError(400, 'Keep the name under 40 characters.');
    if (clean.includes(':')) throw new HttpError(400, 'Names can\'t contain a colon (:).');
    validRole(role);
    validPassword(password);
    if (serverUsers.some((u) => norm(u.name) === norm(clean)) || findByName(clean)) {
      throw new HttpError(409, `There is already a login named ${clean}. Use a different name, like adding a last initial.`);
    }
    // Without any logins the app is open; the first one added has to be able to manage the rest.
    if (!anyLogins() && role !== 'admin') throw new HttpError(400, 'The first login has to be an Admin.');
    const ts = now();
    const { lastInsertRowid } = stmt(`INSERT INTO users (name, name_norm, password_hash, role, active, created_at, created_by, updated_at)
                                      VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(clean, norm(clean), hashPassword(password), role, ts, by ?? null, ts);
    log(clean, 'created', `Added as ${ROLE_LABEL[role]}`, by);
    return list().find((u) => u.id === Number(lastInsertRowid));
  }

  function update(id, patch = {}, { user: by } = {}) {
    const user = get(id);
    if (!user) throw new HttpError(404, 'That login was not found.');
    const self = by != null && norm(by) === user.name_norm;
    const sets = [];
    const params = [];
    const events = [];

    if ('role' in patch && patch.role !== user.role) {
      validRole(patch.role);
      if (self) throw new HttpError(400, 'You can\'t change your own level. Ask another admin.');
      if (user.role === 'admin' && user.active && activeAdmins() <= 1) throw new HttpError(400, 'Keep at least one admin.');
      sets.push('role = ?');
      params.push(patch.role);
      events.push(['level', `${ROLE_LABEL[user.role]} → ${ROLE_LABEL[patch.role]}`]);
    }
    if ('active' in patch && Boolean(patch.active) !== Boolean(user.active)) {
      if (!patch.active) {
        if (self) throw new HttpError(400, 'You can\'t deactivate your own login.');
        if (user.role === 'admin' && activeAdmins() <= 1) throw new HttpError(400, 'Keep at least one admin.');
      }
      sets.push('active = ?');
      params.push(patch.active ? 1 : 0);
      events.push([patch.active ? 'reactivated' : 'deactivated', patch.active ? 'Can sign in again' : 'Can no longer sign in']);
    }
    if ('password' in patch) {
      validPassword(patch.password);
      sets.push('password_hash = ?');
      params.push(hashPassword(patch.password));
      events.push(['password', self ? 'Changed their password' : 'Password reset']);
    }
    if (!sets.length) return list().find((u) => u.id === id);

    sets.push('updated_at = ?');
    params.push(now(), id);
    stmt(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    for (const [action, detail] of events) log(user.name, action, detail, by);
    return list().find((u) => u.id === id);
  }

  function history(limit = 50) {
    return stmt('SELECT * FROM user_events ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }

  return { authenticate, anyLogins, list, create, update, history };
}

module.exports = { createUserService, ROLES, MIN_PASSWORD, hashPassword, checkPassword };

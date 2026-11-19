const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createUserService } = require('../src/users');
const { createWorkReminders } = require('../src/workreminders');

function setup() {
  const db = openDatabase(':memory:');
  const users = createUserService(db, { serverUsers: [{ name: 'Mike', role: 'shop' }, { name: 'Sam', role: 'sales' }, { name: 'Dylan', role: 'admin' }] });
  const sent = [];
  const push = { sendTo: async (names, m) => { sent.push({ to: names.join(','), title: m.title, url: m.url }); return names; } };
  const reminders = createWorkReminders(db, { users, push });
  const punch = (name, from, to = null) => db.prepare(`INSERT INTO time_punches (name_norm, user_name, clock_in, clock_out, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(name.toLowerCase(), name, from.toISOString(), to && to.toISOString(), from.toISOString());
  return { db, sent, reminders, punch };
}
const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

test('shop logins on the clock get a vehicle sheet reminder every hour; sales logins do not', async () => {
  const { sent, reminders, punch } = setup();
  punch('Mike', at(7, 0));
  punch('Sam', at(7, 0));
  await reminders.run(at(7, 59));
  assert.equal(sent.length, 0, 'not before the first hour');
  await reminders.run(at(8, 0));
  await reminders.run(at(8, 1));
  await reminders.run(at(8, 30));
  assert.deepEqual(sent, [{ to: 'Mike', title: 'Update the vehicle sheet', url: '/' }], 'once for the hour, only the shop');
  await reminders.run(at(9, 2));
  assert.equal(sent.filter((s) => s.title === 'Update the vehicle sheet').length, 2, 'again the next hour');
});

test('lunch pauses the hourly reminder; it starts again an hour after coming back', async () => {
  const { sent, reminders, punch } = setup();
  punch('Mike', at(7, 0), at(11, 30));
  await reminders.run(at(12, 15));
  assert.equal(sent.length, 0, 'nothing while on lunch');
  punch('Mike', at(12, 0));
  await reminders.run(at(12, 45));
  assert.equal(sent.length, 0);
  await reminders.run(at(13, 0));
  assert.equal(sent.length, 1);
});

test('everyone on the clock gets one clock-out reminder at 7.5 hours worked, lunch not counted', async () => {
  const { sent, reminders, punch } = setup();
  punch('Sam', at(7, 0), at(11, 0)); // 4 h, then a 30-minute lunch
  punch('Sam', at(11, 30));
  await reminders.run(at(14, 59));
  assert.equal(sent.length, 0, '7 h 29 m worked');
  await reminders.run(at(15, 0));
  await reminders.run(at(15, 20));
  assert.deepEqual(sent, [{ to: 'Sam', title: 'Time to clock out', url: '/?mytime=1' }]);
  assert.equal(Math.round(reminders.workedToday('Sam', at(15, 0)) * 10) / 10, 7.5);
});

test('nobody off the clock is reminded', async () => {
  const { sent, reminders, punch } = setup();
  punch('Mike', at(7, 0), at(15, 0));
  await reminders.run(at(16, 0));
  assert.equal(sent.length, 0);
});

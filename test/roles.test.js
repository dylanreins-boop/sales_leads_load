const { test } = require('node:test');
const assert = require('node:assert/strict');

// Runs in its own process, so these logins don't affect the other test files.
process.env.APP_USERS = 'Ana:a1:admin, Sam:s1:Sales ,Mike:m1:shop,Lee:l1,Pat:p:2:shop';
process.env.APP_USER = 'office';
process.env.APP_PASSWORD = 'shared';

const config = require('../src/config');

test('logins take an admin, sales or shop level; no level means sales; the shared login is admin', () => {
  const roles = Object.fromEntries(config.users.map((u) => [u.name, [u.password, u.role]]));
  assert.deepEqual(roles, {
    Ana: ['a1', 'admin'], Sam: ['s1', 'sales'], Mike: ['m1', 'shop'], Lee: ['l1', 'sales'], Pat: ['p:2', 'shop'], office: ['shared', 'admin'],
  });
});

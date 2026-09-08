import { DatabaseSync } from 'node:sqlite';

// Existing business tests need an assigned employee. Company assignment itself
// is exercised through real administrator HTTP requests in account-members-server.
export function assignFixtureCompany(dbPath, user) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE account_users SET company = '西浦', version = version + 1 WHERE id = ?").run(user.id);
    return { ...user, company: '西浦', version: db.prepare('SELECT version FROM account_users WHERE id = ?').get(user.id).version };
  } finally { db.close(); }
}

import { DatabaseSync } from 'node:sqlite';

// Existing business tests need an assigned employee. Company assignment itself
// is exercised through real administrator HTTP requests in account-members-server.
export function assignFixtureCompany(dbPath, user) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE account_users SET company = '西浦', version = version + 1 WHERE id = ?").run(user.id);
    db.prepare('DELETE FROM account_user_companies WHERE user_id = ?').run(user.id);
    db.prepare("INSERT INTO account_user_companies(user_id,company) VALUES(?,'西浦')").run(user.id);
    db.exec('COMMIT');
    return { ...user, company: '西浦', companies: ['西浦'], version: db.prepare('SELECT version FROM account_users WHERE id = ?').get(user.id).version };
  } finally { db.close(); }
}

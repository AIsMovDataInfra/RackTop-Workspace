import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupTeamDatabase } from '../../scripts/team-backup.mjs'

test('online backup includes committed WAL and preserves an existing backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'racktop-team-backup-'))
  const source = join(root, 'live.sqlite'), target = join(root, 'backup.sqlite')
  const db = new DatabaseSync(source)
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE reservations(id TEXT, purpose TEXT)')
    db.prepare('INSERT INTO reservations VALUES (?,?)').run('r1','团队预约')
    await backupTeamDatabase(source, target)
    const restored = new DatabaseSync(target, { readOnly: true })
    try { assert.deepEqual({...restored.prepare('SELECT * FROM reservations').get()}, {id:'r1', purpose:'团队预约'}) }
    finally { restored.close() }
    const before = await readFile(target)
    await assert.rejects(backupTeamDatabase(source, target), {code:'EEXIST'})
    assert.deepEqual(await readFile(target), before)
    assert.equal((await stat(target)).mode & 0o777, 0o600)
  } finally { db.close(); await rm(root, {recursive:true,force:true}) }
})

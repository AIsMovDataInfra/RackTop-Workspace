import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, readFile, stat, mkdir, copyFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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


test('backup CLI executes through a current-release directory symlink and refuses to overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'racktop-team-backup-cli-'))
  const release = join(root, 'release'), current = join(root, 'current')
  await mkdir(join(release, 'scripts'), { recursive: true })
  await copyFile(new URL('../../scripts/team-backup.mjs', import.meta.url), join(release, 'scripts', 'team-backup.mjs'))
  await symlink(release, current, 'dir')
  const source = join(root, 'live.sqlite'), entry = join(current, 'scripts', 'team-backup.mjs')
  const db = new DatabaseSync(source), run = promisify(execFile)
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE reservations(id TEXT, purpose TEXT)')
    db.prepare('INSERT INTO reservations VALUES (?,?)').run('r-cli', 'symlink CLI committed WAL')
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      const target = join(root, flags.length ? 'preserved-main.sqlite' : 'normal-main.sqlite')
      const result = await run(process.execPath, [...flags, entry, source, target])
      assert.match(result.stdout, /备份已验证：/)
      assert.equal((await stat(target)).mode & 0o777, 0o600)
      const restored = new DatabaseSync(target, { readOnly: true })
      try { assert.deepEqual({ ...restored.prepare('SELECT * FROM reservations').get() }, { id: 'r-cli', purpose: 'symlink CLI committed WAL' }) }
      finally { restored.close() }
      const before = await readFile(target)
      await assert.rejects(run(process.execPath, [...flags, entry, source, target]), error => error.code === 1 && /EEXIST/.test(error.stderr))
      assert.deepEqual(await readFile(target), before)
    }
    await assert.rejects(run(process.execPath, [entry]), error => error.code === 1 && /用法：/.test(error.stderr))
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

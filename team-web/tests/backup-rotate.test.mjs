import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, readFile, stat, statfs, truncate, mkdir, copyFile, symlink, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { rotateTeamBackup, verifySnapshot, retainedSnapshotNames } from '../../scripts/team-backup-rotate.mjs'

const run = promisify(execFile)
const entry = new URL('../../scripts/team-backup-rotate.mjs', import.meta.url).pathname

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'racktop-rotate-'))
  const source = join(root, 'team.sqlite'), automatic = join(root, 'automatic')
  const db = new DatabaseSync(source)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON;
    CREATE TABLE equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, serial TEXT, weight REAL, note TEXT);
    CREATE TABLE photos (id INTEGER PRIMARY KEY, equipment_id INTEGER REFERENCES equipment(id), data BLOB);
    CREATE TABLE history (id INTEGER PRIMARY KEY, equipment_id INTEGER REFERENCES equipment(id), version INTEGER);`)
  db.prepare('INSERT INTO equipment(name, serial, weight, note) VALUES(?, ?, ?, ?)').run('显微镜', 'LAB-42', 1.5, null)
  db.prepare('INSERT INTO photos VALUES(?, ?, ?)').run(1, 1, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 127, 255, 0xff, 0xd9]))
  db.prepare('INSERT INTO history VALUES(?, ?, ?)').run(1, 1, 9223372036854775806n)
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }) })
  return { root, source, automatic, db }
}

test('automatic snapshot restores committed WAL, all records, large integers and complete photo BLOBs privately', async t => {
  const { source, automatic, db } = await fixture(t)
  assert.ok((await stat(`${source}-wal`)).size > 0)
  const result = await rotateTeamBackup(source, automatic, { now: new Date('2026-09-11T12:00:00Z') })
  const manifest = await verifySnapshot(result.directory)
  assert.equal(manifest.restoreDrill, 'passed')
  assert.equal(manifest.inspection.tables.length, 4)
  assert.deepEqual((await readdir(result.directory)).sort(), ['manifest.json', 'snapshot.sqlite'])
  const photo = manifest.inspection.tables.find(item => item.name === 'photos')
  assert.equal(photo.rows, 1)
  assert.equal(photo.blobBytes, 9)
  assert.equal(photo.blobValues, 1)
  const restored = new DatabaseSync(join(result.directory, 'snapshot.sqlite'), { readOnly: true })
  try {
    assert.deepEqual(restored.prepare('SELECT * FROM photos').get(), db.prepare('SELECT * FROM photos').get())
    const row = restored.prepare('SELECT version FROM history'); row.setReadBigInts(true)
    assert.equal(row.get().version, 9223372036854775806n)
    assert.equal(restored.prepare('SELECT name FROM equipment').get().name, '显微镜')
  } finally { restored.close() }
  for (const path of [automatic, result.directory]) assert.equal((await stat(path)).mode & 0o777, 0o700)
  for (const file of ['snapshot.sqlite', 'manifest.json']) assert.equal((await stat(join(result.directory, file))).mode & 0o777, 0o600)
  const text = await readFile(join(result.directory, 'manifest.json'), 'utf8')
  assert.ok(!text.includes('显微镜') && !text.includes('LAB-42'))
})

test('retention combines 96 recent snapshots with 30 distinct UTC days and 12 distinct UTC months', () => {
  const items = []
  function add(date, suffix = '') { items.push({ createdAt: date.toISOString(), directory: `${date.toISOString()}${suffix}` }) }
  for (let index = 0; index < 150; index++) add(new Date(Date.UTC(2026, 8, 11, 23, 45) - index * 15 * 60 * 1000))
  for (let index = 1; index <= 40; index++) add(new Date(Date.UTC(2026, 8, 11 - index, 12)))
  for (let index = 1; index <= 18; index++) add(new Date(Date.UTC(2026, 8 - index, 15, 12)))
  const selected = retainedSnapshotNames(items.reverse())
  const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const item of sorted.slice(0, 96)) assert.ok(selected.has(item.directory))
  for (const [width, limit] of [[10, 30], [7, 12]]) {
    const representatives = [...new Map(sorted.map(item => [item.createdAt.slice(0, width), null])).keys()].slice(0, limit)
    for (const period of representatives) assert.ok(selected.has(sorted.find(item => item.createdAt.startsWith(period)).directory))
  }
  assert.ok(selected.size <= 96 + 30 + 12)
  assert.ok(!selected.has(sorted.at(-1).directory))
})

async function cloneAt(baseDirectory, automatic, date) {
  const manifest = JSON.parse(await readFile(join(baseDirectory, 'manifest.json'), 'utf8'))
  manifest.createdAt = new Date(date).toISOString()
  manifest.directory = `snapshot-${manifest.createdAt.replace(/[-:.]/g, '')}-${randomUUID()}`
  const directory = join(automatic, manifest.directory)
  await mkdir(directory, { mode: 0o700 })
  await copyFile(join(baseDirectory, 'snapshot.sqlite'), join(directory, 'snapshot.sqlite'))
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  return directory
}

test('only verified owned snapshots outside all retention tiers are removed after a successful snapshot', async t => {
  const { source, automatic } = await fixture(t)
  const base = await rotateTeamBackup(source, automatic, { now: new Date('2026-09-11T23:45:00Z') })
  for (let index = 1; index < 100; index++) await cloneAt(base.directory, automatic, Date.UTC(2026, 8, 11, 23, 45) - index * 15 * 60 * 1000)
  // Enough day/month representatives to age out this obsolete history.
  for (let index = 1; index <= 31; index++) await cloneAt(base.directory, automatic, Date.UTC(2026, 8, 11 - index, 12))
  for (let index = 1; index <= 13; index++) await cloneAt(base.directory, automatic, Date.UTC(2026, 8 - index, 15, 12))
  const manual = join(automatic, 'manual-do-not-touch')
  await mkdir(manual)
  await writeFile(join(manual, 'important.txt'), 'manual backup')
  const result = await rotateTeamBackup(source, automatic, { now: new Date('2026-09-12T00:00:00Z') })
  assert.ok(result.pruned > 0)
  assert.ok(result.retained <= 138)
  assert.equal(await readFile(join(manual, 'important.txt'), 'utf8'), 'manual backup')
  await verifySnapshot(result.directory)
})

test('a malformed recognized snapshot blocks all pruning and keeps the newly verified backup', async t => {
  const { source, automatic } = await fixture(t)
  const first = await rotateTeamBackup(source, automatic)
  const before = await readFile(join(first.directory, 'snapshot.sqlite'))
  const malformed = join(automatic, `snapshot-20200101T000000000Z-${randomUUID()}`)
  await mkdir(malformed, { mode: 0o700 })
  await writeFile(join(malformed, 'manifest.json'), '{}', { mode: 0o600 })
  await assert.rejects(rotateTeamBackup(source, automatic), /Unexpected snapshot directory contents/)
  assert.deepEqual(await readFile(join(first.directory, 'snapshot.sqlite')), before)
  assert.equal(await readFile(join(malformed, 'manifest.json'), 'utf8'), '{}')
  assert.equal((await readdir(automatic)).filter(name => name.startsWith('snapshot-')).length, 3)
  assert.equal((await readdir(automatic)).filter(name => name.startsWith('.staging-')).length, 0)
})

test('corruption or missing source fails nonzero, never overwrites or prunes previous backups', async t => {
  const { root, source, automatic } = await fixture(t)
  const first = await rotateTeamBackup(source, automatic, { now: new Date('2026-09-11T12:00:00Z') })
  const before = await readFile(join(first.directory, 'snapshot.sqlite'))
  const second = await rotateTeamBackup(source, automatic, { now: new Date('2026-09-11T12:00:00Z') })
  assert.notEqual(first.directory, second.directory)
  assert.deepEqual(await readFile(join(first.directory, 'snapshot.sqlite')), before)
  const broken = join(root, 'broken.sqlite')
  await writeFile(broken, 'this is not SQLite')
  for (const badSource of [broken, join(root, 'missing.sqlite')]) {
    await assert.rejects(run(process.execPath, [entry, badSource, automatic]), error => error.code === 1 && /Automatic backup failed/.test(error.stderr))
    assert.deepEqual(await readFile(join(first.directory, 'snapshot.sqlite')), before)
    assert.equal((await readdir(automatic)).length, 2)
  }
  await writeFile(join(second.directory, 'snapshot.sqlite'), 'corrupt snapshot')
  await assert.rejects(run(process.execPath, [entry, '--verify', second.directory]), error => error.code === 1 && /SHA256 mismatch/.test(error.stderr))
  await assert.rejects(rotateTeamBackup(source, automatic), /SHA256 mismatch/)
  assert.deepEqual(await readFile(join(first.directory, 'snapshot.sqlite')), before)
})

test('foreign key failure prevents publication and preserves prior backups', async t => {
  const { source, automatic, db } = await fixture(t)
  const first = await rotateTeamBackup(source, automatic)
  db.exec('PRAGMA foreign_keys=OFF; INSERT INTO photos VALUES(2, 999, X\'FFD8FFD9\')')
  await assert.rejects(rotateTeamBackup(source, automatic), /foreign_key_check failed/)
  assert.deepEqual(await readdir(automatic), [basename(first.directory)])
  await verifySnapshot(first.directory)
})

test('insufficient disk space aborts before staging or pruning and preserves every prior backup', async t => {
  const { root, source, automatic } = await fixture(t)
  const first = await rotateTeamBackup(source, automatic)
  const before = await readFile(join(first.directory, 'snapshot.sqlite'))
  const space = await statfs(root)
  const sparse = join(root, 'sparse-source.sqlite')
  // A sparse test file reserves no data blocks; its logical size exercises the
  // preflight without filling the developer's disk or mocking filesystem I/O.
  await writeFile(sparse, '')
  await truncate(sparse, Math.ceil(space.bavail * space.bsize / 2) + 1)
  await assert.rejects(run(process.execPath, [entry, sparse, automatic]), error => error.code === 1 && /Insufficient backup disk space/.test(error.stderr))
  assert.deepEqual(await readdir(automatic), [basename(first.directory)])
  assert.deepEqual(await readFile(join(first.directory, 'snapshot.sqlite')), before)
})

test('CLI verification works through a release symlink; unsafe destination and forged content are rejected', async t => {
  const { root, source, automatic } = await fixture(t)
  const first = await rotateTeamBackup(source, automatic)
  const link = join(root, 'rotate.mjs')
  await symlink(entry, link)
  const result = await run(process.execPath, [link, '--verify', first.directory])
  assert.equal(JSON.parse(result.stdout).verified, true)
  await assert.rejects(rotateTeamBackup(source, join(root, 'manual')), /dedicated automatic/)
  const redirected = join(root, 'redirected')
  await mkdir(redirected)
  await symlink(automatic, join(redirected, 'automatic'))
  await assert.rejects(rotateTeamBackup(source, join(redirected, 'automatic')), /symlinks/)
  const path = join(first.directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.inspection.tables[0].rows++
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(verifySnapshot(first.directory), /Invalid snapshot inspection manifest/)
  const { logicalSha256, ...details } = manifest.inspection
  manifest.inspection.logicalSha256 = createHash('sha256').update(JSON.stringify(details)).digest('hex')
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(verifySnapshot(first.directory), /logical content mismatch/)
})

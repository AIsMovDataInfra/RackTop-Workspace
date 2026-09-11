import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, statfs, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupTeamDatabase } from './team-backup.mjs'

const OWNER = 'racktop-team-automatic-backup'
const SNAPSHOT = /^snapshot-\d{8}T\d{9}Z-[a-f0-9-]{36}$/
const SHA256 = /^[a-f0-9]{64}$/
const timestamp = date => date.toISOString().replace(/[-:.]/g, '')
const quote = name => `"${name.replaceAll('"', '""')}"`
const hash = value => createHash('sha256').update(value).digest('hex')

async function syncPath(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function fileHash(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

// Type tags and length delimiters distinguish NULL, TEXT, INTEGER, REAL and BLOB.
// Only hashes and aggregate counts leave this function, never row values.
function hashValue(digest, value) {
  let bytes, type
  if (value === null) { type = 'null'; bytes = Buffer.alloc(0) }
  else if (value instanceof Uint8Array) { type = 'blob'; bytes = value }
  else if (typeof value === 'number') { type = 'real'; bytes = Buffer.alloc(8); bytes.writeDoubleBE(value) }
  else { type = typeof value; bytes = Buffer.from(String(value)) }
  digest.update(`${type}:${bytes.length}:`).update(bytes)
}

/** Inspect an isolated snapshot without opening the application or running migrations. */
export function inspectSnapshotDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF')
    const integrity = database.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity_check failed')
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign_key_check failed')
    const schema = database.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name, tbl_name').all()
    const tables = []
    for (const { name } of schema.filter(row => row.type === 'table')) {
      const statement = database.prepare(`SELECT * FROM ${quote(name)}`)
      statement.setReadBigInts(true)
      let blobBytes = 0, blobValues = 0
      const rowHashes = []
      for (const row of statement.iterate()) {
        const digest = createHash('sha256')
        for (const [column, value] of Object.entries(row)) {
          hashValue(digest, column)
          hashValue(digest, value)
          if (value instanceof Uint8Array) { blobBytes += value.byteLength; blobValues++ }
        }
        rowHashes.push(digest.digest('hex'))
      }
      rowHashes.sort()
      const digest = createHash('sha256')
      for (const rowHash of rowHashes) digest.update(rowHash)
      tables.push({ name, rows: rowHashes.length, blobBytes, blobValues, sha256: digest.digest('hex') })
    }
    const details = {
      schemaObjects: schema.length,
      schemaSha256: hash(JSON.stringify(schema)),
      userVersion: database.prepare('PRAGMA user_version').get().user_version,
      applicationId: database.prepare('PRAGMA application_id').get().application_id,
      tables,
    }
    return { ...details, logicalSha256: hash(JSON.stringify(details)) }
  } finally { database.close() }
}

async function requirePrivate(path, directory = false) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Backup path must be a regular file/directory')
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Backup path must be private and owned by the current user')
  return info
}

async function readManifest(directory) {
  if (!SNAPSHOT.test(basename(directory))) throw new Error('Unrecognized automatic snapshot directory')
  await requirePrivate(directory, true)
  const entries = (await readdir(directory)).sort()
  if (JSON.stringify(entries) !== JSON.stringify(['manifest.json', 'snapshot.sqlite'])) throw new Error('Unexpected snapshot directory contents')
  const info = await requirePrivate(join(directory, 'manifest.json'))
  if (info.size > 1024 * 1024) throw new Error('Oversized snapshot manifest')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const created = new Date(manifest.createdAt)
  if (manifest.owner !== OWNER || manifest.version !== 1 || manifest.directory !== basename(directory)
      || !Number.isFinite(created.getTime()) || manifest.createdAt !== created.toISOString()
      || !manifest.directory.startsWith(`snapshot-${timestamp(created)}-`)
      || manifest.database?.file !== 'snapshot.sqlite' || !SHA256.test(manifest.database.sha256)
      || !Number.isSafeInteger(manifest.database.bytes) || manifest.database.bytes <= 0
      || !manifest.inspection || !SHA256.test(manifest.inspection.logicalSha256)
      || manifest.restoreDrill !== 'passed') throw new Error('Invalid automatic snapshot manifest')
  const { logicalSha256, ...details } = manifest.inspection
  if (hash(JSON.stringify(details)) !== logicalSha256 || !Array.isArray(details.tables)
      || !SHA256.test(details.schemaSha256) || !Number.isSafeInteger(details.schemaObjects)
      || details.tables.some(table => typeof table.name !== 'string' || !SHA256.test(table.sha256)
        || ![table.rows, table.blobBytes, table.blobValues].every(value => Number.isSafeInteger(value) && value >= 0))) {
    throw new Error('Invalid snapshot inspection manifest')
  }
  const database = join(directory, 'snapshot.sqlite')
  const databaseInfo = await requirePrivate(database)
  if (databaseInfo.size !== manifest.database.bytes || await fileHash(database) !== manifest.database.sha256) throw new Error('Snapshot SHA256 mismatch')
  return manifest
}

export async function verifySnapshot(directory) {
  const manifest = await readManifest(resolve(directory))
  const actual = inspectSnapshotDatabase(join(directory, 'snapshot.sqlite'))
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inspection)) throw new Error('Snapshot logical content mismatch')
  return manifest
}

/** Keep a union: latest 96 snapshots, latest per UTC day (30), and UTC month (12). */
export function retainedSnapshotNames(manifests) {
  const sorted = [...manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.directory.localeCompare(a.directory))
  const retained = new Set(sorted.slice(0, 96).map(item => item.directory))
  for (const [width, limit] of [[10, 30], [7, 12]]) {
    const periods = new Set()
    for (const item of sorted) {
      const period = item.createdAt.slice(0, width)
      if (!periods.has(period) && periods.size < limit) { periods.add(period); retained.add(item.directory) }
    }
  }
  return retained
}

async function pruneSnapshots(root) {
  const manifests = []
  // Validate every recognized snapshot before deleting anything. Unknown/manual
  // files stay untouched. A malformed or corrupt snapshot blocks all pruning.
  for (const entry of await readdir(root)) {
    if (SNAPSHOT.test(entry)) manifests.push(await readManifest(join(root, entry)))
  }
  const retained = retainedSnapshotNames(manifests)
  let pruned = 0
  for (const manifest of manifests) {
    if (retained.has(manifest.directory)) continue
    const directory = join(root, manifest.directory)
    await unlink(join(directory, 'snapshot.sqlite'))
    await unlink(join(directory, 'manifest.json'))
    await rmdir(directory)
    pruned++
  }
  await syncPath(root)
  return { retained: retained.size, pruned }
}

export async function rotateTeamBackup(source, destination, { now = new Date() } = {}) {
  const root = resolve(destination)
  if (basename(root) !== 'automatic') throw new Error('Backup destination must be a dedicated automatic directory')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (await realpath(root) !== root) throw new Error('Backup destination must not contain symlinks')
  await requirePrivate(root, true)
  const sourceInfo = await lstat(source)
  const walInfo = await lstat(`${source}-wal`).catch(error => { if (error.code !== 'ENOENT') throw error; return { size: 0 } })
  const space = await statfs(root)
  // Need the snapshot and an independent restore-drill copy at the same time.
  // Leave 1 GiB for the live database and system on deployments sharing a disk.
  if (space.bavail * space.bsize < 2 * (sourceInfo.size + walInfo.size) + 1024 * 1024 * 1024) throw new Error('Insufficient backup disk space; existing snapshots preserved')
  const directory = `snapshot-${timestamp(now)}-${randomUUID()}`
  const target = join(root, directory)
  let staging = join(root, `.staging-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    const database = join(staging, 'snapshot.sqlite')
    await backupTeamDatabase(source, database)
    // SQLite's online backup inherits WAL mode. Normalize only the isolated
    // backup so future read-only checks need no WAL/SHM sidecar files.
    const isolated = new DatabaseSync(database, { timeout: 5000 })
    try {
      if (isolated.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') throw new Error('Could not make snapshot self-contained')
    } finally { isolated.close() }
    const inspection = inspectSnapshotDatabase(database)
    const drill = join(staging, 'restore-drill.sqlite')
    await copyFile(database, drill, constants.COPYFILE_EXCL)
    await chmod(drill, 0o600)
    if (JSON.stringify(inspectSnapshotDatabase(drill)) !== JSON.stringify(inspection)) throw new Error('Independent restore drill failed')
    await unlink(drill)
    const manifest = {
      owner: OWNER, version: 1, directory, createdAt: now.toISOString(),
      database: { file: 'snapshot.sqlite', bytes: (await lstat(database)).size, sha256: await fileHash(database) },
      inspection, restoreDrill: 'passed',
    }
    const manifestPath = join(staging, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await syncPath(database)
    await syncPath(manifestPath)
    await syncPath(staging)
    // UUID names and an existence check preserve every existing backup.
    try { await lstat(target); throw new Error('Snapshot target already exists') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await rename(staging, target)
    staging = null
    await syncPath(root)
    const retention = await pruneSnapshots(root)
    return { directory: target, createdAt: manifest.createdAt, sha256: manifest.database.sha256, tables: inspection.tables.length, ...retention }
  } finally {
    // Only this invocation's unpublished staging directory can be removed here.
    if (staging) await rm(staging, { recursive: true, force: true })
  }
}

const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null
if (entryPath && entryPath === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--verify' && args.length === 2) {
      const manifest = await verifySnapshot(args[1])
      console.log(JSON.stringify({ verified: true, directory: manifest.directory, createdAt: manifest.createdAt, sha256: manifest.database.sha256, tables: manifest.inspection.tables.length, restoreDrill: manifest.restoreDrill }))
    } else if (args.length === 0 || (args.length === 2 && !args[0].startsWith('--'))) {
      console.log(JSON.stringify(await rotateTeamBackup(args[0] ?? '/var/lib/racktop-team/team.sqlite', args[1] ?? '/var/backups/racktop-team/automatic')))
    } else { throw new Error('Usage: node team-backup-rotate.mjs [<source.sqlite> <automatic-dir>] | --verify <snapshot-dir>') }
  } catch (error) {
    console.error(`Automatic backup failed: ${error.code || error.message}`)
    process.exitCode = 1
  }
}

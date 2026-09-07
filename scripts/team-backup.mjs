import { DatabaseSync, backup } from 'node:sqlite'
import { open, mkdir, unlink, realpath, chmod } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/** An online SQLite backup includes committed WAL data and refuses to overwrite. */
export async function backupTeamDatabase(source, destination) {
  const sourcePath = await realpath(source)
  const target = resolve(destination)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const exclusive = await open(target, 'wx', 0o600)
  await exclusive.close()
  let database
  try {
    database = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 })
    await backup(database, target)
    const check = new DatabaseSync(target, { readOnly: true })
    try {
      if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('备份完整性检查失败')
    } finally { check.close() }
    await chmod(target, 0o600)
    return target
  } catch (error) {
    await unlink(target).catch(() => {})
    throw error
  } finally { database?.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, target] = process.argv.slice(2)
  if (!source || !target) {
    console.error('用法：node scripts/team-backup.mjs <数据库路径> <新的备份路径>')
    process.exitCode = 1
  } else {
    try { console.log(`备份已验证：${await backupTeamDatabase(source, target)}`) }
    catch (error) { console.error(`备份失败：${error.code || error.message}`); process.exitCode = 1 }
  }
}

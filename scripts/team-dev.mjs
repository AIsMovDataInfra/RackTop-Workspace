import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('团队预约需要 Node.js 24 或更新版本。请使用 Node.js 24 后运行 npm run team:dev。')
  process.exit(1)
}
const cwd = fileURLToPath(new URL('..', import.meta.url))
const children = []
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    process.exit(code)
  }, 4000)
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
    .then(() => { clearTimeout(timer); process.exit(code) })
}
for (const [file, args] of [
  ['team-web/server/server.mjs', []],
  ['node_modules/vite/bin/vite.js', ['--config', 'team-web/vite.config.ts']],
]) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd, stdio: 'inherit',
    env: { ...process.env, TEAM_AUTH_MODE: process.env.TEAM_AUTH_MODE || 'demo', TEAM_HOST: '127.0.0.1', TEAM_PORT: '4318', TEAM_PUBLIC_URL: 'http://127.0.0.1:1421' },
  })
  children.push(child)
  child.on('error', error => { console.error(error.message); stop(1) })
  child.on('exit', code => { if (!stopping) stop(code || 0) })
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

import type { Server, ServerDraft } from '../types/models'

const validHost = (value: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(value) || /^:[a-fA-F0-9:]+$/.test(value)
const validUser = (value: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value)
const validJump = (value: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_.:@,[\]-]*$/.test(value)

/** Only portable connection fields are exported; never serialize a Server. */
export function exportSshConfig(servers: Server[]): string {
  const aliases = new Set<string>()
  return '# RackTop SSH Config\n# Passwords and private keys are not included. Configure your own credentials.\n\n' + servers.map((server, index) => {
    if (!validHost(server.host) || !validUser(server.username) || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) throw new Error(`${server.name} 的连接地址、账号或端口格式无效，请先编辑配置。`)
    const stem = (server.sshAlias || server.name).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[^a-zA-Z0-9_]+|[-.]+$/g, '') || `server-${index + 1}`
    let alias = stem
    for (let suffix = 2; aliases.has(alias.toLowerCase()); suffix += 1) alias = `${stem}-${suffix}`
    aliases.add(alias.toLowerCase())
    let proxy = server.proxyJump?.trim()
    if (proxy) {
      if (!validJump(proxy)) throw new Error(`${server.name} 的跳板机配置包含无法导出的字符。`)
      proxy = proxy.split(',').map((hop) => {
        if (hop.includes('@') || hop.includes(':')) return hop
        const jump = servers.find((candidate) => candidate.sshAlias === hop || candidate.name === hop)
        if (!jump || !validHost(jump.host) || !validUser(jump.username)) throw new Error(`跳板机别名 ${hop} 缺少可共享的地址，请改为 用户名@主机:端口 后导出。`)
        return `${jump.username}@${jump.host.includes(':') ? `[${jump.host}]` : jump.host}:${jump.port}`
      }).join(',')
    }
    return [`# RackTop-Name: ${JSON.stringify(server.name)}`, `Host ${alias}`, `  HostName ${server.host}`, `  User ${server.username}`, `  Port ${server.port}`, ...(proxy ? [`  ProxyJump ${proxy}`] : []), ''].join('\n')
  }).join('\n')
}

/** Imported files never become executable SSH aliases or ProxyCommands. */
export function parseSharedSshConfig(content: string): ServerDraft[] {
  if (content.length > 2 * 1024 * 1024) throw new Error('SSH 配置文件过大（最多 2 MB）。')
  const blocks: Array<Record<string, string>> = []
  let block: Record<string, string> | undefined
  let nextName: string | undefined
  for (const raw of content.split(/\r?\n/)) {
    if (raw.startsWith('# RackTop-Name: ')) {
      try { const name: unknown = JSON.parse(raw.slice(16)); nextName = typeof name === 'string' ? name.slice(0, 24) : undefined } catch { nextName = undefined }
      continue
    }
    const line = raw.split('#')[0].trim()
    const match = /^([^\s=]+)(?:\s*=\s*|\s+)(.+)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      block = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value) ? { alias: value, name: nextName || value } : undefined
      if (block) blocks.push(block)
      nextName = undefined
    } else if (block && ['hostname', 'user', 'port', 'proxyjump'].includes(key)) block[key] ??= value
  }
  return blocks.map((value) => {
    const host = value.hostname || value.alias
    const username = value.user || ''
    const port = Number(value.port || 22)
    if (!validHost(host) || !validUser(username) || !Number.isInteger(port) || port < 1 || port > 65535 || (value.proxyjump && !validJump(value.proxyjump))) throw new Error(`${value.name} 缺少有效的 HostName、User、Port 或 ProxyJump。`)
    return { name: value.name.slice(0, 24), host, username, port, proxyJump: value.proxyjump || '', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'sshAgent', savePassword: false, proxyUsePassword: false, saveProxyPassword: false }
  })
}

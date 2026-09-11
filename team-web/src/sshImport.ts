export interface SshImportServer {
  alias: string
  name: string
  host: string
  port: number
  username: string
  jump: { host: string; port: number; username: string } | null
  enabled: true
}
export interface SshImportIssue { line: number; message: string; messageEn: string }
export interface SshImportResult { servers: SshImportServer[]; issues: SshImportIssue[] }

type Option = { value: string; line: number }
type Block = { alias: string; line: number; name?: string; nameLine?: number; invalid: boolean; options: Map<string, Option>; server?: SshImportServer }
const connectionOptions = new Set(['hostname', 'user', 'port', 'proxyjump'])
// These options never leave the browser. Their values are not copied into diagnostics.
const ignoredOptions = new Set([
  'identityfile', 'identityagent', 'identitiesonly', 'addkeystoagent', 'certificatefile',
  'forwardagent', 'forwardx11', 'forwardx11trusted', 'passwordauthentication', 'pubkeyauthentication',
  'kbdinteractiveauthentication', 'challengeresponseauthentication', 'preferredauthentications',
  'batchmode', 'numberofpasswordprompts', 'stricthostkeychecking', 'userknownhostsfile',
  'globalknownhostsfile', 'checkhostip', 'hashknownhosts', 'hostkeyalias', 'hostkeyalgorithms',
  'pubkeyacceptedalgorithms', 'pubkeyacceptedkeytypes', 'serveraliveinterval', 'serveralivecountmax',
  'connecttimeout', 'connectionattempts', 'compression', 'loglevel', 'requesttty', 'visualhostkey',
  'controlmaster', 'controlpath', 'controlpersist', 'tcpkeepalive',
])
const validAlias = (value: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,252}$/.test(value)
const validUser = (value: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(value)
const validName = (value: string) => Boolean(value.trim()) && [...value.trim()].length <= 24 && !/[\u0000-\u001f\u007f]/.test(value)
const portValue = (value: string) => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : null

function validHost(value: string) {
  if (!value || value.length > 253) return false
  // Match the API's hostname labels; URL validates IPv6 without a Node dependency.
  if (value.split('.').every(label => /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?$/.test(label))) return true
  // '%' has OpenSSH expansion semantics, even in an IPv6 scope suffix. Do not
  // reinterpret it as a literal API address; scoped addresses need manual entry.
  if (!/^[0-9a-fA-F:.]+$/.test(value) || !value.includes(':')) return false
  try { new URL(`http://[${value}]/`); return true } catch { return false }
}

/** Decode values only. No expansion, shell, filesystem, network, or SSH execution. */
function argumentsOf(input: string): string[] | null {
  const tokens: string[] = []
  let token = '', quote = '', started = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '\\') {
      if (++index === input.length) return null
      // OpenSSH keeps backslashes before ordinary characters. Dropping one
      // could turn an invalid/different destination into an accepted hostname.
      const escaped = input[index]
      token += escaped === '\\' || escaped === '"' || escaped === "'" ? escaped : `\\${escaped}`
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char; started = true
    } else if (char === '#') {
      break
    } else if (char === ' ' || char === '\t') {
      if (started) { tokens.push(token); token = ''; started = false }
    } else { token += char; started = true }
  }
  if (quote) return null
  if (started) tokens.push(token)
  return tokens
}

/** A deliberately limited, portable SSH config import, not an OpenSSH evaluator.
 * `issues` includes both rejected-block errors and notices for ignored local options;
 * only independently valid blocks appear in `servers`. Global scope/size errors
 * always return zero servers, so inheritance or limits cannot silently truncate input.
 */
export function parseSshImport(content: string): SshImportResult {
  const issues: SshImportIssue[] = []
  const issue = (line: number, message: string, messageEn: string) => { issues.push({ line, message, messageEn }) }
  if (new TextEncoder().encode(content).byteLength > 1024 * 1024) {
    issue(1, '文件超过 1 MiB，请拆分后重新导入；本次未导入任何服务器。', 'The file exceeds 1 MiB. Split it and import again; no servers were imported.')
    return { servers: [], issues }
  }
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  const privateKeyLine = lines.findIndex(line => /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----|^\s*PuTTY-User-Key-File-[0-9]+:/i.test(line))
  if (privateKeyLine !== -1) {
    issue(privateKeyLine + 1, '检测到私钥文本。请选择只含连接地址的 SSH 配置文件；本次未导入任何服务器。', 'Private-key text was detected. Select an SSH configuration containing connection addresses only; no servers were imported.')
    return { servers: [], issues }
  }
  const invalidControl = lines.findIndex(line => /[\u0000-\u001f\u007f]/.test(line.replace(/\t/g, '')))
  if (invalidControl !== -1) {
    issue(invalidControl + 1, '文件含不支持的控制字符；本次未导入任何服务器。', 'The file contains unsupported control characters; no servers were imported.')
    return { servers: [], issues }
  }
  const blocks: Block[] = []
  let block: Block | undefined
  let pendingName: { value?: string; line: number; invalid: boolean } | undefined
  let rejectFile = false, hostCount = 0
  const reject = (line: number, zh: string, en: string) => {
    issue(line, zh, en)
    if (block) block.invalid = true
    else rejectFile = true
  }
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1, raw = lines[index].trim()
    if (!raw) continue
    const nameComment = /^#\s*RackTop-Name:\s*(.*)$/.exec(raw)
    if (nameComment) {
      let name: unknown
      try { name = JSON.parse(nameComment[1]) } catch { /* Rejected below without echoing input. */ }
      const valid = typeof name === 'string' && validName(name)
      pendingName = { value: valid ? (name as string).trim() : undefined, line, invalid: !valid }
      if (!valid) issue(line, 'RackTop 名称须为有效 JSON 字符串，且为 1–24 个字符；对应 Host 段不导入。', 'The RackTop name must be a JSON string of 1–24 characters; its Host block will not be imported.')
      continue
    }
    if (raw.startsWith('#')) continue
    const directive = /^([a-zA-Z][a-zA-Z0-9]*)(?:[ \t]*=[ \t]*|[ \t]+|$)(.*)$/.exec(raw)
    if (!directive) {
      reject(line, '无法解析此配置行；对应 Host 段不导入。', 'This configuration line cannot be parsed; its Host block will not be imported.')
      continue
    }
    const key = directive[1].toLowerCase()
    // Check scope-changing keywords before decoding their potentially malformed arguments.
    if (key === 'include' || key === 'match') {
      issue(line, '不支持 Include 或 Match 作用域。请提供独立 Host 段；本次未导入任何服务器。', 'Include and Match scopes are unsupported. Provide independent Host blocks; no servers were imported.')
      rejectFile = true
      continue
    }
    const args = argumentsOf(directive[2])
    if (key === 'host') {
      hostCount++
      if (hostCount > 50) {
        issue(line, '文件超过 50 个 Host 段，请拆分后重新导入；本次未导入任何服务器。', 'The file contains more than 50 Host blocks. Split it and import again; no servers were imported.')
        return { servers: [], issues }
      }
      if (!args || args.length !== 1 || !validAlias(args[0])) {
        issue(line, '仅支持一个明确别名的独立 Host 段，不支持通配、否定或多个别名；本次未导入任何服务器。', 'Only independent Host blocks with one concrete alias are supported, without wildcards, negation, or multiple aliases; no servers were imported.')
        rejectFile = true; block = undefined; pendingName = undefined
        continue
      }
      block = { alias: args[0], line, name: pendingName?.value, nameLine: pendingName?.line, invalid: pendingName?.invalid || false, options: new Map() }
      blocks.push(block); pendingName = undefined
      continue
    }
    if (!args || args.length === 0) {
      reject(line, '此配置行的引号或参数无效；对应 Host 段不导入。', 'This configuration line has invalid quotes or arguments; its Host block will not be imported.')
      continue
    }
    if (ignoredOptions.has(key)) {
      issue(line, '已忽略本机认证或连接偏好选项；不会上传路径或凭据，请在各自桌面端配置认证。', 'A local authentication or connection preference was ignored. Paths and credentials are not uploaded; configure authentication on each desktop.')
      continue
    }
    if (!block) {
      issue(line, '不支持 Host 段外的连接默认值，请在每个 Host 段明确填写地址与 User；本次未导入任何服务器。', 'Connection defaults outside Host blocks are unsupported. Set the address and User in each block; no servers were imported.')
      rejectFile = true
      continue
    }
    if (key === 'proxycommand') {
      if (args.length !== 1 || args[0].toLowerCase() !== 'none') reject(line, '不导入使用 ProxyCommand 的 Host 段，请改为明确的单跳 ProxyJump。', 'Host blocks using ProxyCommand are not imported. Use an explicit single-hop ProxyJump instead.')
      else block.options.set(key, { value: 'none', line })
      continue
    }
    if (!connectionOptions.has(key)) {
      reject(line, '此 Host 段包含不支持的指令；请仅保留连接地址和支持的本机认证选项。', 'This Host block contains an unsupported directive. Keep connection addresses and supported local authentication options only.')
      continue
    }
    if (args.length !== 1 || block.options.has(key)) {
      reject(line, '连接字段须只有一个值，且不能重复定义；对应 Host 段不导入。', 'Each connection field must have exactly one value and cannot be defined twice; its Host block will not be imported.')
      continue
    }
    block.options.set(key, { value: args[0], line })
  }
  if (rejectFile) return { servers: [], issues }
  if (!blocks.length) {
    issue(1, '未找到可导入的独立 Host 段。', 'No independent Host blocks were found to import.')
    return { servers: [], issues }
  }
  const aliases = new Map<string, Block[]>()
  for (const entry of blocks) aliases.set(entry.alias.toLowerCase(), [...(aliases.get(entry.alias.toLowerCase()) || []), entry])
  for (const entries of aliases.values()) if (entries.length > 1) {
    for (const entry of entries) {
      entry.invalid = true
      issue(entry.line, 'Host 别名重复，无法确定继承配置；所有同名段均不导入。', 'The Host alias is duplicated, making inherited settings ambiguous; all blocks with this alias are excluded.')
    }
  }
  for (const entry of blocks) {
    if (entry.invalid) continue
    const name = entry.name || entry.alias, host = entry.options.get('hostname')?.value ?? entry.alias
    const username = entry.options.get('user')?.value || '', port = portValue(entry.options.get('port')?.value ?? '22')
    if (!validName(name)) {
      entry.invalid = true
      issue(entry.nameLine || entry.line, '服务器名称超过 24 个字符或格式无效，请缩短别名或提供 RackTop-Name。', 'The server name exceeds 24 characters or is invalid. Shorten the alias or provide RackTop-Name.')
    }
    if (!validHost(host)) {
      entry.invalid = true
      issue(entry.options.get('hostname')?.line || entry.line, 'HostName 必须是合法主机名或 IP 地址，不支持变量、令牌或地址重写。', 'HostName must be a valid hostname or IP address. Variables, tokens, and address rewriting are unsupported.')
    }
    if (!validUser(username)) {
      entry.invalid = true
      issue(entry.options.get('user')?.line || entry.line, '缺少有效 User；请在文件中填写用户名或手动添加服务器，不会猜测本机用户名。', 'A valid User is required. Add the username to the file or add the server manually; the local username is never guessed.')
    }
    if (port === null) {
      entry.invalid = true
      issue(entry.options.get('port')?.line || entry.line, 'Port 必须是 1–65535 的整数；对应 Host 段不导入。', 'Port must be an integer from 1 to 65535; its Host block will not be imported.')
    }
    if (!entry.invalid) entry.server = { alias: entry.alias, name, host, username, port: port!, jump: null, enabled: true }
  }
  for (const entry of blocks) {
    if (!entry.server || entry.invalid) continue
    const proxy = entry.options.get('proxyjump')
    if (!proxy || proxy.value.toLowerCase() === 'none') continue
    // ProxyCommand none can suppress a later ProxyJump in OpenSSH. Do not
    // change routing by treating the two options as independently effective.
    if (entry.options.has('proxycommand')) {
      entry.invalid = true
      issue(proxy.line, 'ProxyCommand 与 ProxyJump 同时出现会影响路由优先级；请删除 ProxyCommand 后重新导入此 Host 段。', 'Combining ProxyCommand and ProxyJump changes route precedence. Remove ProxyCommand before importing this Host block.')
      continue
    }
    const fail = () => {
      entry.invalid = true
      issue(proxy.line, 'ProxyJump 须为明确的单跳 用户名@主机[:端口]（IPv6 使用方括号），或本文件中完整的跳板别名；不支持循环或间接多跳。', 'ProxyJump must be one explicit user@host[:port] hop (bracket IPv6), or a complete jump alias in this file. Cycles and indirect multi-hop routes are unsupported.')
    }
    if (proxy.value.includes(',') || proxy.value.includes('://')) { fail(); continue }
    const parts = proxy.value.split('@')
    if (parts.length > 2) { fail(); continue }
    const explicitUser = parts.length === 2 ? parts[0] : undefined
    const address = parts[parts.length - 1]
    const parsed = address.startsWith('[') ? /^\[([^\]]+)\](?::([0-9]+))?$/.exec(address) : /^([^:]+)(?::([0-9]+))?$/.exec(address)
    if (!parsed || (address.startsWith('[') && !parsed[1].includes(':'))) { fail(); continue }
    const reference = aliases.get(parsed[1].toLowerCase())
    const jumpBlock = reference?.length === 1 ? reference[0] : undefined
    if (reference && (!jumpBlock?.server || jumpBlock.invalid || jumpBlock === entry || !jumpBlock.options.has('hostname') || (jumpBlock.options.has('proxyjump') && jumpBlock.options.get('proxyjump')!.value.toLowerCase() !== 'none'))) { fail(); continue }
    const host = jumpBlock?.server?.host || parsed[1]
    const username = explicitUser ?? jumpBlock?.server?.username ?? ''
    const port = portValue(parsed[2] ?? String(jumpBlock?.server?.port ?? 22))
    if (!validHost(host) || !validUser(username) || port === null) { fail(); continue }
    if (host.toLowerCase() === entry.server.host.toLowerCase() && port === entry.server.port) { fail(); continue }
    entry.server.jump = { host, port, username }
  }
  return { servers: blocks.filter(entry => !entry.invalid && entry.server).map(entry => entry.server!), issues: issues.sort((a, b) => a.line - b.line) }
}

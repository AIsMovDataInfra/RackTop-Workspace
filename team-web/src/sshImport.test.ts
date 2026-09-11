import { describe, expect, it } from 'vitest'
import { isIP } from 'node:net'
import { exportSshConfig } from '../../src/utils/sshTransfer'
import type { Server } from '../../src/types/models'
import { parseSshImport } from './sshImport'

const simple = (alias = 'node', extra = '') => `Host ${alias}\n  HostName ${alias}.example\n  User worker\n${extra}`
const target: Server = { id: 'test', name: '训练节点', host: '10.0.0.2', username: 'worker', port: 2222, tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'password', status: 'unknown', proxyJump: 'gateway', proxyUsePassword: true }

describe('browser SSH import', () => {
  it('round trips the actual desktop export, including JSON names and expanded IPv6 jumps', () => {
    const jump = { ...target, id: 'jump', name: 'Jump', sshAlias: 'gateway', host: '2001:db8::1', username: 'gateway', port: 21022, proxyJump: null }
    const exported = exportSshConfig([{ ...target, name: 'GPU "训练" #一', password: 'password-secret', identityFile: '/secret/private-key' } as Server], [jump, target])
    const result = parseSshImport(exported)
    expect(result.issues).toEqual([])
    expect(result.servers).toEqual([{ alias: 'GPU', name: 'GPU "训练" #一', host: '10.0.0.2', port: 2222, username: 'worker', jump: { host: '2001:db8::1', port: 21022, username: 'gateway' }, enabled: true }])
    expect(JSON.stringify(result)).not.toMatch(/password-secret|private-key|identityFile|proxyCommand/)
  })

  it('supports BOM, CRLF, mixed-case keywords, quotes, comments, and optional equals separators', () => {
    const result = parseSshImport('\uFEFF# portable\r\n  # RackTop-Name: "研发 #一"\r\nhOsT = "dev" # target\r\n  HostName="dev.example" # address\r\n  User = \'worker\'\r\n  Port=2202\r\n  ProxyJump = "gateway@[::1]:2201" # hop\r\n')
    expect(result.issues).toEqual([])
    expect(result.servers[0]).toEqual({ alias: 'dev', name: '研发 #一', host: 'dev.example', port: 2202, username: 'worker', jump: { host: '::1', port: 2201, username: 'gateway' }, enabled: true })
  })

  it('uses alias as the direct hostname and defaults omitted ports to 22, but never guesses User', () => {
    expect(parseSshImport('Host dev.example\nUser worker\n').servers[0]).toMatchObject({ name: 'dev.example', host: 'dev.example', port: 22, username: 'worker' })
    const missing = parseSshImport('Host missing\nHostName host.example\n')
    expect(missing.servers).toEqual([])
    expect(missing.issues[0].messageEn).toContain('User is required')
  })

  it('resolves a later jump alias and explicit user/port overrides without copying alias options', () => {
    const result = parseSshImport(simple('target', 'ProxyJump gateway\n') + simple('other', 'ProxyJump alternate@gateway:2203\n') + 'Host gateway\nHostName jump.example\nUser jumpuser\nPort 2200\n')
    expect(result.issues).toEqual([])
    expect(result.servers[0].jump).toEqual({ host: 'jump.example', username: 'jumpuser', port: 2200 })
    expect(result.servers[1].jump).toEqual({ host: 'jump.example', username: 'alternate', port: 2203 })
    expect(result.servers[2].jump).toBeNull()
  })

  it('allows explicit no-proxy configuration', () => {
    const result = parseSshImport(simple('node', 'ProxyJump none\nProxyCommand none\n'))
    expect(result.issues).toEqual([])
    expect(result.servers[0].jump).toBeNull()
  })

  it('rejects conflicting ProxyCommand none / ProxyJump routes instead of changing OpenSSH precedence', () => {
    for (const options of ['ProxyCommand none\nProxyJump user@jump.example\n', 'ProxyJump user@jump.example\nProxyCommand none\n']) {
      const result = parseSshImport(simple('bad', options) + simple('safe'))
      expect(result.servers.map(server => server.alias)).toEqual(['safe'])
      expect(result.issues.some(issue => issue.messageEn.includes('route precedence'))).toBe(true)
    }
  })

  it('does not strip literal OpenSSH backslashes to turn malformed destinations into valid ones', () => {
    for (const value of ['Host escaped\\name\nUser worker\n', 'Host node\nUser wor\\ker\n', 'Host node\nHostName exa\\mple.example\nUser worker\n', simple('node', 'ProxyJump jump@exa\\mple.example\n')]) {
      expect(parseSshImport(value).servers).toEqual([])
    }
  })

  it.each(['Include /secret/config', 'InClUdE="/secret/config"', 'Match exec "private-command"', 'Match=all', 'Match exec "unterminated'])('rejects the entire file for scope-changing %s', directive => {
    const result = parseSshImport(simple('first') + directive + '\n' + simple('last'))
    expect(result.servers).toEqual([])
    expect(result.issues.some(issue => issue.messageEn.includes('Include and Match'))).toBe(true)
    expect(JSON.stringify(result.issues)).not.toMatch(/secret\/config|private-command|unterminated/)
  })

  it.each(['*', '*.example', '!private', 'one two', '"one two"', 'one,other'])('rejects the entire file for ambiguous Host %s', alias => {
    const result = parseSshImport(simple('first') + simple(alias))
    expect(result.servers).toEqual([])
    expect(result.issues.some(issue => issue.messageEn.includes('one concrete alias'))).toBe(true)
  })

  it('rejects global target defaults rather than silently ignoring inheritance', () => {
    expect(parseSshImport('User inherited\n' + simple()).servers).toEqual([])
    expect(parseSshImport('ProxyJump jump@hop.example\n' + simple()).servers).toEqual([])
    expect(parseSshImport('HostName real.example\n' + simple()).servers).toEqual([])
  })

  it('rejects duplicate aliases case-insensitively and any referencing target without merging options', () => {
    const result = parseSshImport(simple('target', 'ProxyJump gateway\n') + simple('gateway') + simple('GATEWAY') + simple('safe'))
    expect(result.servers.map(server => server.alias)).toEqual(['safe'])
    expect(result.issues.filter(issue => issue.messageEn.includes('duplicated'))).toHaveLength(2)
  })

  it.each(['HostName changed.example', 'User other', 'Port 23\nPort 24', 'ProxyJump none\nProxyJump jump@jump.example'])('rejects repeated connection fields: %s', extra => {
    const result = parseSshImport(simple('bad', extra + '\n') + simple('good'))
    expect(result.servers.map(server => server.alias)).toEqual(['good'])
  })

  it('rejects command and unsupported target directives without including their values in issues', () => {
    for (const command of ['ProxyCommand sh -c secret-command', 'ProxyCommand "none ignored"', 'LocalCommand secret-command', 'RemoteCommand secret-command', 'CanonicalizeHostname yes']) {
      const result = parseSshImport(simple('bad', command + '\n') + simple('safe'))
      expect(result.servers.map(server => server.alias)).toEqual(['safe'])
      expect(JSON.stringify(result)).not.toContain('secret-command')
    }
  })

  it('reports ignored authentication preferences without importing or echoing paths and credential content', () => {
    const result = parseSshImport('IdentityAgent "/secret global.sock"\n' + simple('node', 'IdentityFile "/private/secret #key" # comment\nCertificateFile /secret/cert\nIdentitiesOnly yes\nStrictHostKeyChecking yes\n'))
    expect(result.servers).toHaveLength(1)
    expect(result.issues).toHaveLength(5)
    for (const issue of result.issues) expect(issue.messageEn).toContain('ignored')
    expect(JSON.stringify(result)).not.toMatch(/\/secret|\/private|global.sock|#key/)
    expect(Object.keys(result.servers[0]).sort()).toEqual(['alias', 'enabled', 'host', 'jump', 'name', 'port', 'username'])
  })

  it.each(['-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----', '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----', 'PuTTY-User-Key-File-3: ssh-ed25519'])('rejects private-key files without echoing key material: %s', header => {
    const result = parseSshImport(simple() + header + '\nprivate-material\n-----END PRIVATE KEY-----\n')
    expect(result.servers).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].line).toBe(4)
    expect(JSON.stringify(result)).not.toContain('private-material')
  })

  it('rejects oversize UTF-8 input and a 51st Host block without returning a truncated subset', () => {
    expect(parseSshImport('#' + '界'.repeat(350_000) + '\n' + simple()).servers).toEqual([])
    const oversized = parseSshImport(Array.from({ length: 51 }, (_, i) => simple(`node${i}`)).join('\n'))
    expect(oversized.servers).toEqual([])
    expect(oversized.issues.at(-1)?.messageEn).toContain('more than 50')
    const boundary = parseSshImport(Array.from({ length: 50 }, (_, i) => simple(`node${i}`)).join('\n'))
    expect(boundary.servers).toHaveLength(50)
    expect(boundary.issues).toEqual([])
    expect(parseSshImport('#' + 'a'.repeat(1024 * 1024)).issues[0].messageEn).toContain('exceeds 1 MiB')
  })

  it('counts names by Unicode code point, rejects overlong or malformed JSON names, and never truncates', () => {
    const valid = '😀'.repeat(24)
    expect(parseSshImport(`# RackTop-Name: ${JSON.stringify(valid)}\n` + simple()).servers[0].name).toBe(valid)
    for (const name of ['"' + '界'.repeat(25) + '"', 'not-json', '42', '""', '"bad\\nname"']) {
      const result = parseSshImport(`# RackTop-Name: ${name}\n` + simple('bad') + simple('safe'))
      expect(result.servers.map(server => server.alias)).toEqual(['safe'])
      expect(result.issues[0].line).toBe(1)
    }
    expect(parseSshImport(simple('a'.repeat(25))).servers).toEqual([])
  })

  it.each(['ProxyJump a@one.example,b@two.example', 'ProxyJump missing', 'ProxyJump user@2001:db8::1', 'ProxyJump ssh://user@jump.example', 'ProxyJump user@[not-ip]:22', 'ProxyJump user@jump.example:65536', 'ProxyJump @jump.example', 'ProxyJump user@@jump.example', 'ProxyJump user@jump.example:', 'ProxyJump user@node.example'])('rejects unsafe, incomplete, or ambiguous jumps: %s', option => {
    expect(parseSshImport(simple('node', option + '\n')).servers).toEqual([])
  })

  it('rejects jump cycles and indirect multiple hops regardless of block order', () => {
    expect(parseSshImport(simple('a', 'ProxyJump b\n') + simple('b', 'ProxyJump a\n')).servers).toEqual([])
    const chain = parseSshImport(simple('a', 'ProxyJump b\n') + simple('b', 'ProxyJump c\n') + simple('c'))
    expect(chain.servers.map(server => server.alias)).toEqual(['b', 'c'])
    const reversed = parseSshImport(simple('c') + simple('b', 'ProxyJump c\n') + simple('a', 'ProxyJump b\n'))
    expect(reversed.servers.map(server => server.alias)).toEqual(['c', 'b'])
    expect(parseSshImport(simple('a', 'ProxyJump a\n')).servers).toEqual([])
  })

  it('does not use incomplete or rejected blocks as jump aliases', () => {
    for (const jump of ['Host gateway\nUser jump\n', 'Host gateway\nHostName jump.example\n', simple('gateway', 'ProxyCommand private-command\n')]) {
      const result = parseSshImport(simple('target', 'ProxyJump gateway\n') + jump)
      expect(result.servers.some(server => server.alias === 'target')).toBe(false)
      expect(JSON.stringify(result)).not.toContain('private-command')
    }
  })

  it.each(['::1', '2001:db8::1234', '::ffff:192.0.2.128', '1:2:3:4:5:6:7:8'])('accepts API-compatible IPv6 addresses without brackets in HostName: %s', host => {
    expect(isIP(host)).toBe(6)
    const result = parseSshImport(`Host ipv6\nHostName ${host}\nUser worker\nProxyJump hop@[2001:db8::2]:2222\n`)
    expect(result.issues).toEqual([])
    expect(result.servers[0].host).toBe(host)
    expect(isIP(result.servers[0].jump!.host)).toBe(6)
  })

  it.each(['host..example', 'host.example.', '-host.example', 'host-.example', '[::1]', ':::1', '1:2:3:4:5:6:7:8:9', 'fe80::1%bad_zone', 'fe80::1%eth0', 'fe80::1%h', 'bad/host', '%h', '${HOST}', 'a'.repeat(64) + '.example', ''])('rejects hosts rejected by the API or requiring expansion: %s', host => {
    expect(parseSshImport(`Host bad\nHostName "${host}"\nUser worker\n`).servers).toEqual([])
  })

  it.each(['0', '65536', '-22', '2.2', '0x16', '2e1', '22 trailing', ''])('rejects invalid port values: %s', port => {
    expect(parseSshImport(simple('bad', `Port "${port}"\n`)).servers).toEqual([])
  })

  it('rejects malformed quoting, malformed lines, control characters, and empty inputs with useful line numbers', () => {
    for (const input of ['HostName "unterminated', 'User worker\\', 'HostName=']) {
      const result = parseSshImport(simple('bad', input + '\n') + simple('safe'))
      expect(result.servers.map(server => server.alias)).toEqual(['safe'])
      expect(result.issues.some(issue => issue.line === 4)).toBe(true)
    }
    expect(parseSshImport(simple('bad', '\u0000\n') + simple('safe')).servers).toEqual([])
    expect(parseSshImport('# nothing to import\n').issues[0].messageEn).toContain('No independent Host')
  })
})

import { describe, expect, it } from 'vitest'
import { exportSshConfig, parseSharedSshConfig } from './sshTransfer'
import type { Server } from '../types/models'

const target: Server = { id: 'test', name: '训练节点', host: '10.0.0.2', username: 'worker', port: 2222, tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'password', status: 'unknown', proxyJump: 'jump@jump.example:21022', proxyUsePassword: true }

describe('portable SSH configuration', () => {
  it('round trips connection fields without exporting credentials or local identity paths', () => {
    const exported = exportSshConfig([{ ...target, identityFile: '/private/id_ed25519', password: 'target-secret', proxyPassword: 'jump-secret', lastError: 'private diagnostic' } as Server])
    for (const secret of ['target-secret', 'jump-secret', '/private/id_ed25519', 'private diagnostic']) expect(exported).not.toContain(secret)
    expect(parseSharedSshConfig(exported)).toEqual([expect.objectContaining({ name: '训练节点', host: '10.0.0.2', username: 'worker', port: 2222, proxyJump: 'jump@jump.example:21022', authMethod: 'sshAgent', proxyUsePassword: false })])
    expect(parseSharedSshConfig(exported)[0].sshAlias).toBeUndefined()
  })
  it('creates distinct concrete aliases and expands a jump alias from the exported cluster list', () => {
    const jump = { ...target, name: 'jump', sshAlias: 'jump', host: 'jump.example', port: 21022, username: 'gateway', proxyJump: null }
    const exported = exportSshConfig([jump, { ...target, name: 'same', proxyJump: 'jump' }, { ...target, name: 'same' }])
    expect(exported).toContain('Host same-2\n')
    expect(exported).toContain('ProxyJump gateway@jump.example:21022')
    expect(parseSharedSshConfig(exported)).toHaveLength(3)
  })
  it('rejects directive injection and omits executable SSH directives on import', () => {
    expect(() => exportSshConfig([{ ...target, host: 'host\nProxyCommand attacker' }])).toThrow()
    expect(() => exportSshConfig([{ ...target, proxyJump: 'missing-alias' }])).toThrow('缺少可共享')
    const imported = parseSharedSshConfig('Host safe\nHostName host.example\nUser worker\nProxyCommand attacker\nLocalCommand attacker\nIdentityFile /private/key\nHost *\nUser root\n')
    expect(imported).toHaveLength(1)
    expect(JSON.stringify(imported)).not.toContain('attacker')
    expect(imported[0].identityFile).toBeUndefined()
    expect(() => parseSharedSshConfig('Host invalid\nHostName host\nUser user\nPort 70000\n')).toThrow()
  })
})

// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityLogSheet, LogsView } from '../App'
import { api } from '../services/api'
import type { InteractionLogSummary, Server, Snapshot } from '../types/models'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const server = {
  id: 'server-a', name: '训练服务器 A', host: 'host.invalid', port: 22, username: 'tester',
  tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false,
  authMethod: 'sshAgent', status: 'offline',
} as Server
const snapshot = { timestamp: 1_800_000_000, gpus: [], processes: [], cpuProcesses: [], disks: [] } as unknown as Snapshot

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('log failure copying', () => {
  it('copies a server failure from the activity log without changing its visible text', async () => {
    const failure = 'SSH 连接失败：Connection timed out\n请检查 2222 端口'
    const summary: InteractionLogSummary = {
      sentBytes: 20, responseBytes: 0, storedBytes: 0, localStorageBytes: 100, failureCount: 1,
      servers: [{ serverId: server.id, serverName: server.name, sentBytes: 20, responseBytes: 0, storedBytes: 0, lastStartedAt: Date.now() - 500, lastFinishedAt: Date.now(), lastCommand: 'ssh host.invalid', status: 'error', error: failure }],
    }
    vi.spyOn(api, 'getInteractionLogSummary').mockResolvedValue(summary)

    await act(async () => root.render(<ActivityLogSheet servers={[server]} snapshots={{}} onClose={vi.fn()} />))
    const feedback = container.querySelector('.activity-log-server__error')!
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="复制 ${server.name} 的失败信息"]`)!
    expect(feedback.textContent).toContain(failure)
    expect(feedback.querySelector('.selectable-text')).toBeTruthy()

    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledWith(failure)
    expect(feedback.textContent).toContain(failure)
  })

  it('makes the single-server connection error selectable and directly copyable', async () => {
    const failure = 'Host key verification failed'
    vi.spyOn(api, 'getInteractionLogSummary').mockResolvedValue({ sentBytes: 0, responseBytes: 0, storedBytes: 0, localStorageBytes: 0, failureCount: 1, servers: [] })

    await act(async () => root.render(<LogsView server={{ ...server, lastError: failure }} snapshot={snapshot} />))
    const message = container.querySelector('.log-entry__message')!
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="复制连接错误"]')!
    expect(message.classList.contains('selectable-text')).toBe(true)

    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledWith(failure)
  })

  it('copies the complete activity-log loading error including its visible prefix', async () => {
    vi.spyOn(api, 'getInteractionLogSummary').mockRejectedValue(new Error('database is locked'))

    await act(async () => root.render(<ActivityLogSheet servers={[]} snapshots={{}} onClose={vi.fn()} />))
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="复制日志读取错误"]')!
    const message = '无法读取实时日志：Error: database is locked'
    expect(container.querySelector('.activity-log-error .selectable-text')?.textContent).toBe(message)

    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledWith(message)
  })
})

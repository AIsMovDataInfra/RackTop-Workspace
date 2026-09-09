// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../services/api'
import type { ManagedRun, Server } from '../types/models'
import { ManagedProcessView } from './ManagedProcessView'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

const now = Math.floor(Date.now() / 1_000)
const runs: ManagedRun[] = ['A', 'B'].map((name, index) => ({
  id: `run-${name.toLowerCase()}`,
  profileId: null,
  name: `任务 ${name}`,
  projectId: null,
  serverId: `server-${name.toLowerCase()}`,
  gpuUuids: [],
  gpuIndices: [],
  workingDirectory: '/workspace',
  command: `python ${name.toLowerCase()}.py`,
  pid: 4_000 + index,
  logPath: `/tmp/${name.toLowerCase()}.log`,
  startedAt: now,
  status: 'running',
}))
const servers = runs.map((run) => ({
  id: run.serverId,
  name: `服务器 ${run.name.at(-1)}`,
  host: `${run.serverId}.invalid`,
  port: 22,
  username: 'tester',
  tags: [],
  samplingIntervalSeconds: 2,
  historyRetentionDays: 90,
  remoteHistoryEnabled: false,
  authMethod: 'sshAgent',
  status: 'online',
})) as Server[]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  localStorage.setItem('racktop.managedRuns.v1', JSON.stringify(runs))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('managed task log copying', () => {
  it('keeps the visible and copied log matched to the latest selected task', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    vi.spyOn(api, 'readManagedRunLog').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<ManagedProcessView
      servers={servers}
      snapshots={{}}
      projects={[]}
      warnings={[]}
      onDismissWarning={vi.fn()}
      onOpenTerminal={vi.fn()}
      onNotice={vi.fn()}
      onRefreshServer={vi.fn().mockResolvedValue(undefined)}
    />))

    const logButtons = container.querySelectorAll<HTMLButtonElement>('button[title="查看日志"]')
    expect(logButtons).toHaveLength(2)
    await act(async () => logButtons[0].click())
    await act(async () => logButtons[1].click())
    await act(async () => { second.resolve('B 日志\n第二行\n'); await second.promise })
    await act(async () => { first.resolve('A 日志\n不应显示'); await first.promise })

    expect(container.querySelector('.managed-log-inspector h2')?.textContent).toBe('任务 B')
    expect(container.querySelector('.managed-log-inspector pre')?.textContent).toBe('B 日志\n第二行\n')
    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="复制日志"]')!
    await act(async () => copyButton.click())
    expect(writeText).toHaveBeenCalledWith('B 日志\n第二行\n')
  })
})

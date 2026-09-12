import { describe, expect, it } from 'vitest'
import { currentResourceUsage, filterResources, resourceClusterGroups, resourceKind } from './resource-usage'
import type { Resource } from './types'

const now = Date.parse('2030-09-09T02:00:00Z')
const gpu: Resource = { id: 'gpu', name: 'GPU server', cluster: '上海', gpuCount: 2, gpuModel: 'A100', notes: '', enabled: true,
  usage: { state: 'busy', observedAt: new Date(now).toISOString(), gpus: [{ id: 'card', uuid: 'GPU-1', index: 1, state: 'busy', users: ['linux-worker'], utilization: 70, memoryUsedMb: 4096 }] } }

describe('observed resource usage', () => {
  it('keeps fresh observations but expires both idle and busy samples without carrying their user data forward', () => {
    for (const state of ['busy', 'free'] as const) {
      const resource = { ...gpu, usage: { ...gpu.usage!, state } }
      expect(currentResourceUsage(resource, now + 89_999).state).toBe(state)
      expect(currentResourceUsage(resource, now + 90_000)).toEqual({ state: 'unknown', observedAt: resource.usage.observedAt, gpus: [] })
    }
  })
  it('never derives idle from missing, invalid, future or explicitly unknown samples', () => {
    expect(currentResourceUsage({})).toEqual({ state: 'unknown', observedAt: null, gpus: [] })
    for (const observedAt of [null, 'invalid', new Date(now + 1).toISOString()]) {
      expect(currentResourceUsage({ usage: { state: 'free', observedAt, gpus: [] } }, now).state).toBe('unknown')
    }
    expect(currentResourceUsage({ usage: { state: 'unknown', observedAt: new Date(now).toISOString(), gpus: [] } }, now).state).toBe('unknown')
  })
  it('groups by actual GPU count, preserves duplicate cluster names across types, and does not filter busy resources', () => {
    const cpu = { ...gpu, id: 'cpu', name: '阿里云 ECS', gpuCount: 0, gpuModel: '' }
    const resources = [gpu, cpu, { ...gpu, id: 'disabled', enabled: false, cluster: '旧集群' }]
    expect(resourceKind(cpu)).toBe('cpu')
    expect(resourceClusterGroups(resources)).toEqual([
      { kind: 'gpu', count: 1, clusters: [{ name: '上海', count: 1 }] },
      { kind: 'cpu', count: 1, clusters: [{ name: '上海', count: 1 }] },
    ])
    expect(filterResources(resources, '', '').map(resource => resource.id)).toEqual(['gpu', 'cpu'])
    expect(filterResources(resources, 'gpu', '上海')).toEqual([gpu])
    expect(filterResources(resources, 'cpu', '上海')).toEqual([cpu])
    expect(filterResources(resources, 'cpu', '不存在')).toEqual([])
  })
})

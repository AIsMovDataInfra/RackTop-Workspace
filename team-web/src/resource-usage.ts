import type { Resource, ResourceUsage } from './types'

export const USAGE_FRESHNESS_MS = 90_000
export type ResourceKind = 'gpu' | 'cpu'
export function resourceKind(resource: Pick<Resource, 'gpuCount'>): ResourceKind { return resource.gpuCount > 0 ? 'gpu' : 'cpu' }

export function currentResourceUsage(resource: Pick<Resource, 'usage'>, now = Date.now()): ResourceUsage {
  const usage = resource.usage
  const observed = usage?.observedAt ? Date.parse(usage.observedAt) : NaN
  if (!usage || !Number.isFinite(observed) || observed > now || now - observed >= USAGE_FRESHNESS_MS) {
    return { state: 'unknown', observedAt: usage?.observedAt ?? null, gpus: [] }
  }
  return usage
}

export function currentGpuRestriction(resource: Resource, start: string, indices?: number[], now = Date.now()): 'GPU_BUSY' | 'GPU_USAGE_UNKNOWN' | null {
  if (!resource.gpuCount || Date.parse(start) > now) return null
  const usage = currentResourceUsage(resource, now)
  const devices = resource.gpus?.length ? resource.gpus : Array.from({ length: resource.gpuCount }, (_, index) => ({ id: '', index }))
  const selected = indices === undefined ? devices : devices.filter(gpu => indices.includes(gpu.index))
  const states = selected.map(gpu => usage.gpus.find(sample => gpu.id ? sample.id === gpu.id : sample.index === gpu.index)?.state ?? 'unknown')
  if (states.includes('busy')) return 'GPU_BUSY'
  if (selected.length === 0 || (indices && selected.length !== indices.length) || states.some(state => state !== 'free')) return 'GPU_USAGE_UNKNOWN'
  return null
}

export function resourceClusterGroups(resources: Resource[]) {
  return (['gpu', 'cpu'] as const).map(kind => {
    const members = resources.filter(resource => resource.enabled && resourceKind(resource) === kind)
    return { kind, count: members.length, clusters: [...new Set(members.map(resource => resource.cluster))].sort()
      .map(name => ({ name, count: members.filter(resource => resource.cluster === name).length })) }
  })
}

export function filterResources(resources: Resource[], kind: ResourceKind | '', cluster: string) {
  return resources.filter(resource => resource.enabled && (!kind || resourceKind(resource) === kind) && (!cluster || resource.cluster === cluster))
}

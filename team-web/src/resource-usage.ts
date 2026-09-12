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

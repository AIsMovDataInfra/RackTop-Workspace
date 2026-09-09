import { detectAppPlatform } from './platform'

export interface ReleaseInfo {
  version: string
  url: string
  publishedAt?: string
}

export function releaseUrl(version: string) {
  const tag = version.replace(/^v/i, '')
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const platform = detectAppPlatform(isDesktop, typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const workspaceRelease = /^(0|[1-9]\d*)\./.exec(tag)
  const repository = workspaceRelease && Number(workspaceRelease[1]) >= 2
    ? 'AIsMovDataInfra/RackTop-Workspace'
    : tag.includes('-linux.') || platform === 'macos' ? 'AIsMovDataInfra/RackTop' : 'Tongzh-SEU/RackTop'
  return `https://github.com/${repository}/releases/tag/v${tag}`
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_CHECK_STORAGE_KEY = 'racktop.updateCheck.v1'
export const IGNORED_UPDATE_VERSION_KEY = 'racktop.ignoredUpdateVersion.v1'

export interface UpdateCheckCache {
  lastCheckedAt?: number
  lastScheduledCheckAt?: number
  release?: ReleaseInfo
}

export function isNewerVersion(candidate: string, current: string) {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  const left = parse(candidate)
  const right = parse(current)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (Number(left[index + 1]) !== Number(right[index + 1])) return Number(left[index + 1]) > Number(right[index + 1])
  }
  if (!left[4] || !right[4]) return !left[4] && Boolean(right[4])
  const a = left[4].split('.')
  const b = right[4].split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined || b[index] === undefined) return a[index] !== undefined
    if (a[index] === b[index]) continue
    const numericA = /^\d+$/.test(a[index])
    const numericB = /^\d+$/.test(b[index])
    if (numericA && numericB) return Number(a[index]) > Number(b[index])
    if (numericA !== numericB) return !numericA
    return a[index] > b[index]
  }
  return false
}

export function shouldShowUpdateBadge(releaseVersion: string | undefined, ignoredVersion: string | undefined) {
  return Boolean(releaseVersion && releaseVersion !== ignoredVersion)
}

export function loadCachedUpdate(): UpdateCheckCache {
  try { return JSON.parse(localStorage.getItem(UPDATE_CHECK_STORAGE_KEY) ?? '{}') }
  catch { return {} }
}

export function saveCachedUpdate(value: Partial<UpdateCheckCache>) {
  localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, JSON.stringify({ ...loadCachedUpdate(), ...value }))
}

export function loadIgnoredUpdateVersion() {
  return localStorage.getItem(IGNORED_UPDATE_VERSION_KEY) ?? undefined
}

export function saveIgnoredUpdateVersion(version: string) {
  localStorage.setItem(IGNORED_UPDATE_VERSION_KEY, version)
}

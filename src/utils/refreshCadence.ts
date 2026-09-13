export const FOREGROUND_STATUS_INTERVAL_MS = 500
export const DISK_STATUS_INTERVAL_MS = 15 * 60 * 1_000
export const TEAM_STATUS_MAX_INTERVAL_MS = 30_000

export function shouldCollectDetailData(quiet: boolean, hasPreviousSnapshot: boolean): boolean {
  return !quiet || hasPreviousSnapshot
}

export function statusRefreshIntervalMs(fastStatusView: boolean, documentHidden: boolean, samplingIntervalSeconds: number, backgroundIntervalSeconds: number, isManaged = false): number {
  const interval = documentHidden
    ? Math.max(samplingIntervalSeconds, backgroundIntervalSeconds) * 1_000
    : (fastStatusView ? FOREGROUND_STATUS_INTERVAL_MS : Math.max(1, samplingIntervalSeconds) * 1_000)
  return isManaged ? Math.min(interval, TEAM_STATUS_MAX_INTERVAL_MS) : interval
}

export function shouldRecordHistory(lastRecordedAtMs: number | undefined, nowMs: number, samplingIntervalSeconds: number): boolean {
  if (lastRecordedAtMs === undefined) return true
  return nowMs - lastRecordedAtMs >= Math.max(1, samplingIntervalSeconds) * 1_000
}

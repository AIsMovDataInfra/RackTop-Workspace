export const CONNECTION_RETRY_DELAY_MS = 30 * 60 * 1000

/** Manual reconnect remains immediate; background work shares the cooldown. */
export function shouldDeferConnection(nextRetryAt: number | undefined, now: number, manual = false) {
  return !manual && nextRetryAt !== undefined && now < nextRetryAt
}

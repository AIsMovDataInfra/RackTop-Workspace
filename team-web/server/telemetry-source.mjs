import { createHash } from 'node:crypto';

// Internal only: never expose either this identifier or the session token hash
// in a resource DTO. The client cannot choose or share a telemetry source.
export function deviceTelemetrySource(tokenHash) {
  if (typeof tokenHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) throw new Error('Invalid internal device session');
  return createHash('sha256').update('racktop-telemetry-source-v1\0').update(tokenHash).digest('hex');
}

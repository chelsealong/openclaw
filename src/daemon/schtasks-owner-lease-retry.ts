import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { isSqliteIoError } from "../infra/sqlite-error-diagnostics.js";
import { sleep, sleepSync } from "../utils.js";
import type { GatewayServiceEnv } from "./service-types.js";

// schtasks /End kills the gateway before this reads its lease; Windows can briefly
// surface SQLITE_IOERR_TRUNCATE while the dying process unmaps the WAL/SHM files.
const OWNER_LEASE_TRANSIENT_IOERR_RETRIES = 4;
const OWNER_LEASE_TRANSIENT_IOERR_DELAY_MS = 150;

export async function readGatewayOwnerLeaseWithTransientRetry(
  ownerEnv: GatewayServiceEnv,
): Promise<ReturnType<typeof readGatewayOwnerLease>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return readGatewayOwnerLease({ env: ownerEnv });
    } catch (error) {
      if (attempt >= OWNER_LEASE_TRANSIENT_IOERR_RETRIES || !isSqliteIoError(error)) {
        throw error;
      }
      await sleep(OWNER_LEASE_TRANSIENT_IOERR_DELAY_MS);
    }
  }
}

// assertOwnerCurrent's sync assertCurrent callback cannot await the retry above.
export function readGatewayOwnerLeaseWithTransientRetrySync(
  ownerEnv: GatewayServiceEnv,
): ReturnType<typeof readGatewayOwnerLease> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return readGatewayOwnerLease({ env: ownerEnv });
    } catch (error) {
      if (attempt >= OWNER_LEASE_TRANSIENT_IOERR_RETRIES || !isSqliteIoError(error)) {
        throw error;
      }
      sleepSync(OWNER_LEASE_TRANSIENT_IOERR_DELAY_MS);
    }
  }
}

/**
 * Rabe wallet helper interface — formats console warnings and tracks
 * transaction lifecycle for debug visibility.
 */

export type RabeTxPhase =
  | "idle"
  | "building"
  | "signing"
  | "submitting"
  | "success"
  | "error";

export interface RabeTxTrackEntry {
  txId: string;
  phase: RabeTxPhase;
  message: string;
  timestamp: number;
  stack?: string;
}

export interface RabeConsoleWarningBlock {
  title: string;
  body: string;
  stack: string;
  txId?: string;
  phase?: RabeTxPhase;
}

/** Chains the Rabe wallet can be pointed at. */
export type RabeNetwork = "mainnet" | "testnet";

export interface RabeNetworkMismatchState {
  mismatched: boolean;
  walletNetwork: RabeNetwork;
  appNetwork: RabeNetwork;
  warningMessage: string | null;
}

const WARN_PREFIX = "[rabe_connector]";

/** Captures a normalized stack string from an error or the current call site. */
export function formatStackTrace(err?: unknown): string {
  if (err instanceof Error && err.stack) {
    return err.stack;
  }

  if (typeof err === "string" && err.includes("\n")) {
    return err;
  }

  const synthetic = new Error(
    typeof err === "string" ? err : "Rabe connector trace"
  );
  return synthetic.stack ?? "Error: Rabe connector trace";
}

/** Builds a multi-line console warning block for transaction debug tracking. */
export function formatConsoleWarningBlock(
  block: RabeConsoleWarningBlock
): string {
  const lines = [
    `${WARN_PREFIX} ╔══════════════════════════════════════╗`,
    `${WARN_PREFIX} ║ ${block.title.padEnd(36).slice(0, 36)} ║`,
    `${WARN_PREFIX} ╚══════════════════════════════════════╝`,
    `${WARN_PREFIX} ${block.body}`,
  ];

  if (block.txId) {
    lines.push(`${WARN_PREFIX} txId: ${block.txId}`);
  }
  if (block.phase) {
    lines.push(`${WARN_PREFIX} phase: ${block.phase}`);
  }

  lines.push(`${WARN_PREFIX} --- stack trace ---`);
  for (const frame of block.stack.split("\n")) {
    lines.push(`${WARN_PREFIX} ${frame}`);
  }
  lines.push(`${WARN_PREFIX} --- end stack ---`);

  return lines.join("\n");
}

/** Logs a formatted warning block (including stack) to the console. */
export function logRabeWarning(
  title: string,
  body: string,
  options?: { err?: unknown; txId?: string; phase?: RabeTxPhase }
): string {
  const stack = formatStackTrace(options?.err);
  const formatted = formatConsoleWarningBlock({
    title,
    body,
    stack,
    txId: options?.txId,
    phase: options?.phase,
  });
  console.warn(formatted);
  return formatted;
}

export class RabeNetworkMismatchError extends Error {
  constructor(
    public readonly walletNetwork: RabeNetwork,
    public readonly appNetwork: RabeNetwork
  ) {
    super(
      `Network mismatch: Rabe wallet is on ${walletNetwork}, app expects ${appNetwork}`
    );
    this.name = "RabeNetworkMismatchError";
  }
}

function capitalizeNetwork(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Compares the network the Rabe wallet is pointed at against the network the
 * app expects and produces a user-facing warning message when they diverge.
 */
export function checkRabeNetworkMatch(
  walletNetwork: RabeNetwork,
  appNetwork: RabeNetwork
): RabeNetworkMismatchState {
  const mismatched = walletNetwork !== appNetwork;
  return {
    mismatched,
    walletNetwork,
    appNetwork,
    warningMessage: mismatched
      ? `Network mismatch: your Rabe wallet is on ${capitalizeNetwork(walletNetwork)} but this app uses ${capitalizeNetwork(appNetwork)}. Switch networks in Rabe to continue.`
      : null,
  };
}

/**
 * Runs a network match check and, on mismatch, emits a formatted console
 * warning block (with stack) via the shared rabe_connector debug machinery.
 */
export function warnOnRabeNetworkMismatch(
  walletNetwork: RabeNetwork,
  appNetwork: RabeNetwork
): RabeNetworkMismatchState {
  const state = checkRabeNetworkMatch(walletNetwork, appNetwork);
  if (state.mismatched && state.warningMessage) {
    logRabeWarning("NETWORK MISMATCH", state.warningMessage, {
      err: new RabeNetworkMismatchError(walletNetwork, appNetwork),
    });
  }
  return state;
}

export class RabeTransactionTracker {
  private entries: RabeTxTrackEntry[] = [];

  track(
    txId: string,
    phase: RabeTxPhase,
    message: string,
    err?: unknown
  ): RabeTxTrackEntry {
    const entry: RabeTxTrackEntry = {
      txId,
      phase,
      message,
      timestamp: Date.now(),
      stack: formatStackTrace(err),
    };
    this.entries.push(entry);

    logRabeWarning(`TX ${phase.toUpperCase()}`, message, {
      err,
      txId,
      phase,
    });

    return entry;
  }

  getHistory(txId?: string): RabeTxTrackEntry[] {
    if (!txId) return [...this.entries];
    return this.entries.filter((e) => e.txId === txId);
  }

  clear(): void {
    this.entries = [];
  }
}

export const rabeTracker = new RabeTransactionTracker();

// ---------------------------------------------------------------------------
// Persistent session cache — remembers active addresses across reload cycles.
// ---------------------------------------------------------------------------

/** Storage key used to persist the Rabe session state. */
export const RABE_SESSION_CACHE_KEY = "rabe_connector_session";

/**
 * The shape of data stored in the session cache.
 * Only the minimal set of fields needed to restore an active session is kept
 * so that the stored payload stays small and easy to validate.
 */
export interface RabeSessionState {
  /** Stellar public key (G…) of the active account. */
  activeAddress: string;
  /** Network the session was established on. */
  network: RabeNetwork;
  /** Unix-millisecond timestamp when the session was cached. */
  cachedAt: number;
}

/**
 * Validates that a plain object conforms to {@link RabeSessionState}.
 * This guard is called on data parsed from localStorage so that tampered or
 * structurally invalid payloads are rejected before they reach the rest of the
 * application.
 */
function isValidRabeSessionState(value: unknown): value is RabeSessionState {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.activeAddress !== "string" || obj.activeAddress.trim() === "")
    return false;
  // Stellar public keys start with "G" and are 56 characters long.
  if (!/^G[A-Z2-7]{55}$/.test(obj.activeAddress)) return false;

  if (obj.network !== "mainnet" && obj.network !== "testnet") return false;

  if (typeof obj.cachedAt !== "number" || !Number.isFinite(obj.cachedAt))
    return false;

  return true;
}

/**
 * Persists the active Rabe session state to localStorage so it can be
 * restored across page reloads.
 *
 * Silently no-ops in environments where localStorage is unavailable (e.g.
 * server-side rendering) or throws (e.g. private browsing quota exceeded).
 */
export function saveRabeSession(
  activeAddress: string,
  network: RabeNetwork
): void {
  if (typeof window === "undefined") return;

  const state: RabeSessionState = {
    activeAddress,
    network,
    cachedAt: Date.now(),
  };

  try {
    window.localStorage.setItem(
      RABE_SESSION_CACHE_KEY,
      JSON.stringify(state)
    );
  } catch (err) {
    logRabeWarning("SESSION CACHE WRITE FAILED", "Unable to persist session to localStorage", {
      err,
    });
  }
}

/**
 * Attempts to restore a previously cached Rabe session from localStorage.
 *
 * Returns `null` when:
 * - The environment does not have localStorage (SSR).
 * - No cached entry exists.
 * - The stored payload is corrupt, tampered, or structurally invalid.
 *
 * The caller is responsible for re-verifying liveness of the address with the
 * wallet provider before trusting the restored state.
 */
export function loadRabeSession(): RabeSessionState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(RABE_SESSION_CACHE_KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);

    if (!isValidRabeSessionState(parsed)) {
      // Remove the invalid entry so it cannot cause repeated failures.
      window.localStorage.removeItem(RABE_SESSION_CACHE_KEY);
      logRabeWarning(
        "SESSION CACHE INVALID",
        "Cached session data failed validation and was cleared"
      );
      return null;
    }

    return parsed;
  } catch (err) {
    // The entry is likely corrupt JSON. Remove it and report.
    try {
      window.localStorage.removeItem(RABE_SESSION_CACHE_KEY);
    } catch {
      // Ignore secondary failure.
    }
    logRabeWarning("SESSION CACHE READ FAILED", "Unable to read session from localStorage", {
      err,
    });
    return null;
  }
}

/**
 * Removes the persisted Rabe session from localStorage (e.g. on disconnect).
 *
 * Silently no-ops when localStorage is unavailable.
 */
export function clearRabeSession(): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(RABE_SESSION_CACHE_KEY);
  } catch (err) {
    logRabeWarning("SESSION CACHE CLEAR FAILED", "Unable to clear session from localStorage", {
      err,
    });
  }
}

// ---------------------------------------------------------------------------
// RabeSessionCache — object-oriented wrapper around the persistent session
// functions above, providing a unified interface for save/load/clear/query.
// ---------------------------------------------------------------------------

/**
 * Object-oriented cache interface that wraps {@link saveRabeSession},
 * {@link loadRabeSession}, and {@link clearRabeSession} behind a single
 * injectable instance.
 *
 * Usage
 * ─────
 *   rabeSessionCache.save("GABC...", "testnet");
 *   const session = rabeSessionCache.load();   // RabeSessionState | null
 *   rabeSessionCache.clear();
 *
 * The singleton `rabeSessionCache` is exported for app-wide use.
 * Tests can construct a fresh `RabeSessionCache()` instance to avoid
 * shared-state side-effects.
 */
export class RabeSessionCache {
  /**
   * Persists the active address and network to localStorage.
   *
   * @param activeAddress - Stellar public key (G… address).
   * @param network       - Chain the session belongs to.
   */
  save(activeAddress: string, network: RabeNetwork): void {
    saveRabeSession(activeAddress, network);
  }

  /**
   * Loads the persisted session from localStorage.
   *
   * @returns The {@link RabeSessionState} or `null` when absent / invalid.
   */
  load(): RabeSessionState | null {
    return loadRabeSession();
  }

  /**
   * Returns the cached active address string, or `null` if no valid session
   * exists.  Convenience wrapper around {@link load}.
   */
  getAddress(): string | null {
    return this.load()?.activeAddress ?? null;
  }

  /**
   * Returns the cached network, or `null` if no valid session exists.
   */
  getNetwork(): RabeNetwork | null {
    return this.load()?.network ?? null;
  }

  /**
   * Removes the persisted session from localStorage.  Call this on wallet
   * disconnect to ensure no stale address survives a reload.
   */
  clear(): void {
    clearRabeSession();
  }

  /**
   * Returns `true` when a valid (non-stale, non-corrupt) session is currently
   * stored.
   */
  hasActiveSession(): boolean {
    return this.load() !== null;
  }
}

/** Shared singleton — import and use this instance throughout the app. */
export const rabeSessionCache = new RabeSessionCache();

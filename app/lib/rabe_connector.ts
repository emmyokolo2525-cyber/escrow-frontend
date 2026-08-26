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

// ─── Session State Persistence ───────────────────────────────────────────────

/** The shape of data cached in localStorage to remember the active Rabe address. */
export interface RabeSessionState {
  /** The active Stellar public key (G…) known to the Rabe connector. */
  activeAddress: string;
  /** Network the address was recorded on. */
  network: RabeNetwork;
  /** Unix-ms timestamp when the session was last saved. */
  connectedAt: number;
}

/** localStorage key used to persist Rabe session state. */
export const RABE_SESSION_KEY = "rabe_connector_session";

/**
 * Reads and validates the persisted Rabe session from localStorage.
 * Returns `null` when the key is absent, the JSON is malformed, or the
 * stored value does not satisfy the expected shape.  All errors are swallowed
 * so callers never have to handle storage failures.
 */
export function loadRabeSession(): RabeSessionState | null {
  try {
    const raw = localStorage.getItem(RABE_SESSION_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);

    // Validate shape — reject anything that does not look like RabeSessionState
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).activeAddress !== "string" ||
      !(parsed as Record<string, unknown>).activeAddress ||
      typeof (parsed as Record<string, unknown>).network !== "string" ||
      typeof (parsed as Record<string, unknown>).connectedAt !== "number"
    ) {
      localStorage.removeItem(RABE_SESSION_KEY);
      return null;
    }

    const candidate = parsed as RabeSessionState;

    // Validate the network value
    if (candidate.network !== "mainnet" && candidate.network !== "testnet") {
      localStorage.removeItem(RABE_SESSION_KEY);
      return null;
    }

    return candidate;
  } catch {
    // JSON.parse or localStorage threw — clean up and treat as no session
    try {
      localStorage.removeItem(RABE_SESSION_KEY);
    } catch {
      // Storage unavailable — nothing to remove
    }
    return null;
  }
}

/**
 * Serialises and writes a Rabe session to localStorage.
 * Any storage errors (e.g. private-browsing quota limits) are silently
 * swallowed so callers never have to handle storage failures.
 */
export function saveRabeSession(session: RabeSessionState): void {
  try {
    localStorage.setItem(RABE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable — continue without persistence
  }
}

/**
 * Removes the Rabe session entry from localStorage.
 * Safe to call even when no session exists.
 */
export function clearRabeSession(): void {
  try {
    localStorage.removeItem(RABE_SESSION_KEY);
  } catch {
    // Storage unavailable — nothing to clear
  }
}

/**
 * Manages the active-address session for the Rabe connector.
 *
 * Wraps `loadRabeSession`, `saveRabeSession`, and `clearRabeSession` behind a
 * simple stateful object so consumers can set / get / clear the active address
 * without touching localStorage directly.
 *
 * @example
 * ```ts
 * rabeSession.setActiveAddress("GABC…", "testnet");
 * const addr = rabeSession.getActiveAddress(); // "GABC…"
 * rabeSession.clearSession();
 * rabeSession.getActiveAddress();              // null
 * ```
 */
export class RabeSessionManager {
  /**
   * Persists `address` as the active Rabe address on `network`.
   * Emits a debug warning block so the change is visible in the dev console.
   */
  setActiveAddress(address: string, network: RabeNetwork): void {
    const session: RabeSessionState = {
      activeAddress: address,
      network,
      connectedAt: Date.now(),
    };
    saveRabeSession(session);
    logRabeWarning("SESSION SAVED", `Active address cached for ${network}`, {
      txId: undefined,
      phase: "idle",
    });
  }

  /**
   * Returns the active address from the persisted session, or `null` when no
   * valid session exists.
   */
  getActiveAddress(): string | null {
    return loadRabeSession()?.activeAddress ?? null;
  }

  /**
   * Returns the full persisted session object, or `null` when none exists.
   */
  getSession(): RabeSessionState | null {
    return loadRabeSession();
  }

  /**
   * Clears the persisted session and emits a debug warning block.
   */
  clearSession(): void {
    clearRabeSession();
    logRabeWarning("SESSION CLEARED", "Active address removed from cache", {
      txId: undefined,
      phase: "idle",
    });
  }
}

/** Singleton `RabeSessionManager` — use this throughout the app. */
export const rabeSession = new RabeSessionManager();

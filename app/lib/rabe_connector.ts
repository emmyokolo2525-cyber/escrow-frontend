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
// Session persistence — active address caching across reload cycles
// ---------------------------------------------------------------------------

/** Storage key used to persist the active Rabe session in localStorage. */
export const RABE_SESSION_STORAGE_KEY = "rabe_active_session";

/**
 * Shape of the serialized session stored in localStorage.
 * `address` is the active Stellar public key.
 * `savedAt` is a Unix-ms timestamp recorded when the session was written.
 */
export interface RabeActiveSession {
  address: string;
  savedAt: number;
}

/**
 * Maximum age (in milliseconds) a persisted session is considered valid.
 * Sessions older than this are rejected by {@link parseActiveSession}.
 * Default: 7 days.
 */
export const RABE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Safely parses and validates a raw JSON string (typically read from
 * localStorage) as a {@link RabeActiveSession}.
 *
 * Validation rules:
 * - Must be valid JSON.
 * - Must contain a non-empty `address` string field.
 * - Must contain a numeric `savedAt` field.
 * - The session must not be older than {@link RABE_SESSION_MAX_AGE_MS}.
 *
 * Returns `null` for any malformed or expired input.
 */
export function parseActiveSession(raw: string | null): RabeActiveSession | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.address !== "string" || obj.address.trim() === "") {
    return null;
  }

  if (typeof obj.savedAt !== "number" || !Number.isFinite(obj.savedAt)) {
    return null;
  }

  const age = Date.now() - obj.savedAt;
  if (age < 0 || age > RABE_SESSION_MAX_AGE_MS) {
    return null;
  }

  return { address: obj.address.trim(), savedAt: obj.savedAt };
}

/**
 * Writes the active address to localStorage so it can be restored on the next
 * page load.  Safe to call in SSR contexts — the write is skipped when
 * `localStorage` is unavailable.
 */
export function saveActiveSession(address: string): void {
  if (typeof localStorage === "undefined") return;

  const session: RabeActiveSession = { address, savedAt: Date.now() };
  localStorage.setItem(RABE_SESSION_STORAGE_KEY, JSON.stringify(session));
}

/**
 * Reads and validates the persisted session from localStorage.
 * Returns the parsed {@link RabeActiveSession} or `null` when no valid
 * session exists.  Safe to call in SSR contexts.
 */
export function loadActiveSession(): RabeActiveSession | null {
  if (typeof localStorage === "undefined") return null;

  const raw = localStorage.getItem(RABE_SESSION_STORAGE_KEY);
  return parseActiveSession(raw);
}

/**
 * Removes the persisted session from localStorage (e.g. on explicit wallet
 * disconnect).  Safe to call in SSR contexts.
 */
export function clearActiveSession(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(RABE_SESSION_STORAGE_KEY);
}

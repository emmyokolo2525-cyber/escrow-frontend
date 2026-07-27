import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRabeNetworkMatch,
  clearActiveSession,
  formatConsoleWarningBlock,
  formatStackTrace,
  loadActiveSession,
  logRabeWarning,
  parseActiveSession,
  RABE_SESSION_MAX_AGE_MS,
  RABE_SESSION_STORAGE_KEY,
  RabeActiveSession,
  RabeNetworkMismatchError,
  RabeTransactionTracker,
  rabeTracker,
  saveActiveSession,
  warnOnRabeNetworkMismatch,
} from "@/app/lib/rabe_connector";

describe("rabe_connector console warning blocks", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    rabeTracker.clear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("formats stack traces from Error instances", () => {
    const err = new Error("sign failed");
    const stack = formatStackTrace(err);

    expect(stack).toContain("Error: sign failed");
    expect(stack).toMatch(/at /);
  });

  it("synthesizes a stack when no Error is provided", () => {
    const stack = formatStackTrace();
    expect(stack).toContain("Error:");
    expect(stack.split("\n").length).toBeGreaterThan(1);
  });

  it("builds a console warning block that includes the stack trace format", () => {
    const stack = formatStackTrace(new Error("tx debug"));
    const block = formatConsoleWarningBlock({
      title: "TX SIGNING",
      body: "Awaiting wallet signature",
      stack,
      txId: "tx-abc",
      phase: "signing",
    });

    expect(block).toContain("[rabe_connector]");
    expect(block).toContain("TX SIGNING");
    expect(block).toContain("Awaiting wallet signature");
    expect(block).toContain("txId: tx-abc");
    expect(block).toContain("phase: signing");
    expect(block).toContain("--- stack trace ---");
    expect(block).toContain("--- end stack ---");
    expect(block).toContain("Error: tx debug");
  });

  it("logs formatted warning blocks (with stack) via console.warn", () => {
    const formatted = logRabeWarning("TX ERROR", "Submission failed", {
      err: new Error("network down"),
      txId: "tx-1",
      phase: "error",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(formatted);
    expect(formatted).toMatch(/--- stack trace ---[\s\S]*Error: network down/);
  });

  it("tracks transaction phases and logs a warning block per phase", () => {
    const tracker = new RabeTransactionTracker();

    tracker.track("tx-42", "building", "Preparing XDR");
    tracker.track("tx-42", "signing", "Prompting Rabe wallet");
    tracker.track(
      "tx-42",
      "error",
      "Wallet returned failure",
      new Error("device busy")
    );

    const history = tracker.getHistory("tx-42");
    expect(history).toHaveLength(3);
    expect(history.map((e) => e.phase)).toEqual([
      "building",
      "signing",
      "error",
    ]);
    expect(history[2].stack).toContain("Error: device busy");
    expect(warnSpy).toHaveBeenCalledTimes(3);

    const lastCall = String(warnSpy.mock.calls[2][0]);
    expect(lastCall).toContain("TX ERROR");
    expect(lastCall).toContain("--- stack trace ---");
  });

  it("isolates history by txId and clears tracking state", () => {
    const tracker = new RabeTransactionTracker();
    tracker.track("a", "idle", "start");
    tracker.track("b", "success", "done");

    expect(tracker.getHistory("a")).toHaveLength(1);
    expect(tracker.getHistory()).toHaveLength(2);

    tracker.clear();
    expect(tracker.getHistory()).toHaveLength(0);
  });
});

describe("rabe_connector network mismatch checks", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("reports no mismatch when networks align", () => {
    const state = checkRabeNetworkMatch("testnet", "testnet");
    expect(state.mismatched).toBe(false);
    expect(state.warningMessage).toBeNull();
  });

  it("builds a warning message when Mainnet vs Testnet diverge", () => {
    const state = checkRabeNetworkMatch("mainnet", "testnet");
    expect(state.mismatched).toBe(true);
    expect(state.walletNetwork).toBe("mainnet");
    expect(state.appNetwork).toBe("testnet");
    expect(state.warningMessage).toMatch(/Network mismatch/i);
    expect(state.warningMessage).toMatch(/Mainnet/);
    expect(state.warningMessage).toMatch(/Testnet/);
  });

  it("builds the inverse warning (testnet wallet on mainnet app)", () => {
    const state = checkRabeNetworkMatch("testnet", "mainnet");
    expect(state.mismatched).toBe(true);
    expect(state.warningMessage).toMatch(/Testnet/);
    expect(state.warningMessage).toMatch(/Mainnet/);
  });

  it("carries wallet and app networks on the mismatch error", () => {
    const err = new RabeNetworkMismatchError("mainnet", "testnet");
    expect(err.name).toBe("RabeNetworkMismatchError");
    expect(err.walletNetwork).toBe("mainnet");
    expect(err.appNetwork).toBe("testnet");
    expect(err.message).toMatch(/Network mismatch/i);
  });

  it("logs a formatted warning block on mismatch", () => {
    const state = warnOnRabeNetworkMismatch("mainnet", "testnet");

    expect(state.mismatched).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = String(warnSpy.mock.calls[0][0]);
    expect(logged).toContain("[rabe_connector]");
    expect(logged).toContain("NETWORK MISMATCH");
    expect(logged).toContain("--- stack trace ---");
    expect(logged).toContain("RabeNetworkMismatchError");
  });

  it("does not log when networks match", () => {
    const state = warnOnRabeNetworkMismatch("testnet", "testnet");
    expect(state.mismatched).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session persistence tests
// ---------------------------------------------------------------------------

describe("parseActiveSession — validation rules", () => {
  it("returns null for null input", () => {
    expect(parseActiveSession(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseActiveSession("")).toBeNull();
  });

  it("returns null for non-JSON string", () => {
    expect(parseActiveSession("not json")).toBeNull();
  });

  it("returns null when JSON is a primitive", () => {
    expect(parseActiveSession("42")).toBeNull();
    expect(parseActiveSession('"hello"')).toBeNull();
    expect(parseActiveSession("true")).toBeNull();
  });

  it("returns null when JSON is an array", () => {
    expect(parseActiveSession("[]")).toBeNull();
  });

  it("returns null when address field is missing", () => {
    const raw = JSON.stringify({ savedAt: Date.now() });
    expect(parseActiveSession(raw)).toBeNull();
  });

  it("returns null when address field is not a string", () => {
    const raw = JSON.stringify({ address: 123, savedAt: Date.now() });
    expect(parseActiveSession(raw)).toBeNull();
  });

  it("returns null when address is an empty string", () => {
    const raw = JSON.stringify({ address: "   ", savedAt: Date.now() });
    expect(parseActiveSession(raw)).toBeNull();
  });

  it("returns null when savedAt field is missing", () => {
    const raw = JSON.stringify({ address: "GABCDEF" });
    expect(parseActiveSession(raw)).toBeNull();
  });

  it("returns null when savedAt is not a finite number", () => {
    const rawNaN = JSON.stringify({ address: "GABCDEF", savedAt: NaN });
    const rawInf = JSON.stringify({ address: "GABCDEF", savedAt: Infinity });
    const rawStr = JSON.stringify({ address: "GABCDEF", savedAt: "123" });
    // JSON.stringify strips NaN/Infinity to null, test string variant
    expect(parseActiveSession(rawStr)).toBeNull();
    // NaN serialises to null in JSON
    expect(parseActiveSession(rawNaN)).toBeNull();
    // Infinity serialises to null in JSON
    expect(parseActiveSession(rawInf)).toBeNull();
  });

  it("returns null when the session is older than RABE_SESSION_MAX_AGE_MS", () => {
    const expiredAt = Date.now() - RABE_SESSION_MAX_AGE_MS - 1000;
    const raw = JSON.stringify({ address: "GABCDEF", savedAt: expiredAt });
    expect(parseActiveSession(raw)).toBeNull();
  });

  it("returns null when savedAt is in the future beyond tolerance", () => {
    // Negative age (future timestamp) should also be rejected
    const futureAt = Date.now() + 1000;
    const raw = JSON.stringify({ address: "GABCDEF", savedAt: futureAt });
    expect(parseActiveSession(raw)).toBeNull();
  });

  it("returns a valid RabeActiveSession for a fresh, well-formed entry", () => {
    const now = Date.now();
    const raw = JSON.stringify({ address: "GABCDEF1234", savedAt: now });
    const result = parseActiveSession(raw);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("GABCDEF1234");
    expect(result!.savedAt).toBe(now);
  });

  it("trims whitespace from the address field", () => {
    const raw = JSON.stringify({ address: "  GABCDEF  ", savedAt: Date.now() });
    const result = parseActiveSession(raw);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("GABCDEF");
  });

  it("ignores extra unknown fields in the stored object", () => {
    const raw = JSON.stringify({
      address: "GABCDEF",
      savedAt: Date.now(),
      extraField: "should be ignored",
    });
    const result = parseActiveSession(raw);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("GABCDEF");
    expect((result as unknown as Record<string, unknown>).extraField).toBeUndefined();
  });
});

describe("saveActiveSession / loadActiveSession / clearActiveSession — localStorage integration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("saveActiveSession writes a JSON entry under RABE_SESSION_STORAGE_KEY", () => {
    saveActiveSession("GTEST1234");
    const raw = localStorage.getItem(RABE_SESSION_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.address).toBe("GTEST1234");
    expect(typeof parsed.savedAt).toBe("number");
  });

  it("loadActiveSession returns null when nothing is stored", () => {
    expect(loadActiveSession()).toBeNull();
  });

  it("loadActiveSession returns the session that was previously saved", () => {
    saveActiveSession("GACTIVE5678");
    const session = loadActiveSession();
    expect(session).not.toBeNull();
    expect(session!.address).toBe("GACTIVE5678");
  });

  it("loadActiveSession returns null after clearActiveSession is called", () => {
    saveActiveSession("GACTIVE5678");
    clearActiveSession();
    expect(loadActiveSession()).toBeNull();
  });

  it("clearActiveSession removes the key from localStorage", () => {
    saveActiveSession("GTEST9999");
    clearActiveSession();
    expect(localStorage.getItem(RABE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("saveActiveSession records savedAt close to the current time", () => {
    const before = Date.now();
    saveActiveSession("GTIMECHECK");
    const after = Date.now();

    const raw = localStorage.getItem(RABE_SESSION_STORAGE_KEY)!;
    const { savedAt } = JSON.parse(raw) as RabeActiveSession;
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(after);
  });

  it("overwriting a saved session replaces the previous address", () => {
    saveActiveSession("GFIRST");
    saveActiveSession("GSECOND");
    const session = loadActiveSession();
    expect(session!.address).toBe("GSECOND");
  });
});

describe("rabe_connector — reload cycle simulation", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("persists and restores an active address across a simulated reload", () => {
    // Simulate: user connects wallet, address is saved
    const originalAddress = "GRELOAD_STELLAR_ADDRESS_XYZ";
    saveActiveSession(originalAddress);

    // Simulate: page reloads — read back from storage
    const restored = loadActiveSession();

    expect(restored).not.toBeNull();
    expect(restored!.address).toBe(originalAddress);
  });

  it("does not restore an expired session after a simulated reload", () => {
    // Manually write an expired session directly to localStorage
    const expired: RabeActiveSession = {
      address: "GEXPIRED",
      savedAt: Date.now() - RABE_SESSION_MAX_AGE_MS - 5000,
    };
    localStorage.setItem(RABE_SESSION_STORAGE_KEY, JSON.stringify(expired));

    // Simulate reload — loadActiveSession should reject it
    const restored = loadActiveSession();
    expect(restored).toBeNull();
  });

  it("does not restore a malformed session after a simulated reload", () => {
    localStorage.setItem(RABE_SESSION_STORAGE_KEY, "{{bad json}}");
    expect(loadActiveSession()).toBeNull();
  });

  it("returns null after explicit disconnect clears the session", () => {
    saveActiveSession("GDISCONNECT_TEST");
    clearActiveSession(); // simulate disconnect

    // Reload — nothing should be found
    expect(loadActiveSession()).toBeNull();
  });

  it("exposes RABE_SESSION_STORAGE_KEY as a string constant", () => {
    expect(typeof RABE_SESSION_STORAGE_KEY).toBe("string");
    expect(RABE_SESSION_STORAGE_KEY.length).toBeGreaterThan(0);
  });

  it("exposes RABE_SESSION_MAX_AGE_MS as a positive finite number", () => {
    expect(typeof RABE_SESSION_MAX_AGE_MS).toBe("number");
    expect(RABE_SESSION_MAX_AGE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(RABE_SESSION_MAX_AGE_MS)).toBe(true);
  });
});

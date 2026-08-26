import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRabeNetworkMatch,
  clearRabeSession,
  formatConsoleWarningBlock,
  formatStackTrace,
  loadRabeSession,
  logRabeWarning,
  RabeNetworkMismatchError,
  RabeSessionManager,
  rabeSession,
  RABE_SESSION_KEY,
  RabeTransactionTracker,
  rabeTracker,
  saveRabeSession,
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

// ─── Session State Persistence Tests ─────────────────────────────────────────

describe("loadRabeSession / saveRabeSession / clearRabeSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ── saveRabeSession ──────────────────────────────────────────────────────

  it("saves a valid session to localStorage under RABE_SESSION_KEY", () => {
    const before = Date.now();
    saveRabeSession({
      activeAddress: "GABC123",
      network: "testnet",
      connectedAt: before,
    });
    const raw = localStorage.getItem(RABE_SESSION_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.activeAddress).toBe("GABC123");
    expect(parsed.network).toBe("testnet");
    expect(parsed.connectedAt).toBe(before);
  });

  it("overwrites an existing session when called a second time", () => {
    saveRabeSession({ activeAddress: "GOLD1", network: "testnet", connectedAt: 100 });
    saveRabeSession({ activeAddress: "GOLD2", network: "mainnet", connectedAt: 200 });
    const session = loadRabeSession();
    expect(session?.activeAddress).toBe("GOLD2");
    expect(session?.network).toBe("mainnet");
  });

  // ── loadRabeSession ──────────────────────────────────────────────────────

  it("returns null when localStorage is empty", () => {
    expect(loadRabeSession()).toBeNull();
  });

  it("returns a correctly-typed session after saving one", () => {
    const now = Date.now();
    saveRabeSession({ activeAddress: "GTEST999", network: "testnet", connectedAt: now });

    const session = loadRabeSession();
    expect(session).not.toBeNull();
    expect(session!.activeAddress).toBe("GTEST999");
    expect(session!.network).toBe("testnet");
    expect(session!.connectedAt).toBe(now);
  });

  it("returns null and removes the key when JSON is malformed", () => {
    localStorage.setItem(RABE_SESSION_KEY, "{{not-valid-json}}");
    expect(loadRabeSession()).toBeNull();
    // Key should be gone so the bad data is not persisted
    expect(localStorage.getItem(RABE_SESSION_KEY)).toBeNull();
  });

  it("returns null and removes the key when activeAddress is missing", () => {
    localStorage.setItem(
      RABE_SESSION_KEY,
      JSON.stringify({ network: "testnet", connectedAt: 1 })
    );
    expect(loadRabeSession()).toBeNull();
    expect(localStorage.getItem(RABE_SESSION_KEY)).toBeNull();
  });

  it("returns null and removes the key when activeAddress is an empty string", () => {
    localStorage.setItem(
      RABE_SESSION_KEY,
      JSON.stringify({ activeAddress: "", network: "testnet", connectedAt: 1 })
    );
    expect(loadRabeSession()).toBeNull();
    expect(localStorage.getItem(RABE_SESSION_KEY)).toBeNull();
  });

  it("returns null and removes the key when network is missing", () => {
    localStorage.setItem(
      RABE_SESSION_KEY,
      JSON.stringify({ activeAddress: "GABC", connectedAt: 1 })
    );
    expect(loadRabeSession()).toBeNull();
    expect(localStorage.getItem(RABE_SESSION_KEY)).toBeNull();
  });

  it("returns null and removes the key when network value is invalid", () => {
    localStorage.setItem(
      RABE_SESSION_KEY,
      JSON.stringify({ activeAddress: "GABC", network: "banana", connectedAt: 1 })
    );
    expect(loadRabeSession()).toBeNull();
    expect(localStorage.getItem(RABE_SESSION_KEY)).toBeNull();
  });

  it("returns null and removes the key when connectedAt is not a number", () => {
    localStorage.setItem(
      RABE_SESSION_KEY,
      JSON.stringify({ activeAddress: "GABC", network: "testnet", connectedAt: "now" })
    );
    expect(loadRabeSession()).toBeNull();
    expect(localStorage.getItem(RABE_SESSION_KEY)).toBeNull();
  });

  it("returns null when stored value is a JSON string (not object)", () => {
    localStorage.setItem(RABE_SESSION_KEY, JSON.stringify("just-a-string"));
    expect(loadRabeSession()).toBeNull();
  });

  it("returns null when stored value is null JSON literal", () => {
    localStorage.setItem(RABE_SESSION_KEY, "null");
    expect(loadRabeSession()).toBeNull();
  });

  it("accepts mainnet as a valid network", () => {
    saveRabeSession({ activeAddress: "GMAIN", network: "mainnet", connectedAt: 42 });
    const session = loadRabeSession();
    expect(session?.network).toBe("mainnet");
  });

  // ── clearRabeSession ─────────────────────────────────────────────────────

  it("removes the localStorage key on clearRabeSession", () => {
    saveRabeSession({ activeAddress: "GABC", network: "testnet", connectedAt: 1 });
    clearRabeSession();
    expect(localStorage.getItem(RABE_SESSION_KEY)).toBeNull();
  });

  it("is idempotent — clearRabeSession on empty storage does not throw", () => {
    expect(() => clearRabeSession()).not.toThrow();
    expect(loadRabeSession()).toBeNull();
  });

  // ── round-trip (simulating a page reload) ────────────────────────────────

  it("round-trips the active address across a simulated reload", () => {
    // Simulate: user connects → session saved
    const address = "GRELOAD1234567890ABCDEF";
    saveRabeSession({ activeAddress: address, network: "testnet", connectedAt: Date.now() });

    // Simulate: page reloads → session loaded
    const restoredSession = loadRabeSession();
    expect(restoredSession).not.toBeNull();
    expect(restoredSession!.activeAddress).toBe(address);
    expect(restoredSession!.network).toBe("testnet");
  });
});

// ─── RabeSessionManager tests ─────────────────────────────────────────────────

describe("RabeSessionManager", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let manager: RabeSessionManager;

  beforeEach(() => {
    localStorage.clear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    manager = new RabeSessionManager();
  });

  afterEach(() => {
    localStorage.clear();
    warnSpy.mockRestore();
  });

  it("returns null before any address is set", () => {
    expect(manager.getActiveAddress()).toBeNull();
  });

  it("persists and retrieves an active address on testnet", () => {
    manager.setActiveAddress("GTEST_ADDR_1", "testnet");
    expect(manager.getActiveAddress()).toBe("GTEST_ADDR_1");
  });

  it("persists and retrieves an active address on mainnet", () => {
    manager.setActiveAddress("GMAIN_ADDR_1", "mainnet");
    expect(manager.getActiveAddress()).toBe("GMAIN_ADDR_1");
  });

  it("getSession returns the full RabeSessionState", () => {
    const before = Date.now();
    manager.setActiveAddress("GFULL_SESSION", "testnet");
    const session = manager.getSession();

    expect(session).not.toBeNull();
    expect(session!.activeAddress).toBe("GFULL_SESSION");
    expect(session!.network).toBe("testnet");
    expect(session!.connectedAt).toBeGreaterThanOrEqual(before);
  });

  it("clearSession removes the persisted address", () => {
    manager.setActiveAddress("GWILL_CLEAR", "testnet");
    manager.clearSession();
    expect(manager.getActiveAddress()).toBeNull();
    expect(manager.getSession()).toBeNull();
  });

  it("setActiveAddress overwrites a previously stored address", () => {
    manager.setActiveAddress("GADDR_FIRST", "testnet");
    manager.setActiveAddress("GADDR_SECOND", "mainnet");
    expect(manager.getActiveAddress()).toBe("GADDR_SECOND");
    expect(manager.getSession()!.network).toBe("mainnet");
  });

  it("emits a SESSION SAVED warning block on setActiveAddress", () => {
    manager.setActiveAddress("GABC", "testnet");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = String(warnSpy.mock.calls[0][0]);
    expect(logged).toContain("[rabe_connector]");
    expect(logged).toContain("SESSION SAVED");
  });

  it("emits a SESSION CLEARED warning block on clearSession", () => {
    manager.setActiveAddress("GABC", "testnet");
    warnSpy.mockClear();

    manager.clearSession();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = String(warnSpy.mock.calls[0][0]);
    expect(logged).toContain("SESSION CLEARED");
  });

  it("getActiveAddress returns null after clearSession even with stale localStorage", () => {
    // Manually write a stale value so the raw key exists
    localStorage.setItem(
      RABE_SESSION_KEY,
      JSON.stringify({ activeAddress: "GSTALE", network: "testnet", connectedAt: 1 })
    );
    manager.clearSession();
    expect(manager.getActiveAddress()).toBeNull();
  });

  it("survives a simulated page reload — active address persists across new manager instance", () => {
    // First 'page': set the address
    const firstManager = new RabeSessionManager();
    firstManager.setActiveAddress("GPERSIST_ACROSS_RELOAD", "testnet");

    // Second 'page' (new instance, same localStorage): load the session
    const secondManager = new RabeSessionManager();
    expect(secondManager.getActiveAddress()).toBe("GPERSIST_ACROSS_RELOAD");
  });

  it("getSession returns null when localStorage holds invalid data", () => {
    localStorage.setItem(RABE_SESSION_KEY, "not-json");
    expect(manager.getSession()).toBeNull();
  });
});

// ─── rabeSession singleton tests ──────────────────────────────────────────────

describe("rabeSession singleton", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    localStorage.clear();
    warnSpy.mockRestore();
  });

  it("is exported as a RabeSessionManager instance", () => {
    expect(rabeSession).toBeInstanceOf(RabeSessionManager);
  });

  it("can set and get active address via the singleton", () => {
    rabeSession.setActiveAddress("GSINGLETON_ADDR", "testnet");
    expect(rabeSession.getActiveAddress()).toBe("GSINGLETON_ADDR");
  });

  it("clearSession via singleton removes the stored address", () => {
    rabeSession.setActiveAddress("GSINGLETON_CLEAR", "testnet");
    rabeSession.clearSession();
    expect(rabeSession.getActiveAddress()).toBeNull();
  });
});

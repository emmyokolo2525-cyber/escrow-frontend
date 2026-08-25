import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRabeNetworkMatch,
  clearRabeSession,
  formatConsoleWarningBlock,
  formatStackTrace,
  loadRabeSession,
  logRabeWarning,
  RABE_SESSION_CACHE_KEY,
  RabeNetworkMismatchError,
  rabeSessionCache,
  RabeSessionCache,
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

// ---------------------------------------------------------------------------
// Persistent session cache tests
// ---------------------------------------------------------------------------

/** A valid Stellar G-key used throughout the caching tests. */
const VALID_ADDRESS = "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP";

describe("rabe_connector persistent session cache", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Provide an in-memory localStorage shim for every test.
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    });

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  // --- saveRabeSession ---

  it("saves a session with the correct shape to localStorage", () => {
    saveRabeSession(VALID_ADDRESS, "testnet");

    const raw = localStorage.getItem(RABE_SESSION_CACHE_KEY);
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw!);
    expect(parsed.activeAddress).toBe(VALID_ADDRESS);
    expect(parsed.network).toBe("testnet");
    expect(typeof parsed.cachedAt).toBe("number");
    expect(parsed.cachedAt).toBeGreaterThan(0);
  });

  it("saves a mainnet session correctly", () => {
    saveRabeSession(VALID_ADDRESS, "mainnet");

    const raw = localStorage.getItem(RABE_SESSION_CACHE_KEY);
    const parsed = JSON.parse(raw!);
    expect(parsed.network).toBe("mainnet");
  });

  it("overwrites an existing cache entry when called again", () => {
    const OTHER_ADDRESS = "GBMU3L4W6V75GZVI5BF35FSNMRHB5JZSD3U7FPXCUKYVQINBT4PPLPNL" as const;
    saveRabeSession(VALID_ADDRESS, "testnet");
    saveRabeSession(OTHER_ADDRESS, "mainnet");

    const raw = localStorage.getItem(RABE_SESSION_CACHE_KEY);
    const parsed = JSON.parse(raw!);
    expect(parsed.activeAddress).toBe(OTHER_ADDRESS);
    expect(parsed.network).toBe("mainnet");
  });

  it("logs a warning and does not throw when localStorage.setItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });

    expect(() => saveRabeSession(VALID_ADDRESS, "testnet")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("SESSION CACHE WRITE FAILED");
  });

  // --- loadRabeSession ---

  it("loads a previously saved session correctly (simulates reload)", () => {
    saveRabeSession(VALID_ADDRESS, "testnet");

    // Simulate a reload by calling loadRabeSession in isolation.
    const session = loadRabeSession();

    expect(session).not.toBeNull();
    expect(session!.activeAddress).toBe(VALID_ADDRESS);
    expect(session!.network).toBe("testnet");
    expect(typeof session!.cachedAt).toBe("number");
  });

  it("returns null when no session has been saved", () => {
    const session = loadRabeSession();
    expect(session).toBeNull();
  });

  it("returns null and clears the entry when the stored JSON is malformed", () => {
    localStorage.setItem(RABE_SESSION_CACHE_KEY, "not-valid-json{{{{");

    const session = loadRabeSession();
    expect(session).toBeNull();
    // The corrupt entry should be removed.
    expect(localStorage.getItem(RABE_SESSION_CACHE_KEY)).toBeNull();
  });

  it("rejects and clears a payload that is missing the activeAddress field", () => {
    localStorage.setItem(
      RABE_SESSION_CACHE_KEY,
      JSON.stringify({ network: "testnet", cachedAt: Date.now() })
    );

    const session = loadRabeSession();
    expect(session).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("SESSION CACHE INVALID");
    // The invalid entry must be evicted.
    expect(localStorage.getItem(RABE_SESSION_CACHE_KEY)).toBeNull();
  });

  it("rejects a payload with an invalid (non-G-key) activeAddress", () => {
    localStorage.setItem(
      RABE_SESSION_CACHE_KEY,
      JSON.stringify({
        activeAddress: "not-a-stellar-key",
        network: "testnet",
        cachedAt: Date.now(),
      })
    );

    const session = loadRabeSession();
    expect(session).toBeNull();
    expect(localStorage.getItem(RABE_SESSION_CACHE_KEY)).toBeNull();
  });

  it("rejects a payload with an unknown network value", () => {
    localStorage.setItem(
      RABE_SESSION_CACHE_KEY,
      JSON.stringify({
        activeAddress: VALID_ADDRESS,
        network: "devnet", // invalid
        cachedAt: Date.now(),
      })
    );

    const session = loadRabeSession();
    expect(session).toBeNull();
  });

  it("rejects a payload where cachedAt is not a number", () => {
    localStorage.setItem(
      RABE_SESSION_CACHE_KEY,
      JSON.stringify({
        activeAddress: VALID_ADDRESS,
        network: "testnet",
        cachedAt: "yesterday",
      })
    );

    expect(loadRabeSession()).toBeNull();
  });

  it("rejects an empty-string activeAddress", () => {
    localStorage.setItem(
      RABE_SESSION_CACHE_KEY,
      JSON.stringify({
        activeAddress: "",
        network: "testnet",
        cachedAt: Date.now(),
      })
    );

    expect(loadRabeSession()).toBeNull();
  });

  it("logs a warning and returns null when localStorage.getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
      removeItem: () => {},
    });

    const session = loadRabeSession();
    expect(session).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("SESSION CACHE READ FAILED");
  });

  // --- clearRabeSession ---

  it("removes the persisted session on clearRabeSession", () => {
    saveRabeSession(VALID_ADDRESS, "testnet");
    expect(localStorage.getItem(RABE_SESSION_CACHE_KEY)).not.toBeNull();

    clearRabeSession();
    expect(localStorage.getItem(RABE_SESSION_CACHE_KEY)).toBeNull();
  });

  it("does not throw when clearRabeSession is called with no cached session", () => {
    expect(() => clearRabeSession()).not.toThrow();
  });

  it("logs a warning and does not throw when localStorage.removeItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });

    expect(() => clearRabeSession()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("SESSION CACHE CLEAR FAILED");
  });

  // --- round-trip: save → load → clear ---

  it("full round-trip: save, reload, then clear", () => {
    saveRabeSession(VALID_ADDRESS, "testnet");

    const loaded = loadRabeSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.activeAddress).toBe(VALID_ADDRESS);
    expect(loaded!.network).toBe("testnet");

    clearRabeSession();
    expect(loadRabeSession()).toBeNull();
  });

  it("RABE_SESSION_CACHE_KEY is a non-empty string constant", () => {
    expect(typeof RABE_SESSION_CACHE_KEY).toBe("string");
    expect(RABE_SESSION_CACHE_KEY.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// RabeSessionCache class tests
// ---------------------------------------------------------------------------

describe("RabeSessionCache", () => {
  const VALID_ADDRESS = "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP";
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.clear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    localStorage.clear();
  });

  it("save() persists the address and network to localStorage", () => {
    const cache = new RabeSessionCache();
    cache.save(VALID_ADDRESS, "testnet");

    const raw = localStorage.getItem(RABE_SESSION_CACHE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.activeAddress).toBe(VALID_ADDRESS);
    expect(parsed.network).toBe("testnet");
  });

  it("load() returns null when nothing is stored", () => {
    const cache = new RabeSessionCache();
    expect(cache.load()).toBeNull();
  });

  it("load() returns the stored session after save()", () => {
    const cache = new RabeSessionCache();
    cache.save(VALID_ADDRESS, "mainnet");

    const session = cache.load();
    expect(session).not.toBeNull();
    expect(session!.activeAddress).toBe(VALID_ADDRESS);
    expect(session!.network).toBe("mainnet");
  });

  it("getAddress() returns the active address when a valid session exists", () => {
    const cache = new RabeSessionCache();
    cache.save(VALID_ADDRESS, "testnet");
    expect(cache.getAddress()).toBe(VALID_ADDRESS);
  });

  it("getAddress() returns null when no session is stored", () => {
    const cache = new RabeSessionCache();
    expect(cache.getAddress()).toBeNull();
  });

  it("getNetwork() returns the network when a valid session exists", () => {
    const cache = new RabeSessionCache();
    cache.save(VALID_ADDRESS, "testnet");
    expect(cache.getNetwork()).toBe("testnet");
  });

  it("getNetwork() returns null when no session is stored", () => {
    const cache = new RabeSessionCache();
    expect(cache.getNetwork()).toBeNull();
  });

  it("clear() removes the entry from localStorage", () => {
    const cache = new RabeSessionCache();
    cache.save(VALID_ADDRESS, "testnet");
    expect(localStorage.getItem(RABE_SESSION_CACHE_KEY)).not.toBeNull();

    cache.clear();
    expect(localStorage.getItem(RABE_SESSION_CACHE_KEY)).toBeNull();
  });

  it("clear() is safe to call when nothing is stored", () => {
    const cache = new RabeSessionCache();
    expect(() => cache.clear()).not.toThrow();
  });

  it("hasActiveSession() returns false when nothing is stored", () => {
    const cache = new RabeSessionCache();
    expect(cache.hasActiveSession()).toBe(false);
  });

  it("hasActiveSession() returns true after save()", () => {
    const cache = new RabeSessionCache();
    cache.save(VALID_ADDRESS, "testnet");
    expect(cache.hasActiveSession()).toBe(true);
  });

  it("hasActiveSession() returns false after clear()", () => {
    const cache = new RabeSessionCache();
    cache.save(VALID_ADDRESS, "testnet");
    cache.clear();
    expect(cache.hasActiveSession()).toBe(false);
  });

  it("session survives a simulated page reload (new instance reads same storage)", () => {
    const firstInstance = new RabeSessionCache();
    firstInstance.save(VALID_ADDRESS, "testnet");

    // Simulate reload: new instance, same localStorage.
    const secondInstance = new RabeSessionCache();
    const session = secondInstance.load();

    expect(session).not.toBeNull();
    expect(session!.activeAddress).toBe(VALID_ADDRESS);
    expect(session!.network).toBe("testnet");
  });

  it("overwriting the session updates both address and network", () => {
    const SECOND_ADDRESS = "GBDPECJ65UVZSBB4GZWZFBKX6NYFOLEQVS7PCFMM33GZWXBAJ27HX73X";
    const cache = new RabeSessionCache();

    cache.save(VALID_ADDRESS, "testnet");
    cache.save(SECOND_ADDRESS, "mainnet");

    expect(cache.getAddress()).toBe(SECOND_ADDRESS);
    expect(cache.getNetwork()).toBe("mainnet");
  });

  it("full round-trip via RabeSessionCache: save → load → clear", () => {
    const cache = new RabeSessionCache();

    cache.save(VALID_ADDRESS, "testnet");
    const loaded = cache.load();
    expect(loaded!.activeAddress).toBe(VALID_ADDRESS);

    cache.clear();
    expect(cache.hasActiveSession()).toBe(false);
  });
});

describe("rabeSessionCache singleton", () => {
  const VALID_ADDRESS = "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP";
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.clear();
    rabeSessionCache.clear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    localStorage.clear();
    rabeSessionCache.clear();
  });

  it("exports a RabeSessionCache instance as the default singleton", () => {
    expect(rabeSessionCache).toBeInstanceOf(RabeSessionCache);
  });

  it("singleton save() writes to the shared RABE_SESSION_CACHE_KEY", () => {
    rabeSessionCache.save(VALID_ADDRESS, "testnet");
    const raw = localStorage.getItem(RABE_SESSION_CACHE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).activeAddress).toBe(VALID_ADDRESS);
  });

  it("singleton getAddress() returns the saved address", () => {
    rabeSessionCache.save(VALID_ADDRESS, "mainnet");
    expect(rabeSessionCache.getAddress()).toBe(VALID_ADDRESS);
  });

  it("singleton clear() removes the persisted session", () => {
    rabeSessionCache.save(VALID_ADDRESS, "testnet");
    rabeSessionCache.clear();
    expect(rabeSessionCache.hasActiveSession()).toBe(false);
  });
});

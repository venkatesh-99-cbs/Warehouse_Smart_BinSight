import { expect, afterEach, vi } from "vitest";

// Global test setup
afterEach(() => {
  vi.clearAllMocks();
});

// Polyfills for jsdom
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}

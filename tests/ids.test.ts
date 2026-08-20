import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalCryptoDescriptor: PropertyDescriptor | undefined;

function defineCrypto(value: unknown): void {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

beforeEach(() => {
  originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCryptoDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "crypto");
  } else {
    Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
  }
  vi.resetModules();
});

describe("createId", () => {
  it("returns the browser random UUID when available", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const randomUUID = vi.fn(() => uuid);
    defineCrypto({ randomUUID });
    const { createId } = await import("../src/utils/ids");

    expect(createId()).toBe(uuid);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("uses the deterministic fallback when crypto is unavailable", async () => {
    expect(Reflect.deleteProperty(globalThis, "crypto")).toBe(true);
    const now = vi.spyOn(Date, "now").mockReturnValue(36);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { createId } = await import("../src/utils/ids");

    expect(createId()).toBe("10-i");
    expect(now).toHaveBeenCalledOnce();
    expect(random).toHaveBeenCalledOnce();
  });

  it("uses the deterministic fallback when crypto has no randomUUID", async () => {
    defineCrypto({});
    const now = vi.spyOn(Date, "now").mockReturnValue(71);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
    const { createId } = await import("../src/utils/ids");

    expect(createId()).toBe("1z-9");
    expect(now).toHaveBeenCalledOnce();
    expect(random).toHaveBeenCalledOnce();
  });
});

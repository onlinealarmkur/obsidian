import { describe, expect, it } from "vitest";
import { EN_I18N } from "../src/i18n";
import { formatDateTime } from "../src/utils/formatting";

describe("date-time formatting", () => {
  it.each([Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN])("returns a stable fallback for unrenderable timestamp %s", (timestamp) => {
    expect(() => formatDateTime(timestamp, false, EN_I18N)).not.toThrow();
    expect(formatDateTime(timestamp, false, EN_I18N)).toBe("Invalid date");
  });

  it.each([-8_640_000_000_000_000, 0, 8_640_000_000_000_000])("formats renderable timestamp %s", (timestamp) => {
    expect(() => formatDateTime(timestamp, true, EN_I18N)).not.toThrow();
    expect(formatDateTime(timestamp, true, EN_I18N)).not.toBe("Invalid date");
  });
});

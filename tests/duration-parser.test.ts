import { describe, expect, it } from "vitest";
import { MAX_DURATION_MS } from "../src/constants";
import { parseDuration } from "../src/utils/duration-parser";

describe("parseDuration", () => {
  it.each([
    ["90s", 90_000], ["10m", 600_000], ["1h", 3_600_000],
    ["1h 30m", 5_400_000], ["01:30", 90_000], ["01:30:00", 5_400_000]
  ])("parses %s", (input, expected) => expect(parseDuration(input).milliseconds).toBe(expected));

  it.each(["", "0s", "-1m", "hello", "00:60", "31d", "721h"])("rejects %s", (input) => {
    expect(parseDuration(input).error).toBeTypeOf("string");
  });

  it.each([
    ["1s", 1_000],
    ["00:01", 1_000],
    ["0h 0m 1s", 1_000],
    ["  1H 2M 3S  ", 3_723_000],
    ["43200m", MAX_DURATION_MS],
    ["720:00:00", MAX_DURATION_MS]
  ])("accepts the documented boundaries and normalized input %s", (input, expected) => {
    expect(parseDuration(input)).toEqual({ milliseconds: expected });
  });

  it.each([
    ["   ", "required"],
    ["0:00", "minimum"],
    ["00:00", "minimum"],
    ["0h 0m 0s", "minimum"],
    ["43200m 1s", "maximum"],
    ["720h 1s", "maximum"],
    ["720:00:01", "maximum"],
    ["1.5m", "invalid-format"],
    ["+1m", "invalid-format"],
    ["1m 1m", "invalid-format"],
    ["1:2", "invalid-format"],
    ["01:02:03:04", "invalid-format"],
    ["１２m", "invalid-format"],
    ["1\u00a0h", "invalid-format"]
  ] as const)("classifies hostile or ambiguous input %s", (input, error) => {
    expect(parseDuration(input)).toEqual({ error });
  });
});

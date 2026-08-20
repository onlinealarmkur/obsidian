import { DEFAULT_DATA, DEFAULT_SETTINGS } from "../types";
import { SCHEMA_VERSION } from "../constants";

export class UnsupportedSchemaVersionError extends Error {
  public override readonly name = "UnsupportedSchemaVersionError";

  public constructor(
    public readonly storedVersion: number,
    public readonly supportedVersion: number
  ) {
    super(`Stored schema version ${storedVersion} is newer than supported version ${supportedVersion}.`);
  }
}

export type InvalidSchemaVersionClassification = "fractional" | "negative" | "non-finite" | "wrong-type";

export class InvalidSchemaVersionError extends Error {
  public override readonly name = "InvalidSchemaVersionError";

  public constructor(
    public readonly classification: InvalidSchemaVersionClassification,
    public readonly storedVersion?: number,
    public readonly storedType?: string
  ) {
    super(`Stored schema version is invalid (${classification}).`);
  }
}

export function migrateData(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return DEFAULT_DATA;
  const record = raw as Record<string, unknown>;
  let version = 0;
  if (Object.prototype.hasOwnProperty.call(record, "schemaVersion")) {
    const storedVersion = record.schemaVersion;
    if (typeof storedVersion !== "number") {
      throw new InvalidSchemaVersionError("wrong-type", undefined, typeof storedVersion);
    }
    if (!Number.isFinite(storedVersion)) {
      throw new InvalidSchemaVersionError("non-finite", storedVersion);
    }
    if (!Number.isInteger(storedVersion)) {
      throw new InvalidSchemaVersionError("fractional", storedVersion);
    }
    if (storedVersion < 0) {
      throw new InvalidSchemaVersionError("negative", storedVersion);
    }
    if (storedVersion > SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(storedVersion, SCHEMA_VERSION);
    }
    version = storedVersion;
  }
  if (version === 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: { ...DEFAULT_SETTINGS, ...(isRecord(record.settings) ? record.settings : {}) },
      items: migrateLegacyFiredItems(record.items)
    };
  }
  if (version === 1) {
    return {
      ...record,
      schemaVersion: SCHEMA_VERSION,
      items: migrateLegacyFiredItems(record.items)
    };
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function migrateLegacyFiredItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const candidates: unknown[] = value;
  return candidates.map((candidate) => {
    if (!isRecord(candidate) || candidate.status !== "fired") return candidate;
    const completedAt = typeof candidate.firedAt === "number"
      ? candidate.firedAt
      : typeof candidate.targetAt === "number"
        ? candidate.targetAt
        : undefined;
    return {
      ...candidate,
      status: "completed",
      ...(completedAt === undefined ? {} : { completedAt })
    };
  });
}

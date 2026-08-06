import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem, parseSavePackage } from "@mandate/save-system";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

interface ZipEntryLocation {
  readonly centralOffset: number;
  readonly localOffset: number;
  readonly centralDirectoryOffset: number;
  readonly eocdOffset: number;
}

let archive: Uint8Array;
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

beforeEach(async () => {
  const system = createSaveSystem({
    databasePath: ":memory:",
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  cleanup.push(() => system.close());
  await system.service.createSave({
    saveId: "save_zip_headers",
    scenarioId: "chongzhen-early",
    title: "zip headers",
    seed: "zip-headers",
  });
  archive = (
    await system.service.exportSave("save_zip_headers", {
      includeSourceMetadata: false,
      safeShareMode: "none",
    })
  ).bytes;
});

function locateEntries(bytes: Uint8Array): ZipEntryLocation[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  const entries: ZipEntryLocation[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      centralOffset: offset,
      localOffset: view.getUint32(offset + 42, true),
      centralDirectoryOffset,
      eocdOffset: eocd,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function mutated(
  mutate: (bytes: Uint8Array, view: DataView, entry: ZipEntryLocation) => void,
): Uint8Array {
  const copy = archive.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  mutate(copy, view, locateEntries(copy)[0]!);
  return copy;
}

function expectInvalid(bytes: Uint8Array): void {
  expect(() => parseSavePackage(bytes)).toThrowError(
    expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }),
  );
}

describe("review-zip-local-header-consistency", () => {
  it("continues to accept an ordinary generated package", () => {
    expect(parseSavePackage(archive).manifest.saveId).toBe("save_zip_headers");
  });

  it.each([
    ["CRC", 14, 4],
    ["compressed size", 18, 4],
    ["uncompressed size", 22, 4],
    ["compression method", 8, 2],
    ["general-purpose flags", 6, 2],
  ] as const)("rejects a local/central %s mismatch", (_label, localField, width) => {
    expectInvalid(
      mutated((_bytes, view, entry) => {
        if (width === 2) {
          view.setUint16(
            entry.localOffset + localField,
            view.getUint16(entry.localOffset + localField, true) ^ 0x0004,
            true,
          );
        } else {
          view.setUint32(
            entry.localOffset + localField,
            (view.getUint32(entry.localOffset + localField, true) + 1) >>> 0,
            true,
          );
        }
      }),
    );
  });

  it("rejects local filename, extra length and entry offset corruption", () => {
    expectInvalid(
      mutated((bytes, view, entry) => {
        bytes[entry.localOffset + 30] ^= 0x01;
      }),
    );
    expectInvalid(
      mutated((_bytes, view, entry) => {
        view.setUint16(entry.localOffset + 28, 0xffff, true);
      }),
    );
    expectInvalid(
      mutated((_bytes, view, entry) => {
        view.setUint32(entry.centralOffset + 42, entry.localOffset + 1, true);
      }),
    );
  });

  it.each([
    ["encryption", 0x0001],
    ["data descriptor", 0x0008],
    ["strong encryption", 0x0040],
    ["reserved", 0x4000],
  ] as const)("rejects unsupported %s flags even when both headers agree", (_label, bit) => {
    expectInvalid(
      mutated((_bytes, view, entry) => {
        const flags = view.getUint16(entry.centralOffset + 8, true) | bit;
        view.setUint16(entry.centralOffset + 8, flags, true);
        view.setUint16(entry.localOffset + 6, flags, true);
      }),
    );
  });

  it.each([
    ["current disk", 4, 1],
    ["central-directory disk", 6, 1],
    ["entries-on-disk mismatch", 8, 0],
  ] as const)("rejects unsupported EOCD %s metadata", (_label, fieldOffset, value) => {
    expectInvalid(
      mutated((_bytes, view, entry) => {
        view.setUint16(entry.eocdOffset + fieldOffset, value, true);
      }),
    );
  });

  it("maps malformed ZIP metadata to 422 and remains healthy for a following valid import", async () => {
    const target = createSaveSystem({
      databasePath: ":memory:",
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    const app = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      saveSystem: target,
      logger: false,
    });
    cleanup.push(() => target.close());
    cleanup.push(() => void app.close());

    const malformed = mutated((_bytes, view, entry) => {
      const flags = view.getUint16(entry.centralOffset + 8, true) | 0x0040;
      view.setUint16(entry.centralOffset + 8, flags, true);
      view.setUint16(entry.localOffset + 6, flags, true);
    });
    const invalidResponse = await app.inject({
      method: "POST",
      url: "/api/saves/import",
      payload: { packageBase64: Buffer.from(malformed).toString("base64") },
    });
    expect(invalidResponse.statusCode).toBe(422);
    expect(invalidResponse.json()).toMatchObject({
      error: { code: "SAVE_PACKAGE_INVALID" },
    });

    const validResponse = await app.inject({
      method: "POST",
      url: "/api/saves/import",
      payload: { packageBase64: Buffer.from(archive).toString("base64") },
    });
    expect(validResponse.statusCode).toBe(200);
    expect(await target.service.loadState("save_zip_headers")).toMatchObject({
      saveId: "save_zip_headers",
    });
  });

  it("rejects an unsupported compression method before unzip", () => {
    expectInvalid(
      mutated((_bytes, view, entry) => {
        view.setUint16(entry.centralOffset + 10, 99, true);
        view.setUint16(entry.localOffset + 8, 99, true);
      }),
    );
  });

  it("rejects entry data that crosses into the central directory", () => {
    expectInvalid(
      mutated((_bytes, view, entry) => {
        const nameLength = view.getUint16(entry.localOffset + 26, true);
        const extraLength = view.getUint16(entry.localOffset + 28, true);
        const dataStart = entry.localOffset + 30 + nameLength + extraLength;
        const crossingSize = entry.centralDirectoryOffset - dataStart + 1;
        view.setUint32(entry.centralOffset + 20, crossingSize, true);
        view.setUint32(entry.localOffset + 18, crossingSize, true);
      }),
    );
  });
});

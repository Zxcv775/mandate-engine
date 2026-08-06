import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import {
  DEFAULT_SAVE_IMPORT_LIMITS,
  createSaveSystem,
  parseSavePackage,
} from "@mandate/save-system";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function rawArchive(extra: Record<string, Uint8Array> = {}, payload = strToU8("SQLite")) {
  return zipSync(
    {
      "manifest.json": strToU8("{}"),
      "payload.sqlite": payload,
      "checksums.json": strToU8("{}"),
      ...extra,
    },
    { level: 9 },
  );
}

describe("REVIEW-006 bounded ZIP import", () => {
  it("accepts a normal small save package after metadata validation", async () => {
    const system = createSaveSystem({
      databasePath: ":memory:",
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    cleanup.push(() => system.close());
    await system.service.createSave({
      saveId: "save_zip_ok",
      scenarioId: "chongzhen-early",
      title: "ZIP",
      seed: "zip",
    });
    const exported = await system.service.exportSave("save_zip_ok", {
      includeSourceMetadata: false,
      safeShareMode: "none",
    });
    expect(parseSavePackage(exported.bytes).manifest.saveId).toBe("save_zip_ok");
  });

  it("rejects archive, entry, total size and compression-ratio limits before unzip", () => {
    const archive = rawArchive();
    expect(() =>
      parseSavePackage(archive, undefined, {
        ...DEFAULT_SAVE_IMPORT_LIMITS,
        maxArchiveBytes: archive.byteLength - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }));
    expect(() =>
      parseSavePackage(archive, undefined, {
        ...DEFAULT_SAVE_IMPORT_LIMITS,
        maxEntryUncompressedBytes: 5,
      }),
    ).toThrowError(expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }));
    expect(() =>
      parseSavePackage(archive, undefined, {
        ...DEFAULT_SAVE_IMPORT_LIMITS,
        maxTotalUncompressedBytes: 5,
      }),
    ).toThrowError(expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }));

    const bomb = rawArchive({}, new Uint8Array(20 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(100 * 1024);
    expect(() => parseSavePackage(bomb)).toThrowError(
      expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }),
    );
  });

  it("rejects traversal, unknown, too many and duplicate entries", () => {
    for (const name of ["../evil.sqlite", "unknown.sqlite"]) {
      expect(() =>
        parseSavePackage(rawArchive({ [name]: strToU8("x") }), undefined, {
          ...DEFAULT_SAVE_IMPORT_LIMITS,
          maxEntryCount: 4,
          maxDirectoryDepth: 2,
        }),
      ).toThrowError(expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }));
    }
    expect(() => parseSavePackage(rawArchive({ "extra.json": strToU8("x") }))).toThrowError(
      expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }),
    );

    const duplicate = rawArchive({ "unknown.sqlite": strToU8("duplicate") });
    const from = Buffer.from("unknown.sqlite");
    const to = Buffer.from("payload.sqlite");
    const buffer = Buffer.from(duplicate);
    let offset = 0;
    while ((offset = buffer.indexOf(from, offset)) >= 0) {
      buffer.set(to, offset);
      offset += to.length;
    }
    expect(() =>
      parseSavePackage(buffer, undefined, {
        ...DEFAULT_SAVE_IMPORT_LIMITS,
        maxEntryCount: 4,
      }),
    ).toThrowError(expect.objectContaining({ code: "SAVE_PACKAGE_INVALID" }));
  });
});

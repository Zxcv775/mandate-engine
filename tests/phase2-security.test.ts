import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import { unzipSync } from "fflate";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T00:00:00.000Z";
const MARKERS = [
  "sk-test-secret-key",
  "Authorization: Bearer test-token",
  "DATABASE_PASSWORD=test-password",
] as const;
const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
});

describe("Phase 2 secret persistence boundary", () => {
  it("redacts credential-like values from SQLite, logs, DTOs and safe-share packages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mandate-security-"));
    cleanup.push(directory);
    const databasePath = join(directory, "security.sqlite");
    const system = createSaveSystem({
      databasePath,
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(NOW),
    });

    const metadata = await system.service.createSave({
      saveId: "save_security",
      scenarioId: "chongzhen-early",
      title: `Security ${MARKERS[2]}`,
      seed: MARKERS[0],
    });
    await system.service.commitCommand({
      commandId: "cmd_security",
      commandType: "country.adjust-resource",
      saveId: "save_security",
      baseRevision: 0,
      actor: { type: "system", id: "security-test" },
      payload: {
        resource: "treasuryTaels",
        delta: -1,
        reason: MARKERS[1],
      },
      createdAt: NOW,
    });
    const changes = await system.service.listChanges("save_security");
    const playerState = await system.service.loadPlayerState("save_security");
    const exported = await system.service.exportSave("save_security", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });

    const dtoText = JSON.stringify({ metadata, changes, playerState, manifest: exported.manifest });
    const packageEntries = unzipSync(exported.bytes);
    const packageText = Object.values(packageEntries)
      .map((entry) => Buffer.from(entry).toString("latin1"))
      .join("\n");
    system.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    system.close();
    const databaseText = (await readFile(databasePath)).toString("latin1");

    for (const marker of MARKERS) {
      expect(dtoText).not.toContain(marker);
      expect(packageText).not.toContain(marker);
      expect(databaseText).not.toContain(marker);
    }
  });
});

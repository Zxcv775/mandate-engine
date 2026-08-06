import {
  ApiErrorResponseSchema,
  MAX_SAVE_IMPORT_BASE64_LENGTH,
  SAVE_IMPORT_HTTP_BODY_LIMIT,
} from "@mandate/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";

const config = parseRuntimeConfig({ NODE_ENV: "test" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 2 save API", () => {
  it("runs create → command → time → checkpoint → rollback → export/import in memory", async () => {
    const app = await buildApp({ config, logger: false });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/saves",
        payload: {
          saveId: "save_api",
          scenarioId: "chongzhen-early",
          title: "API demo",
          seed: "api-seed",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        ok: true,
        data: { saveId: "save_api", headRevision: 0 },
        meta: { requestId: expect.any(String) },
      });

      const listed = await app.inject({ method: "GET", url: "/api/saves" });
      expect(listed.json()).toMatchObject({ ok: true, data: [{ saveId: "save_api" }] });

      const metadata = await app.inject({ method: "GET", url: "/api/saves/save_api" });
      expect(metadata.json()).toMatchObject({ ok: true, data: { snapshotCount: 1 } });

      const initialState = await app.inject({
        method: "GET",
        url: "/api/saves/save_api/state",
      });
      expect(initialState.statusCode).toBe(200);
      expect(initialState.json().data).not.toHaveProperty("hidden");

      const command = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/commands",
        payload: {
          commandId: "cmd_api_adjust",
          commandType: "country.adjust-resource",
          baseRevision: 0,
          payload: { resource: "treasuryTaels", delta: -100, reason: "API test" },
          idempotencyKey: "api-idem",
        },
      });
      expect(command.statusCode).toBe(200);
      expect(command.json()).toMatchObject({ ok: true, data: { revision: 1 } });

      const repeated = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/commands",
        payload: {
          commandId: "cmd_api_adjust_repeat",
          commandType: "country.adjust-resource",
          baseRevision: 0,
          payload: { resource: "treasuryTaels", delta: -100, reason: "API test" },
          idempotencyKey: "api-idem",
        },
      });
      expect(repeated.json().data).toEqual({ ...command.json().data, idempotent: true });

      const advanced = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/time/advance",
        payload: { baseRevision: 1, days: 1, commandId: "cmd_api_time" },
      });
      expect(advanced.json()).toMatchObject({ ok: true, data: { revision: 2 } });

      const checkpoint = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/checkpoints",
        payload: { kind: "manual", label: "API checkpoint" },
      });
      expect(checkpoint.statusCode).toBe(201);
      expect(checkpoint.json()).toMatchObject({
        ok: true,
        data: { revision: 2, kind: "manual" },
      });

      const changes = await app.inject({
        method: "GET",
        url: "/api/saves/save_api/changes?fromRevision=1&aggregateType=country",
      });
      expect(changes.statusCode).toBe(200);
      expect(changes.json().data.length).toBeGreaterThan(0);
      expect(
        changes.json().data.every((item: { visibility: string }) => item.visibility !== "sealed"),
      ).toBe(true);

      const validation = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/validate",
      });
      expect(validation.json()).toMatchObject({ ok: true, data: { valid: true } });

      const repair = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/repair",
        payload: {
          dryRun: true,
          allowHeadRebuild: true,
          allowIndexRebuild: true,
          allowSnapshotRebuild: true,
        },
      });
      expect(repair.json()).toMatchObject({ ok: true, data: { dryRun: true } });

      const rollbackDryRun = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/rollback",
        payload: { targetRevision: 0, mode: "logical", dryRun: true },
      });
      expect(rollbackDryRun.json()).toMatchObject({
        ok: true,
        data: { currentRevision: 2, targetRevision: 0, resultRevision: null },
      });

      const rollback = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/rollback",
        payload: { targetRevision: 0, mode: "logical", dryRun: false },
      });
      expect(rollback.json()).toMatchObject({ ok: true, data: { resultRevision: 3 } });

      const exported = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/export",
        payload: { includeSourceMetadata: false, safeShareMode: "safe_share" },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.json()).toMatchObject({
        ok: true,
        data: {
          manifest: { saveId: "save_api", sourceMetadataMode: "omit_catalog" },
          packageHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          packageBase64: expect.any(String),
        },
      });

      const imported = await app.inject({
        method: "POST",
        url: "/api/saves/import",
        payload: { packageBase64: exported.json().data.packageBase64 },
      });
      expect(imported.json()).toMatchObject({ ok: true, data: { result: "noop" } });

      const migrated = await app.inject({
        method: "POST",
        url: "/api/saves/save_api/migrate",
      });
      expect(migrated.json()).toMatchObject({
        ok: true,
        data: { saveId: "save_api", changed: false, appliedMigrationIds: [] },
      });

      const archived = await app.inject({ method: "DELETE", url: "/api/saves/save_api" });
      expect(archived.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/saves" })).json().data).toEqual([]);
      expect(
        (await app.inject({ method: "GET", url: "/api/saves?includeArchived=true" })).json().data,
      ).toMatchObject([{ saveId: "save_api", status: "archived" }]);
    } finally {
      await app.close();
    }
  });

  it("maps save errors and invalid request bodies to the Phase 1 envelope", async () => {
    const app = await buildApp({ config, logger: false });
    try {
      const missing = await app.inject({ method: "GET", url: "/api/saves/missing/state" });
      expect(missing.statusCode).toBe(404);
      expect(ApiErrorResponseSchema.parse(missing.json())).toMatchObject({
        ok: false,
        error: { code: "SAVE_NOT_FOUND" },
        meta: { requestId: expect.any(String) },
      });

      const invalid = await app.inject({
        method: "POST",
        url: "/api/saves",
        payload: { scenarioId: "", title: "", seed: "" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(ApiErrorResponseSchema.parse(invalid.json())).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", details: expect.any(Array) },
      });

      const missingScenario = await app.inject({
        method: "POST",
        url: "/api/saves",
        payload: {
          saveId: "save_missing_scenario",
          scenarioId: "missing",
          title: "Missing scenario",
          seed: "fixture-seed",
        },
      });
      expect(missingScenario.statusCode).toBe(404);
      expect(missingScenario.json()).toMatchObject({
        ok: false,
        error: { code: "SCENARIO_NOT_FOUND" },
        meta: { requestId: expect.any(String) },
      });
    } finally {
      await app.close();
    }
  });

  it("redacts credential-like save identifiers from error responses", async () => {
    const app = await buildApp({ config, logger: false });
    try {
      const marker = "sk-test-secret-key";
      const response = await app.inject({
        method: "GET",
        url: `/api/saves/${marker}/state`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        ok: false,
        error: { code: "SAVE_NOT_FOUND" },
      });
      expect(response.body).not.toContain(marker);
    } finally {
      await app.close();
    }
  });

  it("aligns DTO and HTTP import limits and maps oversized bodies to 413", async () => {
    const app = await buildApp({ config, logger: false });
    try {
      const dtoOversized = await app.inject({
        method: "POST",
        url: "/api/saves/import",
        payload: { packageBase64: "A".repeat(MAX_SAVE_IMPORT_BASE64_LENGTH + 4) },
      });
      expect(dtoOversized.statusCode).toBe(422);
      expect(dtoOversized.json().error.code).toBe("SAVE_PACKAGE_INVALID");

      const httpOversized = await app.inject({
        method: "POST",
        url: "/api/saves/import",
        payload: { packageBase64: "A".repeat(SAVE_IMPORT_HTTP_BODY_LIMIT) },
      });
      expect(httpOversized.statusCode).toBe(413);
      expect(httpOversized.json()).toMatchObject({
        ok: false,
        error: { code: "REQUEST_BODY_TOO_LARGE" },
      });
    } finally {
      await app.close();
    }
  });
});

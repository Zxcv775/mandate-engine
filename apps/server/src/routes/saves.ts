import {
  AdvanceTimeRequestSchema,
  CreateCheckpointRequestSchema,
  CreateSaveRequestSchema,
  ExportSaveRequestSchema,
  ImportSaveRequestSchema,
  RepairRequestSchema,
  RollbackRequestSchema,
  SaveChangesQuerySchema,
  SaveIdParamsSchema,
  SaveListQuerySchema,
  SubmitCommandRequestSchema,
} from "@mandate/domain";
import type { GameStateService } from "@mandate/save-system";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { successResponse } from "./response";

const StrictEmptyBodySchema = z.object({}).strict();

function parseBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["packageBase64"],
        message: "packageBase64 格式无效",
      },
    ]);
  }
  return Buffer.from(value, "base64");
}

export function registerSaveRoutes(app: FastifyInstance, service: GameStateService): void {
  app.post("/api/saves/import", async (request) => {
    const body = ImportSaveRequestSchema.parse(request.body);
    const data = await service.importSave({
      bytes: parseBase64(body.packageBase64),
      ...(body.password ? { password: body.password } : {}),
      ...(body.clientId ? { clientId: body.clientId } : {}),
    });
    return successResponse(request, data);
  });

  app.post("/api/saves", async (request, reply) => {
    const body = CreateSaveRequestSchema.parse(request.body);
    const data = await service.createSave(body);
    return reply.code(201).send(successResponse(request, data));
  });

  app.get("/api/saves", async (request) => {
    const query = SaveListQuerySchema.parse(request.query);
    return successResponse(
      request,
      await service.listSaves({ includeArchived: query.includeArchived ?? false }),
    );
  });

  app.get("/api/saves/:saveId", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    return successResponse(request, await service.getSave(saveId));
  });

  app.get("/api/saves/:saveId/state", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    return successResponse(request, await service.loadPlayerState(saveId));
  });

  app.get("/api/saves/:saveId/changes", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const query = SaveChangesQuerySchema.parse(request.query);
    return successResponse(request, await service.listChanges(saveId, query));
  });

  app.post("/api/saves/:saveId/checkpoints", async (request, reply) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const body = CreateCheckpointRequestSchema.parse(request.body);
    const data = await service.createCheckpoint(saveId, body);
    return reply.code(201).send(successResponse(request, data));
  });

  app.post("/api/saves/:saveId/commands", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const body = SubmitCommandRequestSchema.parse(request.body);
    return successResponse(request, await service.submitPlayerCommand(saveId, body));
  });

  app.post("/api/saves/:saveId/time/advance", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const body = AdvanceTimeRequestSchema.parse(request.body);
    return successResponse(request, await service.advanceTime(saveId, body));
  });

  app.delete("/api/saves/:saveId", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    await service.archiveSave(saveId);
    return successResponse(request, { saveId, status: "archived" as const });
  });

  app.post("/api/saves/:saveId/validate", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    return successResponse(request, await service.validateSave(saveId));
  });

  app.post("/api/saves/:saveId/repair", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const body = RepairRequestSchema.parse(request.body);
    return successResponse(request, await service.repairSave(saveId, body));
  });

  app.post("/api/saves/:saveId/rollback", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const body = RollbackRequestSchema.parse(request.body);
    return successResponse(
      request,
      await service.rollback(saveId, {
        targetRevision: body.targetRevision,
        dryRun: body.dryRun,
      }),
    );
  });

  app.post("/api/saves/:saveId/export", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const body = ExportSaveRequestSchema.parse(request.body);
    const exported = await service.exportSave(saveId, body);
    return successResponse(request, {
      manifest: exported.manifest,
      packageHash: exported.packageHash,
      packageBase64: Buffer.from(exported.bytes).toString("base64"),
    });
  });

  app.post("/api/saves/:saveId/migrate", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    StrictEmptyBodySchema.parse(request.body ?? {});
    return successResponse(request, await service.migrateSave(saveId));
  });
}

import {
  SaveMetadataResponseSchema,
  type PlayerStateView,
  type SaveMetadata,
  type StateChangeLogEntry,
} from "@mandate/domain";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../apps/web/src/api/client";
import { createSaveStore, type SaveBrowserApi } from "../apps/web/src/store/save-store";

const metadata: SaveMetadata = {
  saveId: "save_demo",
  scenarioId: "chongzhen-early",
  dynastyId: "ming",
  title: "Web demo",
  status: "active",
  headRevision: 1,
  schemaVersion: 1,
  stateVersion: 1,
  lineageId: "lineage_demo",
  parentSaveId: null,
  sourceMetadataMode: "full",
  currentDate: "1627-10-03",
  snapshotCount: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
  lastPlayedAt: "2026-07-26T00:00:00.000Z",
};

const state: PlayerStateView = {
  schemaVersion: 1,
  stateVersion: 1,
  saveId: "save_demo",
  scenarioId: "chongzhen-early",
  dynastyId: "ming",
  revision: 1,
  tick: 1,
  currentDate: "1627-10-03",
  rng: { seed: "seed", cursor: 0 },
  country: {
    treasuryTaels: 3_900_000,
    grainReserveShi: 2_000_000,
    legitimacy: 70,
    stability: 45,
    administrativeCapacity: 55,
    militaryReadiness: 40,
    sourceIds: ["ming-shi"],
  },
  characters: {},
  offices: {},
  policies: {},
  regions: {},
  meetings: {},
  eventQueue: { pendingEventIds: [], processedEventIds: [] },
  flags: {},
  meta: {
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    sourceIds: ["ming-shi"],
    sourceCatalogPresent: true,
  },
};

const change: StateChangeLogEntry = {
  logId: "log_1",
  saveId: "save_demo",
  revision: 1,
  txId: "tx_1",
  sequence: 0,
  timestamp: "2026-07-26T00:00:00.000Z",
  actorType: "player",
  actorId: "player",
  commandType: "country.adjust-resource",
  commandId: "cmd_1",
  aggregateType: "country",
  operation: "decrement",
  path: "/country/treasuryTaels",
  before: 4_200_000,
  after: 3_900_000,
  sourceIds: [],
  tags: ["resource"],
  visibility: "public",
  beforeHash: "a".repeat(64),
  afterHash: "b".repeat(64),
  prevLogHash: null,
  entryHash: "c".repeat(64),
};

describe("web API client write methods", () => {
  it("posts a JSON body and validates the shared response schema", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: "chongzhen-early" }),
      });
      return new Response(
        JSON.stringify({ ok: true, data: metadata, meta: { requestId: "request-1" } }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createApiClient({ fetchImpl });
    const response = await client.post(
      "/api/saves",
      { scenarioId: "chongzhen-early" },
      SaveMetadataResponseSchema,
    );
    expect(response.data.saveId).toBe("save_demo");
  });

  it("sends DELETE through the same timeout/error pipeline", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      return new Response(
        JSON.stringify({ ok: true, data: metadata, meta: { requestId: "request-2" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createApiClient({ fetchImpl });
    expect((await client.delete("/api/saves/save_demo", SaveMetadataResponseSchema)).ok).toBe(
      true,
    );
  });
});

describe("Save Browser store", () => {
  it("loads saves, selects the first save, and keeps state/log panels independent", async () => {
    const api: SaveBrowserApi = {
      listSaves: vi.fn(async () => [metadata]),
      getState: vi.fn(async () => state),
      getChanges: vi.fn(async () => [change]),
    };
    const store = createSaveStore(api);
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({
      saves: { status: "success", data: [metadata] },
      selectedSaveId: "save_demo",
      state: { status: "success", data: state },
      changes: { status: "success", data: [change] },
    });
  });

  it("keeps a log failure local while preserving the loaded save state", async () => {
    const api: SaveBrowserApi = {
      listSaves: vi.fn(async () => [metadata]),
      getState: vi.fn(async () => state),
      getChanges: vi.fn(async () => {
        throw new Error("bad log payload");
      }),
    };
    const store = createSaveStore(api);
    await store.getState().refresh();
    expect(store.getState().state.status).toBe("success");
    expect(store.getState().changes.status).toBe("data_error");
  });

  it("cancels the prior refresh before selecting a different save", async () => {
    const api: SaveBrowserApi = {
      listSaves: vi.fn(async () => [metadata, { ...metadata, saveId: "save_2" }]),
      getState: vi.fn(async (saveId) => ({ ...state, saveId })),
      getChanges: vi.fn(async () => []),
    };
    const store = createSaveStore(api);
    await store.getState().refresh();
    await store.getState().selectSave("save_2");
    expect(store.getState().selectedSaveId).toBe("save_2");
    expect(store.getState().state.data?.saveId).toBe("save_2");
  });
});

import {
  CharacterSchema,
  DynastySchema,
  FactionSchema,
  GameEventSchema,
  HistoricalSourceSchema,
  InstitutionPackSchema,
  RulePackSchema,
  ScenarioSchema,
  WorldbookSchema,
  type TemplateMeta,
} from "@mandate/domain";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z, type ZodType } from "zod";
import { DataValidationError, type DataValidationIssue } from "./errors";
import type { DataCatalog } from "./types";

interface MetaOwner {
  file: string;
  entity: string;
  pathPrefix: string;
  meta: TemplateMeta;
}

interface ValidationState {
  catalog: DataCatalog;
  issues: DataValidationIssue[];
  metaOwners: MetaOwner[];
  files: Map<object, string>;
}

function normalizeRoot(dataRoot: string | URL): string {
  return resolve(dataRoot instanceof URL ? fileURLToPath(dataRoot) : dataRoot);
}

function displayPath(dataRoot: string, file: string): string {
  return `data/${relative(dataRoot, file).split(sep).join("/")}`;
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

function entityId(value: unknown, fallback = "unknown"): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = record.id ?? record.packId;
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return fallback;
}

function addSchemaIssues(
  state: ValidationState,
  file: string,
  raw: unknown,
  issues: readonly z.core.$ZodIssue[],
): void {
  for (const issue of issues) {
    const first = issue.path[0];
    const item = typeof first === "number" && Array.isArray(raw) ? raw[first] : raw;
    state.issues.push({
      type: "data-schema-invalid",
      file,
      entity: entityId(item),
      path: issue.path.map(String).join("."),
      message: issue.message,
    });
  }
}

function parseWithSchema<T>(
  state: ValidationState,
  file: string,
  raw: unknown,
  schema: ZodType<T>,
): T | undefined {
  const result = schema.safeParse(raw);
  if (!result.success) {
    addSchemaIssues(state, file, raw, result.error.issues);
    return undefined;
  }
  return result.data;
}

function registerMeta(
  state: ValidationState,
  file: string,
  entity: string,
  meta: TemplateMeta,
  pathPrefix = "meta",
): void {
  state.metaOwners.push({ file, entity, meta, pathPrefix });
}

function addParsedFile(state: ValidationState, relativePath: string, raw: unknown): void {
  const file = `data/${relativePath}`;
  if (relativePath.startsWith("historical-sources/")) {
    const values = parseWithSchema(state, file, raw, z.array(HistoricalSourceSchema));
    if (values) state.catalog.historicalSources.push(...values);
    return;
  }
  if (relativePath.startsWith("dynasties/")) {
    const value = parseWithSchema(state, file, raw, DynastySchema);
    if (value) {
      state.catalog.dynasties.push(value);
      state.files.set(value, file);
      registerMeta(state, file, value.id, value.meta);
    }
    return;
  }
  if (relativePath.startsWith("scenarios/")) {
    const value = parseWithSchema(state, file, raw, ScenarioSchema);
    if (value) {
      state.catalog.scenarios.push(value);
      state.files.set(value, file);
      registerMeta(state, file, value.id, value.meta);
    }
    return;
  }
  if (relativePath.startsWith("characters/")) {
    const value = parseWithSchema(state, file, raw, CharacterSchema);
    if (value) {
      state.catalog.characters.push(value);
      state.files.set(value, file);
      registerMeta(state, file, value.id, value.meta);
    }
    return;
  }
  if (relativePath.startsWith("factions/")) {
    const values = parseWithSchema(state, file, raw, z.array(FactionSchema));
    if (values) {
      state.catalog.factions.push(...values);
      values.forEach((value) => {
        state.files.set(value, file);
        registerMeta(state, file, value.id, value.meta);
      });
    }
    return;
  }
  if (relativePath.startsWith("institutions/")) {
    const value = parseWithSchema(state, file, raw, InstitutionPackSchema);
    if (value) {
      state.catalog.institutionPacks.push(value);
      state.files.set(value, file);
      registerMeta(state, file, value.id, value.meta);
      value.institutions.forEach((institution, index) => {
        registerMeta(state, file, institution.id, institution.meta, `institutions[${index}].meta`);
      });
      value.offices.forEach((office, index) => {
        registerMeta(state, file, office.id, office.meta, `offices[${index}].meta`);
      });
    }
    return;
  }
  if (relativePath.startsWith("events/")) {
    const value = parseWithSchema(state, file, raw, GameEventSchema);
    if (value) {
      state.catalog.events.push(value);
      registerMeta(state, file, value.id, value.meta);
    }
    return;
  }
  if (relativePath.startsWith("rules/")) {
    const value = parseWithSchema(state, file, raw, RulePackSchema);
    if (value) {
      state.catalog.rulePacks.push(value);
      registerMeta(state, file, value.packId, value.meta);
    }
    return;
  }
  if (relativePath.startsWith("worldbooks/")) {
    const value = parseWithSchema(state, file, raw, WorldbookSchema);
    if (value) {
      state.catalog.worldbooks.push(value);
      registerMeta(state, file, value.id, value.meta);
      value.entries.forEach((entry, index) => {
        registerMeta(
          state,
          file,
          `${value.id}.entries[${index}]`,
          entry.meta,
          `entries[${index}].meta`,
        );
      });
    }
    return;
  }

  state.issues.push({
    type: "data-schema-invalid",
    file,
    path: "$",
    message: "无法根据 data/ 路径识别实体类型",
  });
}

function addReferenceIssue(
  state: ValidationState,
  file: string,
  entity: string,
  path: string,
  message: string,
): void {
  state.issues.push({ type: "data-reference-invalid", file, entity, path, message });
}

function validateUniqueIds<T extends { id: string }>(
  state: ValidationState,
  values: readonly T[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      addReferenceIssue(
        state,
        state.files.get(value) ?? "data/unknown",
        value.id,
        "id",
        `${label} ID "${value.id}" 重复`,
      );
    }
    seen.add(value.id);
  }
}

async function validateReferences(state: ValidationState, dataRoot: string): Promise<void> {
  const sources = new Set(state.catalog.historicalSources.map((value) => value.id));
  const dynasties = new Map(state.catalog.dynasties.map((value) => [value.id, value]));
  const scenarios = state.catalog.scenarios;
  const characters = new Map(state.catalog.characters.map((value) => [value.id, value]));
  const factions = new Map(state.catalog.factions.map((value) => [value.id, value]));
  const packs = new Map(state.catalog.institutionPacks.map((value) => [value.id, value]));

  validateUniqueIds(state, state.catalog.historicalSources, "HistoricalSource");
  validateUniqueIds(state, state.catalog.dynasties, "Dynasty");
  validateUniqueIds(state, state.catalog.scenarios, "Scenario");
  validateUniqueIds(state, state.catalog.characters, "Character");
  validateUniqueIds(state, state.catalog.factions, "Faction");
  validateUniqueIds(state, state.catalog.institutionPacks, "InstitutionPack");

  for (const owner of state.metaOwners) {
    owner.meta.sourceIds.forEach((sourceId, index) => {
      if (!sources.has(sourceId)) {
        addReferenceIssue(
          state,
          owner.file,
          owner.entity,
          `${owner.pathPrefix}.sourceIds[${index}]`,
          `referenced historical source "${sourceId}" does not exist`,
        );
      }
    });
  }

  for (const dynasty of state.catalog.dynasties) {
    if (!packs.has(dynasty.institutionPackId)) {
      addReferenceIssue(
        state,
        state.files.get(dynasty) ?? "data/unknown",
        dynasty.id,
        "institutionPackId",
        `referenced institution pack "${dynasty.institutionPackId}" does not exist`,
      );
    }
  }

  for (const scenario of scenarios) {
    const file = state.files.get(scenario) ?? "data/unknown";
    if (!dynasties.has(scenario.dynastyId)) {
      addReferenceIssue(
        state,
        file,
        scenario.id,
        "dynastyId",
        `referenced dynasty "${scenario.dynastyId}" does not exist`,
      );
    }
    scenario.coreCharacterIds.forEach((characterId, index) => {
      if (!characters.has(characterId)) {
        addReferenceIssue(
          state,
          file,
          scenario.id,
          `coreCharacterIds[${index}]`,
          `referenced character "${characterId}" does not exist`,
        );
      }
    });

    const normalizedRef = scenario.initialDataRef.replace(/\\/g, "/").replace(/^data\//, "");
    const target = resolve(dataRoot, ...normalizedRef.split("/").filter(Boolean));
    const relativeTarget = relative(dataRoot, target);
    if (relativeTarget.startsWith("..") || relativeTarget.includes(`${sep}..${sep}`)) {
      addReferenceIssue(
        state,
        file,
        scenario.id,
        "initialDataRef",
        "initialDataRef 超出 data 根目录",
      );
    } else {
      try {
        await stat(target);
      } catch {
        state.issues.push({
          type: "data-file-not-found",
          file,
          entity: scenario.id,
          path: "initialDataRef",
          message: `referenced data path "${scenario.initialDataRef}" does not exist`,
        });
      }
    }
  }

  const offices = new Set(
    state.catalog.institutionPacks.flatMap((pack) => pack.offices.map((office) => office.id)),
  );
  for (const character of state.catalog.characters) {
    const file = state.files.get(character) ?? "data/unknown";
    if (!dynasties.has(character.identity.dynastyId)) {
      addReferenceIssue(
        state,
        file,
        character.id,
        "identity.dynastyId",
        `referenced dynasty "${character.identity.dynastyId}" does not exist`,
      );
    }
    character.politicalProfile.factionIds.forEach((factionId, index) => {
      if (!factions.has(factionId)) {
        addReferenceIssue(
          state,
          file,
          character.id,
          `politicalProfile.factionIds[${index}]`,
          `referenced faction "${factionId}" does not exist`,
        );
      }
    });
    const officeReferences: readonly (readonly [string, string | null | undefined])[] = [
      ["identity.initialOfficeId", character.identity.initialOfficeId],
      ...character.identity.historicalOfficeIds.map(
        (officeId, index) => [`identity.historicalOfficeIds[${index}]`, officeId] as const,
      ),
    ];
    for (const [path, officeId] of officeReferences) {
      if (officeId && !offices.has(officeId)) {
        addReferenceIssue(
          state,
          file,
          character.id,
          path,
          `referenced office "${officeId}" does not exist`,
        );
      }
    }
    character.initialRelations.forEach((relation, index) => {
      if (!characters.has(relation.targetCharacterId)) {
        addReferenceIssue(
          state,
          file,
          character.id,
          `initialRelations[${index}].targetCharacterId`,
          `referenced character "${relation.targetCharacterId}" does not exist`,
        );
      }
    });
    character.historicalProfile.majorExperiences.forEach((experience, experienceIndex) => {
      experience.sourceIds.forEach((sourceId, sourceIndex) => {
        if (!sources.has(sourceId)) {
          addReferenceIssue(
            state,
            file,
            character.id,
            `historicalProfile.majorExperiences[${experienceIndex}].sourceIds[${sourceIndex}]`,
            `referenced historical source "${sourceId}" does not exist`,
          );
        }
      });
    });
    // 人物卡包含大量 0-100 游戏建模数值，不是史料记载的心理测量；
    // 数据策略要求整卡 confirmation 必须显式标注 gameplay-adjusted（ADR-010）。
    if (character.meta.confirmation !== "gameplay-adjusted") {
      addReferenceIssue(
        state,
        file,
        character.id,
        "meta.confirmation",
        "人物卡含游戏建模数值，meta.confirmation 必须为 gameplay-adjusted",
      );
    }
  }

  for (const pack of state.catalog.institutionPacks) {
    const file = state.files.get(pack) ?? "data/unknown";
    if (!dynasties.has(pack.dynastyId)) {
      addReferenceIssue(
        state,
        file,
        pack.id,
        "dynastyId",
        `referenced dynasty "${pack.dynastyId}" does not exist`,
      );
    }
    const institutions = new Set(pack.institutions.map((value) => value.id));
    pack.institutions.forEach((institution, index) => {
      if (institution.parentId && !institutions.has(institution.parentId)) {
        addReferenceIssue(
          state,
          file,
          institution.id,
          `institutions[${index}].parentId`,
          `referenced parent institution "${institution.parentId}" does not exist`,
        );
      }
    });
    pack.offices.forEach((office, index) => {
      if (!institutions.has(office.institutionId)) {
        addReferenceIssue(
          state,
          file,
          office.id,
          `offices[${index}].institutionId`,
          `referenced institution "${office.institutionId}" does not exist`,
        );
      }
    });
  }
}

export async function validateDataDirectory(dataRootInput: string | URL): Promise<DataCatalog> {
  const dataRoot = normalizeRoot(dataRootInput);
  const state: ValidationState = {
    catalog: {
      historicalSources: [],
      dynasties: [],
      scenarios: [],
      characters: [],
      factions: [],
      institutionPacks: [],
      events: [],
      rulePacks: [],
      worldbooks: [],
    },
    issues: [],
    metaOwners: [],
    files: new Map(),
  };

  let files: string[];
  try {
    files = await collectJsonFiles(dataRoot);
  } catch (error) {
    throw new DataValidationError([
      {
        type: "data-file-not-found",
        file: displayPath(dataRoot, dataRoot),
        path: "$",
        message: error instanceof Error ? error.message : "data 目录不可读",
      },
    ]);
  }

  for (const fullPath of files) {
    const relativePath = relative(dataRoot, fullPath).split(sep).join("/");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(fullPath, "utf8"));
    } catch (error) {
      state.issues.push({
        type: "data-json-invalid",
        file: `data/${relativePath}`,
        entity: fullPath
          .split(sep)
          .at(-1)
          ?.replace(/\.json$/, ""),
        path: "$",
        message: error instanceof Error ? error.message : "JSON 解析失败",
      });
      continue;
    }
    addParsedFile(state, relativePath, raw);
  }

  await validateReferences(state, dataRoot);
  if (state.issues.length > 0) throw new DataValidationError(state.issues);
  return state.catalog;
}

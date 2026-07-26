import { createSaveSystem, SaveSystemError, type SaveSystem } from "@mandate/save-system";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CliCommand = "check" | "repair" | "rollback" | "export" | "import" | "migrate";

export interface SaveCliIo {
  writeOut(value: string): void;
  writeErr(value: string): void;
}

interface ParsedArguments {
  command: CliCommand;
  values: Map<string, string | true>;
}

class CliArgumentError extends Error {
  readonly code = "CLI_ARGUMENT_INVALID";
}

const DEFAULT_IO: SaveCliIo = {
  writeOut: (value) => process.stdout.write(value),
  writeErr: (value) => process.stderr.write(value),
};

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  if (!command || !["check", "repair", "rollback", "export", "import", "migrate"].includes(command)) {
    throw new CliArgumentError("命令必须是 check、repair、rollback、export、import 或 migrate");
  }
  const values = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new CliArgumentError("参数必须使用 --name 形式");
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }
  return { command: command as CliCommand, values };
}

function stringValue(args: ParsedArguments, name: string, required = false): string | undefined {
  const value = args.values.get(name);
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new CliArgumentError(`缺少 --${name}`);
  return undefined;
}

function integerValue(args: ParsedArguments, name: string): number {
  const raw = stringValue(args, name, true)!;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliArgumentError(`--${name} 必须是非负整数`);
  }
  return value;
}

function flag(args: ParsedArguments, name: string): boolean {
  return args.values.get(name) === true;
}

function databasePath(args: ParsedArguments): { path: string; savePathMode: boolean } {
  const explicit = stringValue(args, "database");
  if (explicit) return { path: resolve(explicit), savePathMode: false };
  const save = stringValue(args, "save");
  if (save && existsSync(save)) return { path: resolve(save), savePathMode: true };
  return { path: resolve("saves/mandate-engine.sqlite"), savePathMode: false };
}

async function resolveSaveId(
  system: SaveSystem,
  args: ParsedArguments,
  savePathMode: boolean,
): Promise<string> {
  const requested = stringValue(args, "save", true)!;
  if (!savePathMode) return requested;
  const saves = await system.service.listSaves({ includeArchived: true });
  if (saves.length !== 1) {
    throw new CliArgumentError("数据库路径模式要求数据库中恰好存在一个存档");
  }
  return saves[0]!.saveId;
}

async function execute(args: ParsedArguments): Promise<{ data: unknown; exitCode?: number }> {
  const location = databasePath(args);
  const system = createSaveSystem({ databasePath: location.path });
  try {
    if (args.command === "import") {
      const file = stringValue(args, "file", true)!;
      const bytes = await readFile(resolve(file));
      return {
        data: await system.service.importSave({
          bytes,
          ...(stringValue(args, "password") ? { password: stringValue(args, "password") } : {}),
          ...(stringValue(args, "client-id") ? { clientId: stringValue(args, "client-id") } : {}),
        }),
      };
    }

    const saveId = await resolveSaveId(system, args, location.savePathMode);
    switch (args.command) {
      case "check": {
        const report = await system.service.validateSave(saveId);
        return { data: report, exitCode: report.valid ? 0 : 1 };
      }
      case "repair":
        return {
          data: await system.service.repairSave(saveId, {
            dryRun: flag(args, "dry-run"),
            allowHeadRebuild: true,
            allowIndexRebuild: true,
            allowSnapshotRebuild: true,
          }),
        };
      case "rollback":
        return {
          data: await system.service.rollback(saveId, {
            targetRevision: integerValue(args, "target-revision"),
            dryRun: flag(args, "dry-run"),
          }),
        };
      case "export": {
        const out = stringValue(args, "out", true)!;
        const result = await system.service.exportSave(saveId, {
          includeSourceMetadata: !flag(args, "omit-source-metadata"),
          safeShareMode: flag(args, "safe-share") ? "safe_share" : "none",
          ...(stringValue(args, "password") ? { password: stringValue(args, "password") } : {}),
          outputPath: resolve(out),
        });
        return {
          data: {
            manifest: result.manifest,
            packageHash: result.packageHash,
            outputPath: result.outputPath,
          },
        };
      }
      case "migrate":
        return { data: await system.service.migrateSave(saveId) };
      case "import":
        throw new CliArgumentError("import 分派错误");
    }
  } finally {
    system.close();
  }
}

function emit(io: SaveCliIo, channel: "out" | "err", value: unknown, json: boolean): void {
  const serialized = json
    ? `${JSON.stringify(value)}\n`
    : `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`;
  if (channel === "out") io.writeOut(serialized);
  else io.writeErr(serialized);
}

export async function runSaveCli(
  argv: readonly string[],
  io: SaveCliIo = DEFAULT_IO,
): Promise<number> {
  let command = argv[0] ?? "unknown";
  const json = argv.includes("--json");
  try {
    const args = parseArguments(argv);
    command = args.command;
    const result = await execute(args);
    const exitCode = result.exitCode ?? 0;
    emit(io, "out", { ok: exitCode === 0, command, data: result.data }, json);
    return exitCode;
  } catch (error) {
    const code =
      error instanceof CliArgumentError
        ? error.code
        : error instanceof SaveSystemError
          ? error.code
          : "CLI_OPERATION_FAILED";
    const message =
      error instanceof CliArgumentError || error instanceof SaveSystemError
        ? error.message
        : "存档命令执行失败";
    emit(io, "err", { ok: false, command, error: { code, message } }, json);
    return error instanceof CliArgumentError ? 2 : 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runSaveCli(process.argv.slice(2));
}

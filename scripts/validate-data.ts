import {
  DataValidationError,
  validateDataDirectory,
  type DataValidationIssue,
} from "@mandate/data-loader";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dataRoot = fileURLToPath(new URL("../data/", import.meta.url));

export function formatValidationIssue(issue: DataValidationIssue): string {
  return [
    `[${issue.type}]`,
    `file: ${issue.file}`,
    ...(issue.entity ? [`entity: ${issue.entity}`] : []),
    `path: ${issue.path}`,
    `message: ${issue.message}`,
  ].join("\n");
}

async function countJsonFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

export async function runDataValidation(): Promise<void> {
  try {
    await validateDataDirectory(dataRoot);
    console.log(`数据深度校验通过：${await countJsonFiles(dataRoot)} 个 JSON 文件`);
  } catch (error) {
    if (error instanceof DataValidationError) {
      error.issues.forEach((issue) => console.error(formatValidationIssue(issue)));
      console.error(`数据深度校验失败：${error.issues.length} 个问题`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await runDataValidation();
}

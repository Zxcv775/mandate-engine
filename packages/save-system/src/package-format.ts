import {
  MAX_SAVE_ARCHIVE_BYTES,
  SaveExportManifestSchema,
  type SaveExportManifest,
} from "@mandate/domain";
import { sha256Hex, stableStringify } from "@mandate/game-engine";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { SaveSystemError } from "./errors";

const REQUIRED_ENTRIES = ["manifest.json", "payload.sqlite", "checksums.json"] as const;
const ENCRYPTED_FORMAT = "mandate-encrypted-save";
const SCRYPT_COST = 16_384;
const SUPPORTED_ZIP_GENERAL_PURPOSE_FLAGS = 0;

export interface SaveImportLimits {
  maxArchiveBytes: number;
  maxEntryCount: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
  maxFileNameLength: number;
  maxDirectoryDepth: number;
}

export const DEFAULT_SAVE_IMPORT_LIMITS: Readonly<SaveImportLimits> = {
  maxArchiveBytes: MAX_SAVE_ARCHIVE_BYTES,
  maxEntryCount: REQUIRED_ENTRIES.length,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024 + 128 * 1024,
  maxCompressionRatio: 200,
  maxFileNameLength: 64,
  maxDirectoryDepth: 0,
};

interface ZipEntryMetadata {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

function invalidArchive(reason: string): never {
  throw new SaveSystemError("SAVE_PACKAGE_INVALID", `存档 ZIP 元数据无效：${reason}`);
}

function readZipMetadata(bytes: Uint8Array, limits: SaveImportLimits): ZipEntryMetadata[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) invalidArchive("缺少中央目录");
  const currentDisk = view.getUint16(eocd + 4, true);
  const centralDirectoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    invalidArchive("不支持 ZIP64");
  }
  if (currentDisk !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    invalidArchive("只支持单磁盘且中央目录计数必须一致");
  }
  if (entryCount > limits.maxEntryCount || centralOffset + centralSize > eocd) {
    invalidArchive("entry 数量或目录边界超限");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seen = new Set<string>();
  const entries: ZipEntryMetadata[] = [];
  const localRanges: Array<{ start: number; end: number }> = [];
  let total = 0;
  let offset = centralOffset;
  try {
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) {
        invalidArchive("中央目录项损坏");
      }
      const flags = view.getUint16(offset + 8, true);
      const compressionMethod = view.getUint16(offset + 10, true);
      const crc32 = view.getUint32(offset + 16, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (
        flags !== SUPPORTED_ZIP_GENERAL_PURPOSE_FLAGS ||
        ![0, 8].includes(compressionMethod) ||
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff ||
        end > eocd ||
        localOffset + 30 > centralOffset
      ) {
        invalidArchive("加密项或目录边界无效");
      }
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (
        name.length === 0 ||
        name.length > limits.maxFileNameLength ||
        name.includes("\0") ||
        name.startsWith("/") ||
        name.startsWith("\\") ||
        /^[A-Za-z]:/.test(name) ||
        name.split(/[\\/]/).includes("..") ||
        name.split(/[\\/]/).length - 1 > limits.maxDirectoryDepth
      ) {
        invalidArchive("entry 路径非法");
      }
      if (seen.has(name)) invalidArchive("entry 重复");
      seen.add(name);
      if (!REQUIRED_ENTRIES.includes(name as (typeof REQUIRED_ENTRIES)[number])) {
        invalidArchive("包含未知 entry");
      }
      if (
        uncompressedSize > limits.maxEntryUncompressedBytes ||
        uncompressedSize / Math.max(compressedSize, 1) > limits.maxCompressionRatio
      ) {
        invalidArchive("entry 展开大小或压缩率超限");
      }
      total += uncompressedSize;
      if (total > limits.maxTotalUncompressedBytes) invalidArchive("总展开大小超限");
      if (view.getUint32(localOffset, true) !== 0x04034b50) invalidArchive("本地文件头损坏");
      const localFlags = view.getUint16(localOffset + 6, true);
      const localCompressionMethod = view.getUint16(localOffset + 8, true);
      const localCrc32 = view.getUint32(localOffset + 14, true);
      const localCompressedSize = view.getUint32(localOffset + 18, true);
      const localUncompressedSize = view.getUint32(localOffset + 22, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const localNameStart = localOffset + 30;
      const localNameEnd = localNameStart + localNameLength;
      const dataStart = localNameEnd + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (
        localFlags !== flags ||
        localCompressionMethod !== compressionMethod ||
        localCrc32 !== crc32 ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize ||
        localNameLength !== nameLength ||
        localNameEnd > centralOffset ||
        dataStart > centralOffset ||
        dataEnd > centralOffset
      ) {
        invalidArchive("本地文件头与中央目录不一致或数据边界无效");
      }
      const localName = decoder.decode(bytes.subarray(localNameStart, localNameEnd));
      if (localName !== name) invalidArchive("本地文件名与中央目录不一致");
      localRanges.push({ start: localOffset, end: dataEnd });
      entries.push({ name, compressedSize, uncompressedSize });
      offset = end;
    }
  } catch (error) {
    if (error instanceof SaveSystemError) throw error;
    invalidArchive("目录编码或边界无效");
  }
  if (offset !== centralOffset + centralSize) invalidArchive("中央目录长度不一致");
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index]!.start < localRanges[index - 1]!.end) {
      invalidArchive("本地 entry 数据区域重叠");
    }
  }
  return entries;
}

interface PackageChecksums {
  algorithm: "sha256";
  files: Record<(typeof REQUIRED_ENTRIES)[0 | 1], string>;
}

interface EncryptedEnvelope {
  format: typeof ENCRYPTED_FORMAT;
  version: 1;
  kdf: {
    name: "scrypt";
    cost: number;
    blockSize: number;
    parallelization: number;
    salt: string;
  };
  cipher: {
    name: "aes-256-gcm";
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

export interface ParsedSavePackage {
  manifest: SaveExportManifest;
  payload: Uint8Array;
  packageHash: string;
  entryNames: string[];
}

export interface InspectedSavePackage extends ParsedSavePackage {
  integrity: string;
}

function encryptPackage(plain: Uint8Array, password: string): Uint8Array {
  if (!password) throw new SaveSystemError("SAVE_EXPORT_FAILED", "加密口令不能为空");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, {
    N: SCRYPT_COST,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    format: ENCRYPTED_FORMAT,
    version: 1,
    kdf: {
      name: "scrypt",
      cost: SCRYPT_COST,
      blockSize: 8,
      parallelization: 1,
      salt: salt.toString("base64"),
    },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
  key.fill(0);
  return strToU8(stableStringify(envelope));
}

function decryptPackage(bytes: Uint8Array, password?: string): Uint8Array {
  if (bytes[0] !== 0x7b) return bytes;
  try {
    const envelope = JSON.parse(strFromU8(bytes)) as Partial<EncryptedEnvelope>;
    if (envelope.format !== ENCRYPTED_FORMAT) return bytes;
    if (!password || !envelope.kdf || !envelope.cipher || !envelope.ciphertext) {
      throw new Error("missing encryption input");
    }
    if (
      envelope.version !== 1 ||
      envelope.kdf.name !== "scrypt" ||
      envelope.cipher.name !== "aes-256-gcm" ||
      envelope.kdf.cost !== SCRYPT_COST ||
      envelope.kdf.blockSize !== 8 ||
      envelope.kdf.parallelization !== 1
    ) {
      throw new Error("unsupported encryption envelope");
    }
    const salt = Buffer.from(envelope.kdf.salt, "base64");
    const iv = Buffer.from(envelope.cipher.iv, "base64");
    const key = scryptSync(password, salt, 32, {
      N: envelope.kdf.cost,
      r: envelope.kdf.blockSize,
      p: envelope.kdf.parallelization,
      maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(envelope.cipher.authTag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    key.fill(0);
    return plain;
  } catch {
    throw new SaveSystemError("SAVE_DECRYPTION_FAILED", "存档解密失败");
  }
}

export function buildSavePackage(
  manifestInput: SaveExportManifest,
  payload: Uint8Array,
  password?: string,
): Uint8Array {
  const manifest = SaveExportManifestSchema.parse(manifestInput);
  const manifestBytes = strToU8(stableStringify(manifest));
  const checksums: PackageChecksums = {
    algorithm: "sha256",
    files: {
      "manifest.json": sha256Hex(manifestBytes),
      "payload.sqlite": sha256Hex(payload),
    },
  };
  const archive = zipSync(
    {
      "manifest.json": manifestBytes,
      "payload.sqlite": payload,
      "checksums.json": strToU8(stableStringify(checksums)),
    },
    { level: 6 },
  );
  return password ? encryptPackage(archive, password) : archive;
}

export function parseSavePackage(
  bytes: Uint8Array,
  password?: string,
  limits: SaveImportLimits = DEFAULT_SAVE_IMPORT_LIMITS,
): ParsedSavePackage {
  const packageHash = sha256Hex(bytes);
  try {
    if (bytes.byteLength > limits.maxArchiveBytes) invalidArchive("archive 大小超限");
    const plain = decryptPackage(bytes, password);
    if (plain.byteLength > limits.maxArchiveBytes) invalidArchive("解密后 archive 大小超限");
    const metadata = readZipMetadata(plain, limits);
    const entries = unzipSync(plain);
    const entryNames = Object.keys(entries);
    if (
      entryNames.length !== REQUIRED_ENTRIES.length ||
      entryNames.some(
        (name) => !REQUIRED_ENTRIES.includes(name as (typeof REQUIRED_ENTRIES)[number]),
      )
    ) {
      throw new Error("unexpected archive entry");
    }
    for (const name of REQUIRED_ENTRIES) {
      if (!entries[name]) throw new Error(`missing ${name}`);
    }
    for (const item of metadata) {
      if (entries[item.name]?.byteLength !== item.uncompressedSize) {
        throw new Error("entry size mismatch");
      }
    }
    const manifestBytes = entries["manifest.json"] as Uint8Array;
    const payload = entries["payload.sqlite"] as Uint8Array;
    const checksums = JSON.parse(
      strFromU8(entries["checksums.json"] as Uint8Array),
    ) as Partial<PackageChecksums>;
    if (
      checksums.algorithm !== "sha256" ||
      checksums.files?.["manifest.json"] !== sha256Hex(manifestBytes) ||
      checksums.files?.["payload.sqlite"] !== sha256Hex(payload)
    ) {
      throw new Error("checksum mismatch");
    }
    const manifest = SaveExportManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
    return { manifest, payload, packageHash, entryNames };
  } catch (error) {
    if (error instanceof SaveSystemError) throw error;
    throw new SaveSystemError("SAVE_PACKAGE_INVALID", "存档包格式或校验和无效");
  }
}

export async function inspectSavePackage(
  bytes: Uint8Array,
  password?: string,
): Promise<InspectedSavePackage> {
  const parsed = parseSavePackage(bytes, password);
  const directory = await mkdtemp(join(tmpdir(), "mandate-inspect-"));
  const path = join(directory, "payload.sqlite");
  let database: DatabaseSync | undefined;
  try {
    await writeFile(path, parsed.payload);
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const rows = database.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    const integrity = rows.every((row) => row.integrity_check === "ok") ? "ok" : "failed";
    return { ...parsed, integrity };
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

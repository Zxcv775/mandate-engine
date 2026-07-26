import {
  SaveExportManifestSchema,
  type SaveExportManifest,
} from "@mandate/domain";
import { sha256Hex, stableStringify } from "@mandate/game-engine";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { SaveSystemError } from "./errors";

const REQUIRED_ENTRIES = ["manifest.json", "payload.sqlite", "checksums.json"] as const;
const ENCRYPTED_FORMAT = "mandate-encrypted-save";
const SCRYPT_COST = 16_384;

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

export function parseSavePackage(bytes: Uint8Array, password?: string): ParsedSavePackage {
  const packageHash = sha256Hex(bytes);
  try {
    const plain = decryptPackage(bytes, password);
    const entries = unzipSync(plain);
    const entryNames = Object.keys(entries);
    if (
      entryNames.length !== REQUIRED_ENTRIES.length ||
      entryNames.some((name) => !REQUIRED_ENTRIES.includes(name as (typeof REQUIRED_ENTRIES)[number]))
    ) {
      throw new Error("unexpected archive entry");
    }
    for (const name of REQUIRED_ENTRIES) {
      if (!entries[name]) throw new Error(`missing ${name}`);
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

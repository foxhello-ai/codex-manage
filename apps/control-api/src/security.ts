import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

type PasswordRecord = {
  algorithm: "scrypt";
  salt: string;
  key: string;
  cost: number;
  blockSize: number;
  parallelization: number;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const record: PasswordRecord = {
    algorithm: "scrypt",
    salt: salt.toString("base64url"),
    key: derive(password, salt, 16_384, 8, 1).toString("base64url"),
    cost: 16_384,
    blockSize: 8,
    parallelization: 1
  };
  return JSON.stringify(record);
}

export function verifyPassword(password: string, serialized: string): boolean {
  try {
    const record = JSON.parse(serialized) as PasswordRecord;
    if (record.algorithm !== "scrypt") return false;
    const expected = Buffer.from(record.key, "base64url");
    const actual = derive(
      password,
      Buffer.from(record.salt, "base64url"),
      record.cost,
      record.blockSize,
      record.parallelization
    );
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function randomVerificationCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, "0");
}

export function hashVerificationCode(identifier: string, purpose: string, code: string): string {
  return createHash("sha256").update(`${identifier}\u0000${purpose}\u0000${code}`).digest("base64url");
}

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number): Buffer {
  return scryptSync(password, salt, 64, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024
  });
}

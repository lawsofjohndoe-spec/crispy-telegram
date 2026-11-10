import { createHash, randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createWhisperToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashWhisperToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isValidWhisperToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function sanitizeDisplayName(name: string, maxLength = 100): string {
  return [...name.replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, maxLength).join("");
}

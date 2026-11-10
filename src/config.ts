export type AdminCopyFailurePolicy = "rollback" | "continue";

export interface Config {
  botToken: string;
  adminBotToken: string | null;
  databaseUrl: string;
  adminChatId: string;
  adminUserIds: Set<string>;
  adminCopyFailurePolicy: AdminCopyFailurePolicy;
  whisperMaxLength: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const adminChatId = required("ADMIN_CHAT_ID");
  if (!/^[1-9]\d*$/.test(adminChatId)) {
    throw new Error("ADMIN_CHAT_ID must be a positive private-chat ID");
  }

  const adminUserIds = new Set(
    required("ADMIN_USER_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (adminUserIds.size === 0 || [...adminUserIds].some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error("ADMIN_USER_IDS must contain comma-separated positive Telegram user IDs");
  }
  if (!adminUserIds.has(adminChatId)) {
    throw new Error("ADMIN_CHAT_ID must also be listed in ADMIN_USER_IDS");
  }

  const policy = process.env.ADMIN_COPY_FAILURE_POLICY?.trim() || "rollback";
  if (policy !== "rollback" && policy !== "continue") {
    throw new Error("ADMIN_COPY_FAILURE_POLICY must be rollback or continue");
  }

  return {
    botToken: required("BOT_TOKEN"),
    adminBotToken: process.env.ADMIN_BOT_TOKEN?.trim() || null,
    databaseUrl: required("DATABASE_URL"),
    adminChatId,
    adminUserIds,
    adminCopyFailurePolicy: policy,
    whisperMaxLength: boundedPositiveInteger(
      "WHISPER_MAX_LENGTH",
      process.env.WHISPER_MAX_LENGTH?.trim() || "3500",
      3500,
    ),
  };
}

function boundedPositiveInteger(name: string, value: string, max: number): number {
  const parsed = positiveInteger(name, value);
  if (parsed > max) {
    throw new Error(`${name} must not exceed ${max}`);
  }
  return parsed;
}

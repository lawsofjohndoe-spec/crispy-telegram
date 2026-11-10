import "dotenv/config";
import { Bot } from "grammy";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db.js";
import { createBot, startCleanupWorker } from "./bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await runMigrations(pool);
    const identity = await new Bot(config.botToken).api.getMe();
    if (!identity.username) {
      throw new Error("The bot account must have a username to create deep links");
    }
    const adminBot = new Bot(config.adminBotToken ?? config.botToken);
    const adminIdentity = await adminBot.api.getMe();
    const bot = createBot(pool, config, identity.username, adminBot);
    await bot.api.setMyCommands([
      { command: "start", description: "Welcome to iPsstRobot" },
      { command: "help", description: "How to use iPsstRobot" },
      { command: "register", description: "Register your Telegram account" },
      { command: "earn", description: "See how stars work" },
      { command: "privacy", description: "Read about your privacy" },
    ]);
    const cleanupTimer = startCleanupWorker(pool, bot, adminBot);
    const stop = (): void => {
      clearInterval(cleanupTimer);
      void bot.stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.info("Whisper bot started", {
      botUsername: identity.username,
      adminBotUsername: adminIdentity.username,
    });
    await bot.start({
      allowed_updates: ["message", "inline_query", "chosen_inline_result", "callback_query"],
    });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const details: Record<string, string> = {
    error: error instanceof Error ? error.name : "UnknownError",
  };
  if (error instanceof Error) {
    details.message = error.message;
    if ("code" in error && typeof error.code === "string") {
      details.code = error.code;
    }
  }
  console.error("Bot startup failed", details);
  process.exitCode = 1;
});

import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import {
  allowRateLimitedAction,
  activateWhisper,
  activateWhisperByToken,
  claimBotStartNotification,
  claimAdminCopy,
  claimAdminCopyByToken,
  cleanupExpired,
  creditEligibleStars,
  consumeWhisper,
  createWhisper,
  forgetUser,
  getEarnStatus,
  getAdminStatus,
  getWhisperRevealFailure,
  getWhisperDraft,
  initializeUserOnStart,
  recordAdminCopy,
  releaseAdminCopyClaim,
  registerUser,
  markBotStartNotificationSent,
  releaseBotStartNotification,
  removeWhisper,
  saveInlineMessageIdByToken,
  type SelectedWhisper,
} from "./whispers.js";
import { createWhisperToken, isValidWhisperToken, sanitizeDisplayName } from "./security.js";

const PRIVATE_START_TEXT = [
  "🤫 <b>Welcome to iPsstRobot!</b>",
  "",
  "Send a private whisper in any Telegram chat by typing:",
  "",
  "<code>@iPsstRobot @username your secret message</code>",
  "",
  "Choose the result from the bot to post a whisper card. Only the intended recipient can read the message in a private chat. <b>The whisper disappears after it’s read.</b>",
  "No one else can see what you whisper except the intented person.",
  "Your secret is safe. ",
  "",
  "Use /help to learn more, /earn to learn how to earn stars, or /balance to check your balance.",
].join("\n");

const HELP_TEXT = [
  "📖 <b>How to use iPsstRobot</b>",
  "",
  "1. Start this bot to receive your welcome star and enroll for earnings.",
  "2. In a Telegram chat, type:",
  "<code>@iPsstRobot @username your secret message</code>",
  "3. Select the whisper result to post the card.",
  "4. The recipient taps the card and opens the bot to read the whisper privately.",
  "🔒 Only the intended recipient can read the whisper. It disappears after being read.",
  "You earn 1 star for every 10 whispers you post after one week.",
  "Use /earn for earning details, /balance to check your stars, or /privacy to learn how whisper data is handled.",
].join("\n");

const REGISTER_TEXT = [
  "📝 <b>Registration</b>",
  "",
  "Tap the button below to register your Telegram account with iPsstRobot. This helps the bot identify you as a whisper recipient.",
  "",
  "<b>Registering doesn’t make your messages public.</b> Your whispers are shown only to their intended recipient.",
  "The intended person can only see it.",
].join("\n");

const EARN_TEXT = [
    "⭐ Earn stars with iPsstRobot",
    "",
    "You receive 1 star the first time you start the bot.",
    "",
    "After you start, post whispers with iPsstRobot. Once you’ve been enrolled for one week, you’ll automatically earn 1 star for every 10 whispers you post.",
    "",
    "Use /balance to check your stars. Use /withdraw <amount> to check withdrawal requirements (minimum 50 stars).",
  ].join("\n");

const PRIVACY_TEXT = [
  "🔒 <b>Your privacy</b>",
  "",
  "Whisper messages are intended for the selected recipient. The recipient can read a whisper privately through the bot. Once read, it is deleted from the bot’s active whisper storage.",
  "",
  "Your Telegram username and account ID may be used to route whispers and prevent other users from reading them. Never use the bot to send passwords or other highly sensitive information.",
  "",
  "Whisper copies remain in the BOT until Telegram deletion is attempted after 24 hours; deletion is best-effort.",
  "",
].join("\n");

function genericResult(
  title: string,
  description: string,
  message: string,
): {
  type: "article";
  id: string;
  title: string;
  description: string;
  input_message_content: { message_text: string };
} {
  return {
    type: "article",
    id: "info",
    title,
    description,
    input_message_content: { message_text: message },
  };
}

function whisperCardResult(
  id: string,
  recipientUsername: string,
  token: string,
  botUsername: string,
) {
  return {
    type: "article" as const,
    id,
    title: `🔐 Private whisper for @${recipientUsername}`,
    description: "Private read. No one can know your secret whispers.",
    input_message_content: {
      message_text: [
        "🔐 A private whisper is waiting.",
        "",
        `Only the Telegram account with the username @${recipientUsername} can open it.`,
        "The secret disappears after it is read.",
        "",
        `✨ Earn with us: @${botUsername}`,
      ].join("\n"),
    },
    reply_markup: new InlineKeyboard().text("🔐 Read whisper privately", `read_${token}`),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  for (const key of ["error_code", "code"]) {
    if (!(key in error)) {
      continue;
    }
    const code = error[key as keyof typeof error];
    if (typeof code === "string" || typeof code === "number") {
      return code;
    }
  }
  return "error" in error && error.error !== error ? errorCode(error.error) : undefined;
}

function errorDescription(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("description" in error && typeof error.description === "string") {
    return error.description;
  }
  return "error" in error && error.error !== error ? errorDescription(error.error) : undefined;
}

function canUseAdmin(ctx: Context, config: Config): boolean {
  return ctx.chat?.type === "private" && config.adminUserIds.has(String(ctx.from?.id));
}

async function sendAdminCopy(
  pool: Pool,
  adminBot: Bot,
  config: Config,
  whisper: SelectedWhisper,
  senderName: string,
  alreadyClaimed = false,
): Promise<{ delivered: boolean; mustRollback: boolean }> {
  const selected = alreadyClaimed ? whisper : await claimAdminCopy(pool, whisper.id);
  if (!selected) {
    return { delivered: false, mustRollback: false };
  }
  let adminMessageId: number | undefined;
  try {
    const message = [
      "📥 New Whisper Captured",
      `👤 From: ${senderName}`,
      `🎯 To: @${selected.recipientUsername}`,
      `💬 Content: ${selected.secret}`,
    ].join("\n");
    const sent = await adminBot.api.sendMessage(Number(config.adminChatId), message);
    adminMessageId = sent.message_id;
    await recordAdminCopy(
      pool,
      selected.id,
      config.adminChatId,
      sent.message_id,
      config.adminBotToken ? "admin" : "primary",
    );
    console.info("Admin copy delivered", {
      whisperId: selected.id,
      adminChatId: config.adminChatId,
    });
    return { delivered: true, mustRollback: false };
  } catch (error) {
    console.error("Admin copy delivery failed", {
      whisperId: selected.id,
      error: errorName(error),
      errorCode: errorCode(error),
      description: errorDescription(error),
    });
    if (adminMessageId !== undefined) {
      try {
        await adminBot.api.deleteMessage(Number(config.adminChatId), adminMessageId);
      } catch (deleteError) {
        console.error("Untracked admin-copy deletion failed", {
          whisperId: selected.id,
          error: errorName(deleteError),
        });
      }
    }
    await releaseAdminCopyClaim(pool, selected.id);
    return {
      delivered: false,
      mustRollback: config.adminCopyFailurePolicy === "rollback",
    };
  }
}

export function createBot(
  pool: Pool,
  config: Config,
  botUsername: string,
  adminBot: Bot,
): Bot {
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    const inserted = await pool.query(
      `INSERT INTO processed_updates (update_id)
       VALUES ($1)
       ON CONFLICT (update_id) DO NOTHING
       RETURNING update_id`,
      [ctx.update.update_id],
    );
    if (inserted.rowCount) {
      await next();
    }
  });

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please open this bot in a private chat to continue.");
      return;
    }
    const sender = ctx.from;
    if (!sender) {
      await ctx.reply("Please open this bot in a private chat to continue.");
      return;
    }
    const senderId = String(sender.id);
    const startAward = await initializeUserOnStart(
      pool,
      senderId,
      sender.username?.toLowerCase() ?? null,
    );
    if (await claimBotStartNotification(pool, senderId)) {
      const displayName = sender.username
        ? `@${sender.username}`
        : sanitizeDisplayName(
            [sender.first_name, sender.last_name].filter(Boolean).join(" ") ||
              `Telegram user ${senderId}`,
          );
      try {
        await adminBot.api.sendMessage(
          Number(config.adminChatId),
          `🚀 New iPsstRobot user started the bot\n👤 User: ${displayName}\n🆔 Telegram ID: ${senderId}`,
        );
        await markBotStartNotificationSent(pool, senderId);
      } catch (error) {
        try {
          await releaseBotStartNotification(pool, senderId);
        } catch (releaseError) {
          console.error("Could not release failed start-notification claim", {
            userId: senderId,
            error: errorName(releaseError),
          });
        }
        console.error("New-user start notification failed", {
          userId: senderId,
          error: errorName(error),
          errorCode: errorCode(error),
          description: errorDescription(error),
        });
      }
    }
    if (startAward.awarded) {
      await ctx.reply(
        `🎉 Congratulations! You earned 1 star for starting the bot. Your balance is ${startAward.starsBalance} ⭐. Keep using iPsstRobot to earn more!`,
      );
    }
    const payload = ctx.match.trim();
    if (payload.startsWith("wh_")) {
      const token = payload.slice(3);
      if (!isValidWhisperToken(token)) {
        await ctx.reply("This whisper link is invalid, expired, or already used.");
        return;
      }
      const allowed = await allowRateLimitedAction(
        pool,
        String(sender.id),
        "reveal",
        10,
        600,
      );
      if (!allowed) {
        await ctx.reply("Too many attempts. Please try again later.");
        return;
      }
      const activated = await activateWhisperByToken(
        pool,
        token,
        String(sender.id),
        sender.username?.toLowerCase() ?? null,
      );
      if (activated) {
        console.warn("Whisper activated from recipient deep link", {
          whisperId: activated.id,
          senderId: activated.senderId,
        });
        const withinCreationLimit = await allowRateLimitedAction(
          pool,
          activated.senderId,
          "create",
          5,
          600,
        );
        if (!withinCreationLimit) {
          await removeWhisper(pool, activated.id);
          await ctx.reply(
            "This whisper could not be activated because the sender has reached the sending limit. Ask them to send a new one later.",
          );
          return;
        }
        const adminCopy = await sendAdminCopy(
          pool,
          adminBot,
          config,
          activated,
          activated.senderUsername
            ? `@${activated.senderUsername}`
            : `Telegram user ${activated.senderId}`,
        );
        if (adminCopy.mustRollback) {
          await removeWhisper(pool, activated.id);
          await ctx.reply(
            "This whisper could not be delivered because the copy failed. Ask the sender to send a new one.",
          );
          return;
        }
      } else {
        const pendingAdminCopy = await claimAdminCopyByToken(pool, token);
        if (pendingAdminCopy) {
          const adminCopy = await sendAdminCopy(
            pool,
            adminBot,
            config,
            pendingAdminCopy,
            pendingAdminCopy.senderUsername
              ? `@${pendingAdminCopy.senderUsername}`
              : `Telegram user ${pendingAdminCopy.senderId}`,
            true,
          );
          if (adminCopy.mustRollback) {
            await removeWhisper(pool, pendingAdminCopy.id);
            await ctx.reply(
              "This whisper could not be delivered because the admin copy failed. Ask the sender to send a new one.",
            );
            return;
          }
        }
      }
      const whisper = await consumeWhisper(
        pool,
        token,
        String(sender.id),
        sender.username?.toLowerCase() ?? null,
        0,
      );
      if (!whisper) {
        const revealFailure = await getWhisperRevealFailure(
          pool,
          token,
          String(sender.id),
          sender.username?.toLowerCase() ?? null,
        );
        if (revealFailure === "username_mismatch") {
          await ctx.reply("This whisper is not for you.");
          return;
        }
        if (revealFailure === "claimed_by_another_account") {
          await ctx.reply("This whisper is not for you.");
          return;
        }
        await ctx.reply(
          "This whisper link is invalid, expired, or already used.",
        );
        return;
      }
      try {
        await ctx.reply(
          `They whispered 🤐:\n\n${whisper.secret}\n\n`,
        );
      } catch (error) {
        console.error("Whisper delivery failed", {
          error: errorName(error),
          recipientId: String(sender.id),
        });
        await ctx.reply("The whisper could not be delivered. Contact the sender to request a new one.");
        return;
      }
      if (whisper.inlineMessageId) {
        try {
          await ctx.api.editMessageTextInline(
            whisper.inlineMessageId,
            `✅ @${whisper.recipientUsername} read the whisper.\n\n✨ Keep using our bot to earn stars`,
            { reply_markup: { inline_keyboard: [] } },
          );
        } catch (error) {
          if (!errorDescription(error)?.toLowerCase().includes("message is not modified")) {
            console.error("Failed to update read status on whisper card", {
              whisperId: whisper.id,
              error: errorName(error),
              errorCode: errorCode(error),
              description: errorDescription(error),
            });
          }
        }
      } else {
        console.warn("Whisper was read but has no inline message ID to update", {
          whisperId: whisper.id,
        });
      }
      return;
    }
    await ctx.reply(PRIVATE_START_TEXT, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
  });

  bot.command("privacy", async (ctx) => {
    await ctx.reply(PRIVACY_TEXT, { parse_mode: "HTML" });
  });

  bot.command("register", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please open iPsstRobot in a private chat to register.");
      return;
    }
    await ctx.reply(REGISTER_TEXT, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Register me", "register_me"),
    });
  });

  bot.command("earn", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please run /earn in a private chat with this bot.");
      return;
    }
    await ctx.reply(EARN_TEXT);
  });

  bot.command("balance", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please run /balance in a private chat with this bot.");
      return;
    }
    const sender = ctx.from;
    if (!sender) {
      await ctx.reply("Please open this bot in a private chat to check your balance.");
      return;
    }
    try {
      const userId = String(sender.id);
      await creditEligibleStars(pool, userId);
      const status = await getEarnStatus(pool, userId);
      await ctx.reply(`⭐ Your balance is ${status.stars} star${status.stars === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("Balance lookup failed", {
        userId: String(sender.id),
        error: errorName(error),
        errorCode: errorCode(error),
        description: errorDescription(error),
      });
      await ctx.reply("I couldn't load your balance right now. Please try /balance again shortly.");
    }
  });

  bot.command("withdraw", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please run /withdraw in a private chat with this bot.");
      return;
    }
    const sender = ctx.from;
    if (!sender) {
      await ctx.reply("Please open this bot in a private chat to request a withdrawal.");
      return;
    }
    const amountText = ctx.match.trim();
    if (!/^\d+$/.test(amountText) || !Number.isSafeInteger(Number(amountText))) {
      await ctx.reply("Usage: /withdraw <amount>\nMinimum withdrawal: 50 stars.");
      return;
    }
    const amount = Number(amountText);
    if (amount < 50) {
      await ctx.reply("The minimum withdrawal is 50 stars.");
      return;
    }
    try {
      const userId = String(sender.id);
      await creditEligibleStars(pool, userId);
      const status = await getEarnStatus(pool, userId);
      if (amount > status.stars) {
        await ctx.reply(`You have ${status.stars} stars, which is not enough to withdraw ${amount}.`);
        return;
      }
      await ctx.reply(
        `You have enough stars for a ${amount}-star withdrawal (minimum 50). Withdrawals are not processed automatically yet; please contact the bot admin. No stars have been deducted.`,
      );
    } catch (error) {
      console.error("Withdrawal balance check failed", {
        userId: String(sender.id),
        amount,
        error: errorName(error),
        errorCode: errorCode(error),
        description: errorDescription(error),
      });
      await ctx.reply("I couldn't check your withdrawal amount right now. Please try again shortly.");
    }
  });

  bot.command("whisper", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please use /whisper in a private chat with this bot.");
      return;
    }
    const sender = ctx.from;
    if (!sender) {
      await ctx.reply("Please open this bot in a private chat to send a whisper.");
      return;
    }
    const match = ctx.match.trim().match(/^@([A-Za-z0-9_]{5,32})\s+([\s\S]+)$/);
    const secret = match?.[2]?.trim();
    if (!match || !secret || secret.length > config.whisperMaxLength) {
      await ctx.reply(
        `Usage: /whisper @username your message\nWhispers must contain 1 to ${config.whisperMaxLength} characters.`,
      );
      return;
    }
    const allowed = await allowRateLimitedAction(pool, String(sender.id), "draft", 100, 600);
    if (!allowed) {
      await ctx.reply("Please wait before preparing another whisper.");
      return;
    }
    const token = createWhisperToken();
    const draft = await createWhisper(pool, {
      token,
      senderId: String(sender.id),
      senderUsername: sender.username?.toLowerCase() ?? null,
      recipientId: null,
      recipientUsername: match[1]!.toLowerCase(),
      secret,
    });
    await ctx.reply(
      "Your private draft is ready and expires in 15 minutes.",
      { reply_markup: new InlineKeyboard().switchInline("📤 Post whisper", `draft_${token}`) },
    );
    console.info("Private long-whisper draft prepared", {
      whisperId: draft.id,
      senderId: sender.id,
      recipientUsername: match[1]!.toLowerCase(),
    });
  });

  bot.command("forgetme", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Please run /forgetme in a private chat with this bot.");
      return;
    }
    const sender = ctx.from;
    if (!sender) {
      await ctx.reply("Please open this bot in a private chat to continue.");
      return;
    }
    const copies = await forgetUser(pool, String(sender.id));
    for (const copy of copies) {
      try {
        const copyBot = copy.botKind === "admin" ? adminBot : bot;
        await copyBot.api.deleteMessage(Number(copy.chatId), copy.messageId);
      } catch (error) {
        console.error("Admin-copy deletion failed", {
          error: errorName(error),
          chatId: copy.chatId,
          messageId: copy.messageId,
        });
      }
    }
    await ctx.reply(
      "Your registration and unread whispers addressed to you have been removed. Deletion of copies from Telegram clients is best-effort.",
    );
  });

  bot.command("admin", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Admin status is only available in a private chat.");
      return;
    }
    if (!canUseAdmin(ctx, config)) {
      await ctx.reply("This command is only available to configured administrators.");
      return;
    }
    const status = await getAdminStatus(pool);
    await ctx.reply(
      `Operational status\nRegistered users: ${status.registrations}\nUnread whispers: ${status.unread}\nExpired awaiting cleanup: ${status.expiredPendingCleanup}`,
    );
  });

  bot.command("testadmin", async (ctx) => {
    if (!canUseAdmin(ctx, config)) {
      await ctx.reply("This command is only available to configured administrators in private chat.");
      return;
    }
    try {
      await adminBot.api.sendMessage(
        Number(config.adminChatId),
        "✅ Admin bot connection is working.",
      );
      await ctx.reply("Test sent. Check your private chat with the configured admin bot.");
    } catch (error) {
      console.error("Admin bot test delivery failed", {
        error: errorName(error),
        errorCode: errorCode(error),
        description: errorDescription(error),
      });
      await ctx.reply("Admin bot test failed. Check the bot terminal for its Telegram error.");
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data === "register_me") {
      const message = ctx.callbackQuery.message;
      if (!message || message.chat.type !== "private") {
        await ctx.answerCallbackQuery({
          text: "Open iPsstRobot in a private chat to register.",
          show_alert: true,
        });
        return;
      }
      const sender = ctx.callbackQuery.from;
      try {
        await registerUser(
          pool,
          String(sender.id),
          sender.username?.toLowerCase() ?? null,
          true,
        );
      } catch (error) {
        console.error("User registration failed", {
          userId: String(sender.id),
          error: errorName(error),
          errorCode: errorCode(error),
        });
        await ctx.answerCallbackQuery({
          text: "Registration failed. Please try again later.",
          show_alert: true,
        });
        return;
      }

      const confirmation = [
        "✅ <b>You’re registered!</b>",
        "",
        "You’re enrolled to earn stars. You earn 1 star for every 10 whispers you post after one week.",
        "",
        "Use /balance to check your balance and /earn for the full earning details.",
      ].join("\n");
      await ctx.answerCallbackQuery({ text: "Registered! See the confirmation in this chat." });
      try {
        await ctx.api.editMessageText(message.chat.id, message.message_id, confirmation, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) {
        console.error("Registration confirmation message edit failed", {
          userId: String(sender.id),
          error: errorName(error),
          errorCode: errorCode(error),
        });
        await ctx.api.sendMessage(sender.id, confirmation, { parse_mode: "HTML" });
      }
      return;
    }
    const match = ctx.callbackQuery.data.match(/^read_([A-Za-z0-9_-]{43})$/);
    if (!match) {
      await ctx.answerCallbackQuery({ text: "This whisper button is invalid." });
      return;
    }
    const token = match[1]!;
    const recipient = ctx.callbackQuery.from;
    const failure = await getWhisperRevealFailure(
      pool,
      token,
      String(recipient.id),
      recipient.username?.toLowerCase() ?? null,
    );
    if (failure) {
      await ctx.answerCallbackQuery({ text: "This whisper is not for you.", show_alert: true });
      return;
    }
    if (!ctx.callbackQuery.inline_message_id) {
      await ctx.answerCallbackQuery({
        text: "Open the whisper from its private link instead.",
        show_alert: true,
      });
      return;
    }
    await saveInlineMessageIdByToken(pool, token, ctx.callbackQuery.inline_message_id);
    await ctx.answerCallbackQuery({
      url: `https://t.me/${botUsername}?start=wh_${token}`,
    });
  });

  bot.on("inline_query", async (ctx) => {
    const sender = ctx.from;
    if (!sender) {
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      return;
    }
    const input = ctx.inlineQuery.query.trim();
    const draftMatch = input.match(/^draft_([A-Za-z0-9_-]{43})$/);
    if (draftMatch) {
      const token = draftMatch[1]!;
      const draft = await getWhisperDraft(pool, token, String(sender.id));
      if (!draft) {
        await ctx.answerInlineQuery(
          [genericResult("Draft unavailable", "It may have expired.", "This whisper draft has expired or is unavailable.")],
          { cache_time: 0, is_personal: true },
        );
        return;
      }
      await ctx.answerInlineQuery(
        [whisperCardResult(draft.id, draft.recipientUsername, token, botUsername)],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    const match = input.match(/^@([A-Za-z0-9_]{5,32})\s+([\s\S]+)$/);
    if (!match) {
      await ctx.answerInlineQuery(
        [
          genericResult(
            "How to send a whisper",
            "Use @recipient followed by your message.",
            "To send a whisper, enter @iPsstRobot @recipient your secret message. The recipient must open the link while signed into the Telegram account with that exact current username; no prior registration is needed.",
          ),
        ],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    const requestedUsername = match[1];
    const untrimmedSecret = match[2];
    if (!requestedUsername || untrimmedSecret === undefined) {
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      return;
    }
    const secret = untrimmedSecret.trim();
    if (!secret || secret.length > config.whisperMaxLength) {
      await ctx.answerInlineQuery(
        [
          genericResult(
            "Message too long or empty",
            `Whispers must contain 1 to ${config.whisperMaxLength} characters.`,
            `Whispers must contain 1 to ${config.whisperMaxLength} characters.`,
          ),
        ],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    const allowed = await allowRateLimitedAction(pool, String(sender.id), "draft", 100, 600);
    if (!allowed) {
      await ctx.answerInlineQuery(
        [genericResult("Please slow down", "Try again later.", "Please wait before preparing another whisper.")],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    const token = createWhisperToken();
    const whisper = await createWhisper(pool, {
      token,
      senderId: String(sender.id),
      senderUsername: sender.username?.toLowerCase() ?? null,
      recipientId: null,
      recipientUsername: requestedUsername.toLowerCase(),
      secret,
    });
    console.info("Inline whisper draft prepared", {
      whisperId: whisper.id,
      senderId: sender.id,
      recipientUsername: requestedUsername.toLowerCase(),
    });

    try {
      const result = whisperCardResult(whisper.id, requestedUsername.toLowerCase(), token, botUsername);
      await ctx.answerInlineQuery([result], { cache_time: 0, is_personal: true });
    } catch (error) {
      await removeWhisper(pool, whisper.id);
      console.error("Inline result delivery failed", {
        whisperId: whisper.id,
        error: errorName(error),
      });
    }
  });

  bot.on("chosen_inline_result", async (ctx) => {
    const chosen = ctx.chosenInlineResult;
    console.info("Inline result selected", {
      resultId: chosen.result_id,
      senderId: chosen.from.id,
      inlineMessageIdAvailable: Boolean(chosen.inline_message_id),
    });
    if (!chosen.inline_message_id) {
      console.warn("Selected whisper card cannot be edited until its read button is tapped", {
        resultId: chosen.result_id,
      });
    }
    const selected = await activateWhisper(
      pool,
      chosen.result_id,
      String(chosen.from.id),
      chosen.inline_message_id ?? null,
    );
    if (!selected) {
      console.error("Selected inline result could not be activated", {
        resultId: chosen.result_id,
        senderId: chosen.from.id,
      });
      return;
    }
    console.info("Sending selected whisper to admin chat", {
      whisperId: selected.id,
      adminChatId: config.adminChatId,
    });

    const withinCreationLimit = await allowRateLimitedAction(
      pool,
      String(chosen.from.id),
      "create",
      5,
      600,
    );
    if (!withinCreationLimit) {
      await removeWhisper(pool, selected.id);
      if (chosen.inline_message_id) {
        try {
          await ctx.api.editMessageTextInline(
            chosen.inline_message_id,
            "This whisper was not sent because sending is temporarily rate-limited.",
            { reply_markup: { inline_keyboard: [] } },
          );
        } catch (error) {
          console.error("Failed to update rate-limited whisper card", {
            whisperId: selected.id,
            error: errorName(error),
          });
        }
      }
      return;
    }

    const senderName = sanitizeDisplayName(
      chosen.from.username
        ? `@${chosen.from.username}`
        : [chosen.from.first_name, chosen.from.last_name].filter(Boolean).join(" ") ||
            `Telegram user ${chosen.from.id}`,
    );
    const adminCopy = await sendAdminCopy(pool, adminBot, config, selected, senderName);
    if (!adminCopy.delivered && adminCopy.mustRollback) {
      await removeWhisper(pool, selected.id);
      if (chosen.inline_message_id) {
        try {
          await ctx.api.editMessageReplyMarkupInline(chosen.inline_message_id, {
            reply_markup: { inline_keyboard: [] },
          });
        } catch (editError) {
          console.error("Failed to remove unusable whisper button", {
            whisperId: selected.id,
            error: errorName(editError),
          });
        }
      }
    }
  });

  bot.catch((error) => {
    console.error("Bot update failed", {
      updateId: error.ctx.update.update_id,
      updateType: Object.keys(error.ctx.update).find((key) => key !== "update_id"),
      error: errorName(error),
      errorCode: errorCode(error),
      description: errorDescription(error),
      cause: error instanceof Error ? error.message : String(error),
    });
  });

  return bot;
}

export function startCleanupWorker(
  pool: Pool,
  bot: Bot,
  adminBot: Bot,
  intervalMs = 60 * 1000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const expiredCopies = await cleanupExpired(pool);
        for (const copy of expiredCopies) {
          try {
            const copyBot = copy.botKind === "admin" ? adminBot : bot;
            await copyBot.api.deleteMessage(Number(copy.chatId), copy.messageId);
          } catch (error) {
            console.error("Expired admin-copy deletion failed", {
              whisperId: copy.id,
              error: errorName(error),
            });
          }
        }
        const awards = await creditEligibleStars(pool);
        for (const award of awards) {
          try {
            await bot.api.sendMessage(
              Number(award.userId),
              `⭐ You earned ${award.starsAdded} star${award.starsAdded === 1 ? "" : "s"}! Your balance is now ${award.starsBalance} stars. Use /balance to check your balance and /earn to learn how to earn more.`,
            );
          } catch (error) {
            console.error("Star award notification failed", {
              userId: award.userId,
              starsAdded: award.starsAdded,
              error: errorName(error),
            });
          }
        }
      } catch (error) {
        console.error("Whisper cleanup failed", { error: errorName(error) });
      }
    })();
  }, intervalMs);
  timer.unref();
  return timer;
}

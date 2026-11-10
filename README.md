# Telegram Inline Whisper Bot

A TypeScript, grammY, and PostgreSQL bot for sending private whispers from Telegram inline mode. The public card never contains the secret and changes to show who read the whisper. The secret is removed from active whisper storage immediately after it is read.

## Requirements

- Node.js 20 or newer
- PostgreSQL 13 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

1. Create the whisper bot with BotFather and copy its token. To receive admin copies from a separate bot, create a second bot too and copy that token separately.
2. Enable inline mode with BotFather: run `/setinline`, select the bot, and provide a placeholder such as `@recipient message`. Then run `/setinlinefeedback`, select the bot, and enable 100% inline feedback. The bot uses Telegram's `chosen_inline_result` update to create the admin copy only after the sender selects a result; drafts from typing are not sent as whispers.
3. Create a PostgreSQL database and user.
4. Copy `.env.example` to `.env`, then set `BOT_TOKEN`, `DATABASE_URL`, the private `ADMIN_CHAT_ID`, and comma-separated `ADMIN_USER_IDS`. To use the second bot for admin copies, put its token in `ADMIN_BOT_TOKEN`; leave it blank to use the main bot. Open the selected admin-copy bot in Telegram and press Start before sending whispers. Never commit `.env`.
5. Install, build, and run:

   ```sh
   npm install
   npm run build
   npm start
   ```

Migrations run automatically at startup. Run the process from the project directory so the `migrations` folder can be found. In production, run one bot instance per polling token; PostgreSQL update receipts and row locks provide duplicate and concurrent-reveal protection.

## Deploying to Railway

1. Push this project to a private GitHub repository. Do not commit `.env`; it contains live configuration. `.env.example` should contain placeholders only.
2. In Railway, create a project and add a PostgreSQL database.
3. Add a service from your GitHub repository. Configure the build command as `npm run build` and the start command as `npm start`. This is a long-running Telegram polling bot; it does not need a public domain or web port.
4. Add these variables to the bot service:
   - `BOT_TOKEN`: the main bot token from BotFather.
   - `ADMIN_BOT_TOKEN`: optional; omit or leave blank to send admin copies with the main bot.
   - `DATABASE_URL`: reference the Railway PostgreSQL service's `DATABASE_URL`.
   - `ADMIN_CHAT_ID`: the admin's numeric private Telegram chat ID.
   - `ADMIN_USER_IDS`: comma-separated allowed admin Telegram user IDs, including `ADMIN_CHAT_ID`.
   - `ADMIN_COPY_FAILURE_POLICY`: `rollback` or `continue` (optional; defaults to `rollback`).
   - `WHISPER_MAX_LENGTH`: optional; defaults to `3500`.
5. Deploy and check the service logs for `Whisper bot started`. Migrations run automatically at startup. Start the selected admin-copy bot in Telegram before testing admin copies.

Keep the bot service to a single running instance for each Telegram polling token. Do not run both a local copy and the Railway copy at the same time with the same token; Telegram polling will conflict.

## User flow

1. For a short whisper, type `@YourBot @recipient your secret message` in any chat and select the result. For a longer one, privately send `/whisper @recipient your full message` to the bot, then tap **Post whisper** and choose the chat where you want to share the card. Whispers can be up to 3,500 characters.
2. The posted card identifies the intended username, has an **🔐 Read whisper privately** button, and includes the bot's **Earn with us** handle. It never includes the secret. Before posting, the inline result discloses that the configured admin receives a copy of the message. The read button records the inline card ID before opening the private whisper link, so a successful read can update the public card even if Telegram did not send the chosen-inline-result update.
3. The intended recipient taps the card while signed into the Telegram account with the exact username addressed by the sender. The bot verifies the username, binds the account's Telegram user ID, sends the admin copy, and privately delivers the whisper. The public card then changes to `@username read the whisper`, and the secret is removed from active whisper storage.

Use `/help` for instructions, `/register` to register, `/earn` to see star progress, and `/privacy` for privacy details. The configured admin is notified once when each Telegram account first starts the bot. `/forgetme` and `/admin` remain available but are not listed in the public command menu.

## Telegram limitations and recipient matching

Telegram bots cannot reliably look up an arbitrary `@username` to a user ID. A whisper addressed to a username stays unclaimed until someone opens its deep link in a private chat. The bot only allows the first account whose current Telegram username matches the addressed username to claim it, then binds the recipient Telegram ID and enforces that ID for reads. No prior `/register` is needed. The recipient must have a Telegram username and open the link while using the matching account; a username that changes before the link is opened will not match. Because usernames can change or be reassigned, this is less reliable than pre-registering a known recipient ID.

The bot cannot send an unsolicited private message to a user. The recipient must click the link themselves; Telegram opens the bot in a private chat and may show a Start button. Pressing Start submits the link payload and the bot attempts to verify the username and reveal the whisper.

The public card reveals who read a whisper, but only the intended recipient can read its contents. Username matching, first-time account binding, recipient identity, and expiry are enforced in the database. A wrong account is told, "This whisper is not for you."

## Earning stars

Run `/register` and tap **Register me**. After one week, the bot automatically credits 1 star for every 10 whispers you post; `/earn` shows your balance and progress. Only selected, posted whispers count. Star credits are processed by the bot's periodic worker and announced privately when possible. After code changes, rebuild and restart the bot (`npm run build`, then `npm start`) so the updated command handler and database migrations are loaded.

## Editing user-facing text

The welcome message (`PRIVATE_START_TEXT`), `/help` (`HELP_TEXT`), `/register` (`REGISTER_TEXT`), `/earn` (`EARN_TEXT`), and `/privacy` (`PRIVACY_TEXT`) replies are in `src/bot.ts`. The posted whisper card text and buttons are in `whisperCardResult` in the same file. Bot command-menu labels are in `src/index.ts`; this README documents the setup and user flow.

## Privacy, admin copies, and retention

Each selected whisper is copied to `ADMIN_CHAT_ID` with sender, recipient, and message. When `ADMIN_BOT_TOKEN` is configured, copies are sent by that separate bot; otherwise, the main bot sends them. The copy format is `📥 New Whisper Captured`, `👤 From`, `🎯 To`, and `💬 Content`. **The configured admin can read the complete message.** The sender is shown this disclosure in `/start`, `/help`, `/privacy`, and the inline result description before choosing to send. `ADMIN_CHAT_ID` must also appear in `ADMIN_USER_IDS`; only Telegram accounts listed there can use `/admin` through the main bot. Inline drafts are removed if not selected within 15 minutes.

The configured admin bot also receives one notification the first time each Telegram account starts the main bot. It includes the user's username (or display name) and Telegram user ID.

Admin copies remain in the configured admin chat after the recipient reads the whisper. At the 24-hour expiry, a cleanup worker erases the whisper record and attempts to delete the related admin copy; Telegram deletion is best-effort, and clients may retain copies or Telegram may reject deletion. The secret is removed from active whisper storage immediately on reveal. `/forgetme` removes the user's registration and unread incoming records, and attempts to delete related admin copies.

Whisper secrets are always removed from active whisper storage immediately after the first successful read. The token is generated with Node's cryptographic random generator; only its SHA-256 hash is stored. The token is a bearer secret in the deep link, so avoid forwarding or logging it.

If Telegram rejects an admin-copy send, the default `ADMIN_COPY_FAILURE_POLICY=rollback` removes the whisper and does not publish a working result. Set it to `continue` to publish despite a failed admin copy; this is logged without the message, token, or API error text. Choose `continue` only if that privacy tradeoff is acceptable. No secret text is written to application logs.

## Configuration

| Variable | Required | Description |
|---|---:|---|
| `BOT_TOKEN` | Yes | Token from BotFather |
| `ADMIN_BOT_TOKEN` | No | Optional separate BotFather token used only to send and delete admin copies; defaults to `BOT_TOKEN` |
| `DATABASE_URL` | Yes | PostgreSQL connection URL |
| `ADMIN_CHAT_ID` | Yes | Positive private Telegram chat ID receiving admin copies |
| `ADMIN_USER_IDS` | Yes | Comma-separated Telegram user IDs allowed to use `/admin` |
| `ADMIN_COPY_FAILURE_POLICY` | No | `rollback` (default) or `continue` |
| `WHISPER_MAX_LENGTH` | No | Maximum secret length in UTF-16 code units, default and maximum `3500`; use `/whisper` for longer messages |

Whisper creation is limited to five per sender per ten minutes; inline draft preparation is limited to 100 per sender per ten minutes, and reveal attempts are limited to ten per account per ten minutes. Inline answers use zero-second caching and are marked personal.

## Tests

```sh
npm test
```

Token tests run without PostgreSQL. To run authorization, expiry, retention, and concurrent-consumption integration tests, create a disposable test database and set `TEST_DATABASE_URL`:

```powershell
$env:TEST_DATABASE_URL = "postgresql://user:password@localhost:5432/whisper_test"
npm test
```

The integration test creates and drops a uniquely named schema in that database. Use a disposable database account with permission to create schemas. Startup migrations apply automatically, including the admin-copy bot tracking migration.

## Deployment

Deploy the compiled `dist` directory, `migrations` directory, and production dependencies. Provide secrets through the platform's environment configuration, allow outbound HTTPS to Telegram and network access to PostgreSQL, then run `npm start` under a process supervisor. Configure only one long-polling process for the bot token. Monitor startup/update/cleanup errors; logs deliberately contain error names and operational identifiers, never whisper contents or tokens.

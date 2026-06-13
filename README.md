# NX Services Tracker v1.0.8

This version adds Telegram integration on top of the existing tracker, email digest, IST reminder handling, and OpenClaw automation API.

## What is included

- Telegram notifications for waiting-for task creation/update
- Telegram daily digest reminder
- Telegram command polling over HTTPS, so no public webhook URL is required
- Telegram user mapping using `telegram_chat_id`
- Existing email reminder flow remains unchanged
- Existing OpenClaw API remains available

## Telegram setup

1. Open Telegram and search for `@BotFather`.
2. Send `/newbot` and follow the prompts.
3. Copy the bot token.
4. Add this to `.env`:

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
TELEGRAM_BOT_POLLING_ENABLED=true
TELEGRAM_POLL_INTERVAL_SECONDS=20
```

5. Restart the tracker app/service.
6. In Telegram, open your bot and send:

```text
/id
```

7. The bot will reply with your Telegram chat ID.
8. In the tracker app, go to Users and paste that chat ID for the correct user. Tick `Enable Telegram reminders and commands`.

## Telegram commands

```text
/id
/mytasks
/done NX-0013 optional note
/status NX-0013 In Progress optional note
/comment NX-0013 comment text
/create Title | Waiting For | Due YYYY-MM-DD | Priority | Description
```

Example:

```text
/create IC verification pending | Jayaram | 2026-06-20 | Medium | Please verify the IC request.
```

## Security notes

Only active users with a matching `telegram_chat_id` and Telegram opt-in enabled can run task commands.

Avoid putting sensitive customer data in Telegram messages. Prefer task codes, short titles, and tracker links.

## Apply update on Windows VM

Stop service:

```powershell
net stop NXServicesTracker
```

Backup current folder:

```powershell
Copy-Item "E:\NotifyApp\nx-services-tracker\nx-services-tracker\Task_Tracker" "E:\NotifyApp\Task_Tracker_Backup_v108_Telegram" -Recurse
```

Copy these from this package into your current app folder:

```text
src
views
public
openclaw
scripts
package.json
package-lock.json
.env.example
README.md
```

Do not overwrite your real `.env`.

Install dependencies and start:

```powershell
cd E:\NotifyApp\nx-services-tracker\nx-services-tracker\Task_Tracker
npm install
net start NXServicesTracker
```

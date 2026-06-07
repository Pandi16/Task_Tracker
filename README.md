# NX Services Tracker

Lightweight internal tracker for NX/services work items.

## Main features

- Login and user management
- Create, edit, and delete work items
- Track owner, status, priority, component, due date, and waiting-for person
- Waiting-for dashboard grouped by person
- Comments and activity history
- In-app notifications
- Immediate email alert when an item is waiting for a user
- Daily 10 AM user-wise reminder digest for all pending waiting-for items
- Email delivery through Google Apps Script over HTTPS, so SMTP ports are not required

## Windows VM setup

Install Node.js, PostgreSQL, and NSSM. Then configure `.env`.

```env
SESSION_SECRET=nx-tracker-local-secret-change-later
DATABASE_URL=postgres://nxuser:NxStrongPassword123@127.0.0.1:5432/nxtracker
ADMIN_NAME=Admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe123!

APPS_SCRIPT_WEBAPP_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
APPS_SCRIPT_SECRET=use-the-same-secret-from-google-apps-script
MAIL_FROM_NAME=NX Tracker

DAILY_REMINDER_HOUR=10
DAILY_REMINDER_MINUTE=0
```

Start manually:

```powershell
npm install
npm start
```

For production on Windows, run `src/server.js` as a Windows service using NSSM.

## Google Apps Script mailer setup

1. Create or use a Gmail/Google account dedicated to the tracker, for example `nxtracker.alerts@gmail.com`.
2. Open Google Apps Script.
3. Create a new project.
4. Copy the code from `scripts/google-apps-script-mailer.js` into the Apps Script editor.
5. Replace `CHANGE_THIS_TO_A_LONG_RANDOM_SECRET` with a long random value.
6. Click Deploy > New deployment > Web app.
7. Use these deployment settings:
   - Execute as: Me
   - Who has access: Anyone
8. Authorize the script when Google asks.
9. Copy the Web app URL ending with `/exec`.
10. Put the URL in `APPS_SCRIPT_WEBAPP_URL` and the same secret in `APPS_SCRIPT_SECRET` in your tracker `.env`.
11. Restart the tracker service.

## Email behavior

Immediate email:

- Sent when an item is created or updated as `Waiting For`.
- Sent only to the selected waiting-for user.

Daily digest:

- Runs every 15 minutes internally.
- Once the configured reminder time is reached, default 10:00 AM VM local time, each waiting-for user receives one email listing all tasks waiting for them.
- A user receives at most one daily digest per day.
- Items stop appearing in the digest once their status is changed from `Waiting For`, such as `Completed`.


## Daily reminder timezone

Daily reminder emails are based on `DAILY_REMINDER_TIMEZONE`, not the VM clock. To send the reminder at 10:00 AM IST even when the VM is in a US timezone, use:

```env
DAILY_REMINDER_TIMEZONE=Asia/Kolkata
DAILY_REMINDER_HOUR=10
DAILY_REMINDER_MINUTE=0
```

The scheduler checks every 15 minutes and sends one digest per user per configured timezone date.

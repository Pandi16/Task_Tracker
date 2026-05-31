# NX Services Tracker

A lightweight internal JIRA-style tracker for NX/services items.

## Features

- Login
- Add 4-5 team users
- Create NX work items
- Status workflow
- Owner tracking
- Waiting For tracking
- Waiting For dashboard
- Comments
- Activity log
- In-app notifications
- Hourly overdue reminder job
- Optional email notifications through SMTP
- Docker-based VM hosting

## Recommended stack

- Node.js + Express
- PostgreSQL
- EJS templates
- Docker Compose

## Run locally using Docker

1. Copy environment file:

```bash
cp .env.example .env
```

2. Update `.env` values, especially:

```bash
SESSION_SECRET=change-this-long-secret
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe123!
```

3. Start the app:

```bash
docker compose up --build -d
```

4. Open:

```text
http://localhost:3000
```

5. Login using the admin email/password from `.env`.

## VM hosting

On the VM:

```bash
git clone <your-repo-url>
cd nx-services-tracker
cp .env.example .env
nano .env
docker compose up --build -d
```

Allow port 3000 in firewall or place Nginx in front of it.

## Email notifications

Add SMTP details in `.env`:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password
SMTP_FROM=NX Tracker <no-reply@example.com>
```

If SMTP is not configured, in-app notifications still work.

## Suggested first users

Create users from the Admin `Users` page:

- Harsha
- Praveen
- Ashok
- Testing Team
- Server Team

## Main workflow

New → Triaged → Assigned → In Progress → Waiting For → Ready for Review → Completed

Extra states: Blocked, Reopened, Cancelled.

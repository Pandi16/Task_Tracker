---
name: nx-services-tracker
description: Create, update, search, and complete NX Services Tracker work items through the configured MCP tools.
---

# NX Services Tracker Skill

Use this skill when the user asks to create or update NX/services tracker tasks, move a task to another status, change the Waiting For person, add comments, or list pending items.

## Tools to use

Use the configured MCP server tools:

- `list_tracker_users`
- `list_tracker_items`
- `create_tracker_item`
- `update_tracker_status`
- `complete_tracker_item`
- `set_tracker_waiting_for`
- `add_tracker_comment`
- `tracker_health`

## Rules

- Prefer using a user's email address when available. If a person name is ambiguous, call `list_tracker_users` first.
- Do not create duplicate tasks. If the user mentions an existing item or title, call `list_tracker_items` first.
- For casual phrases like "move NX-13 to done", call `complete_tracker_item`.
- For "waiting for Jayaram", call `set_tracker_waiting_for`.
- Never delete users or tasks through OpenClaw. Deletion should remain a manual admin action in the web app.
- For unclear due dates, ask a short follow-up question before creating the item.
- After every write action, summarize the item code and what changed.

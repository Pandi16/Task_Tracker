import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TRACKER_BASE_URL = (process.env.TRACKER_BASE_URL || 'http://ustr-mvm-8134.na.uis.unisys.com:3000').replace(/\/$/, '');
const TRACKER_API_KEY = process.env.TRACKER_API_KEY || '';

if (!TRACKER_API_KEY) {
  console.error('TRACKER_API_KEY is required for nx-tracker-mcp-server.');
  process.exit(1);
}

async function callTracker(path, options = {}) {
  const response = await fetch(`${TRACKER_BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TRACKER_API_KEY,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text };
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Tracker API failed with HTTP ${response.status}`);
  }
  return data;
}

function textResult(data) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      }
    ]
  };
}

const server = new McpServer({
  name: 'nx-services-tracker',
  version: '1.0.0'
});

server.tool(
  'tracker_health',
  'Check whether NX Services Tracker API is reachable.',
  {},
  async () => textResult(await callTracker('/api/openclaw/health'))
);

server.tool(
  'list_tracker_users',
  'List active NX Services Tracker users. Use this before assigning owner or waiting-for when the name is unclear.',
  {},
  async () => textResult(await callTracker('/api/openclaw/users'))
);

server.tool(
  'list_tracker_items',
  'List tracker items. Can filter by status, search text, owner, or waiting-for person.',
  {
    status: z.string().optional(),
    q: z.string().optional(),
    owner: z.string().optional(),
    waitingFor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional()
  },
  async (args) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params}` : '';
    return textResult(await callTracker(`/api/openclaw/items${suffix}`));
  }
);

server.tool(
  'create_tracker_item',
  'Create a new NX Services Tracker item. Waiting-for can be a full name or email address.',
  {
    title: z.string().min(1),
    description: z.string().optional(),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']).default('Medium'),
    status: z.enum(['New', 'Triaged', 'Assigned', 'In Progress', 'Waiting For', 'Ready for Review', 'Completed']).default('Waiting For'),
    owner: z.string().optional(),
    waitingFor: z.string().optional(),
    dueDate: z.string().optional(),
    createdBy: z.string().optional()
  },
  async (args) => textResult(await callTracker('/api/openclaw/items', { method: 'POST', body: args }))
);

server.tool(
  'update_tracker_status',
  'Update the status of an existing tracker item. Item code can be NX-0013 or 13.',
  {
    code: z.string().min(1),
    status: z.enum(['New', 'Triaged', 'Assigned', 'In Progress', 'Waiting For', 'Ready for Review', 'Completed']),
    changeNote: z.string().optional(),
    changedBy: z.string().optional()
  },
  async ({ code, ...body }) => textResult(await callTracker(`/api/openclaw/items/${encodeURIComponent(code)}/status`, { method: 'PATCH', body }))
);

server.tool(
  'complete_tracker_item',
  'Mark a tracker item as Completed.',
  {
    code: z.string().min(1),
    changeNote: z.string().optional(),
    changedBy: z.string().optional()
  },
  async ({ code, ...body }) => textResult(await callTracker(`/api/openclaw/items/${encodeURIComponent(code)}/complete`, { method: 'POST', body }))
);

server.tool(
  'set_tracker_waiting_for',
  'Set or change the Waiting For user for a tracker item. This sends the normal tracker notification.',
  {
    code: z.string().min(1),
    waitingFor: z.string().min(1)
  },
  async ({ code, waitingFor }) => textResult(await callTracker(`/api/openclaw/items/${encodeURIComponent(code)}/waiting-for`, { method: 'PATCH', body: { waitingFor } }))
);

server.tool(
  'add_tracker_comment',
  'Add a comment to a tracker item.',
  {
    code: z.string().min(1),
    comment: z.string().min(1),
    user: z.string().optional()
  },
  async ({ code, ...body }) => textResult(await callTracker(`/api/openclaw/items/${encodeURIComponent(code)}/comment`, { method: 'POST', body }))
);

const transport = new StdioServerTransport();
await server.connect(transport);

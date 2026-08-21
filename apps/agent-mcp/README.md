# @waves/agent-mcp

An MCP server that lets an AI agent act **inside Waves as a specific signed-in
user** — list groups, add expenses, and record settlements — through the app's
own authorized RPCs and edge functions. It never runs raw SQL and never moves
money.

## Why this instead of a database MCP

A generic Supabase/Postgres MCP talks raw SQL with a management or service
token. That bypasses Row-Level Security **and** the app's RPC boundary
(ADR-013, #274), so it can write malformed ledger rows that skip split maths and
integrity checks. This server does the opposite: it authenticates as a real user
(their Supabase session) and calls the exact operations the mobile app calls, so
RLS and the business rules apply to the agent identically to the human.

## Safety model

- **Acts as one user.** Built with the public anon key + the user's JWT — same
  as `apps/mobile/src/lib/supabase.ts`. No service-role key is read. The agent
  can do what that person can do, nothing more.
- **No raw SQL.** There is no query tool. Every write is one named, validated
  operation.
- **No money movement.** `record_settlement` writes a settlement row (status
  `initiated`); the actual transfer is a UPI/PayPal handoff link (`payment_link`)
  a human opens and confirms in their own bank app.
- **Read-only switch.** `WAVES_MCP_READONLY=1` registers only the read tools.

## Tools

| Tool                | Kind  | Path                                                                               |
| ------------------- | ----- | ---------------------------------------------------------------------------------- |
| `whoami`            | read  | `auth.getUser`                                                                     |
| `list_groups`       | read  | `groups` (RLS)                                                                     |
| `list_members`      | read  | `group_members` (RLS)                                                              |
| `get_balances`      | read  | `group_balances` (RLS)                                                             |
| `create_group`      | write | `rpc('baaki_create_group')`                                                        |
| `add_expense`       | write | `functions.invoke('expense-write')` → recomputes split, then `baaki_apply_expense` |
| `record_settlement` | write | `rpc('baaki_record_settlement')` — records only                                    |
| `payment_link`      | pure  | builds a `upi://` or `paypal.me` link                                              |

All amounts are **integer minor units** (paise/cents) as strings — money is
never a float.

## Configuration

The server needs the user's Supabase session (get it from a signed-in device or
a login flow):

| Env var                        | Required | Notes                                         |
| ------------------------------ | -------- | --------------------------------------------- |
| `WAVES_SUPABASE_URL`           | yes      | falls back to `EXPO_PUBLIC_SUPABASE_URL`      |
| `WAVES_SUPABASE_ANON_KEY`      | yes      | falls back to `EXPO_PUBLIC_SUPABASE_ANON_KEY` |
| `WAVES_SUPABASE_ACCESS_TOKEN`  | yes      | the user's JWT                                |
| `WAVES_SUPABASE_REFRESH_TOKEN` | no       | supply it so long sessions auto-refresh       |
| `WAVES_MCP_READONLY`           | no       | `1` to expose read tools only                 |

## Run

```bash
pnpm --filter @waves/agent-mcp build
node apps/agent-mcp/dist/index.js
# or, without building:
pnpm --filter @waves/agent-mcp dev
```

MCP host config (stdio):

```json
{
  "mcpServers": {
    "waves-agent": {
      "command": "node",
      "args": ["apps/agent-mcp/dist/index.js"],
      "env": {
        "WAVES_SUPABASE_URL": "https://<ref>.supabase.co",
        "WAVES_SUPABASE_ANON_KEY": "<anon key>",
        "WAVES_SUPABASE_ACCESS_TOKEN": "<user jwt>",
        "WAVES_SUPABASE_REFRESH_TOKEN": "<user refresh token>"
      }
    }
  }
}
```

Inspect it locally:

```bash
npx @modelcontextprotocol/inspector node apps/agent-mcp/dist/index.js
```

## Status

First cut. Not yet wired into CI, and the write tools have been type-checked but
not run end-to-end against a live project. Verify against a throwaway group
before pointing it at anything real.

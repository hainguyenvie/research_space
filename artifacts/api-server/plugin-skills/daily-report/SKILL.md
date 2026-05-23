---
name: daily-report
description: Regenerate the team sprint/daily progress report in the official Google Doc. Use whenever the user asks for a daily/weekly/sprint summary in Vietnamese or English — examples "viết báo cáo hôm nay", "báo cáo ngày", "tóm tắt sprint", "daily report", "/daily". The skill writes into a single all-in-one Google Doc that contains every sprint plan and per-day activity.
user-invocable: true
---

# Daily Report

Generates the team report by querying Linear's current active cycle (issues, project grouping, activity for each day in the cycle, plus all issue comments as activity logs) and writing rich-formatted content into the configured Google Doc.

The report layout is single-doc, newest-on-top:

1. Top: current sprint header + plan section (current cycle membership) + daily sections from cycle start to today, newest first
2. Below: previous sprints with their dailies, preserved untouched

The skill is **idempotent** — calling it multiple times only refreshes the current sprint zone in place. Old sprints are never modified.

## When to invoke

- The user asks for the daily/weekly/sprint report ("báo cáo", "daily", "tóm tắt", etc.)
- The user adds a comment on a Linear issue and asks "thêm vào báo cáo"
- A scheduled cron (06:00 Asia/Ho_Chi_Minh) also auto-triggers this from the api-server process

Do NOT invoke for queries that only need to *read* Linear (e.g. "show me my issues") — answer those directly using the Linear GraphQL API instructions in your system prompt. Only invoke this skill when the user wants the Doc updated.

## How to invoke

The api-server exposes the report endpoint on the same host. Run:

```bash
curl -fsS -X POST http://127.0.0.1:${PORT:-3000}/api/reports/daily
```

`PORT` is in the environment — use it. The response is JSON like:

```json
{
  "ok": true,
  "docId": "1J4QWn_p-...",
  "docUrl": "https://docs.google.com/document/d/.../edit",
  "cycleName": "Drafting Paper for BMVC 2026",
  "cycleNumber": 1,
  "cycleIssueCount": 6,
  "daysRendered": 7,
  "commentsRendered": 3,
  "mode": "refresh-current-sprint"
}
```

Report the `docUrl` back to the user so they can open the Doc. Include a short summary line referencing `cycleNumber`, `cycleIssueCount`, `commentsRendered`, and which `mode` ran:

- `new-doc` — Doc was just created
- `new-sprint` — A new sprint started; old sprint pushed down
- `refresh-current-sprint` — Current sprint zone refreshed in place

## Failure modes

If the endpoint returns `{ "ok": false, "error": "..." }`:

- `Missing env: X` — that env var (e.g. `GOOGLE_REFRESH_TOKEN`) is unset. Tell the user the missing key and that they need to add it to `.env`.
- `Token refresh failed` — Google OAuth refresh token was revoked or expired. The user must re-run `pnpm --filter @workspace/scripts run oauth:google` and update `.env`.
- `Linear: ...` — Linear API issue (auth, rate limit, schema mismatch). Report the message verbatim.
- `No active Linear cycle` — There is no active cycle for any Linear team. The user must start one in Linear before the skill can render a report.
- HTTP error (5xx, connection refused) — The api-server may not be running. Tell the user to check `pnpm --filter @workspace/api-server run dev`.

## What not to do

- Do not try to write to the Doc directly via the Google Docs API yourself — the endpoint handles batched updates, index management, and incremental refresh. Calling it directly is the only correct path.
- Do not invoke the cron endpoint repeatedly in a tight loop — once per user request is enough; it is already idempotent.
- Do not modify the template by editing the Doc manually — your edits in the **current sprint zone** will be overwritten on the next refresh. Edits in old sprint zones are safe.

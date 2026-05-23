/**
 * Daily report generator: queries Linear's active cycle + activity and writes
 * rich-formatted content into the configured Google Doc (incremental update,
 * preserves past sprints).
 *
 * Exported entry point: generateDailyReport()
 *
 * Update mode:
 *   - If doc has no sprint zone, or top sprint zone is for a different cycle
 *     than the current active cycle → prepend new sprint block at top
 *     (preserving everything below).
 *   - If top sprint zone IS the current cycle → delete that zone in-place and
 *     re-render it with fresh data (so newly-added cycle issues, completed
 *     items, and new comments appear).
 *
 * Required env:
 *   LINEAR_API_KEY
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   GOOGLE_DOCS_REPORT_FOLDER_ID
 * Optional env:
 *   GOOGLE_DOCS_REPORT_DOC_NAME (default: "Báo cáo công việc — Resuck Excellent")
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { logger } from "./logger";

const TZ = "Asia/Ho_Chi_Minh";
const DEFAULT_DOC_NAME = "Báo cáo công việc — Resuck Excellent";

// ---------------------------------------------------------------------------
// env — lazy dotenv fallback for CLI runs
// ---------------------------------------------------------------------------
function tryLoadDotenv(): void {
  if (process.env["LINEAR_API_KEY"] && process.env["GOOGLE_CLIENT_ID"]) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../.env"),
    path.resolve(here, "../../../../.env"),
    path.resolve(here, "../../.env"),
    path.resolve(process.cwd(), ".env"),
  ];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf-8");
      for (const line of text.split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m || process.env[m[1]!]) continue;
        let v = m[2]!;
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        process.env[m[1]!] = v;
      }
      return;
    } catch {
      /* try next */
    }
  }
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// date / tz
// ---------------------------------------------------------------------------
const WEEKDAY_VN: Record<string, string> = {
  Sunday: "Chủ Nhật",
  Monday: "Thứ Hai",
  Tuesday: "Thứ Ba",
  Wednesday: "Thứ Tư",
  Thursday: "Thứ Năm",
  Friday: "Thứ Sáu",
  Saturday: "Thứ Bảy",
};

function formatVNDate(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d);
}

function prettyDateVN(vnDate: string): string {
  const d = new Date(`${vnDate}T12:00:00+07:00`);
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
  }).format(d);
  const [yyyy, mm, dd] = vnDate.split("-");
  return `${WEEKDAY_VN[wd] ?? wd}, ${dd}/${mm}/${yyyy}`;
}

function shortDateVN(vnDate: string): string {
  const d = new Date(`${vnDate}T12:00:00+07:00`);
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
  }).format(d);
  const [, mm, dd] = vnDate.split("-");
  return `${dd}/${mm} ${WEEKDAY_VN[wd] ?? wd}`;
}

function eachVNDayDescending(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(`${from}T00:00:00+07:00`);
  const end = new Date(`${to}T00:00:00+07:00`);
  for (let t = end.getTime(); t >= start.getTime(); t -= 86_400_000) {
    days.push(formatVNDate(new Date(t)));
  }
  return days;
}

function daysBetween(startISO: string, endISO: string): number {
  return Math.round(
    (new Date(endISO).getTime() - new Date(startISO).getTime()) / 86_400_000,
  );
}

// ---------------------------------------------------------------------------
// linear
// ---------------------------------------------------------------------------
type LinearIssue = {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  state: { name: string; type: string };
  assignee: { name: string } | null;
  project: { id: string; name: string; url: string } | null;
};

type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  user: { name: string } | null;
  issue: {
    identifier: string;
    title: string;
    url: string;
    state: { name: string };
  };
};

type ActiveCycle = {
  id: string;
  number: number;
  name: string;
  startsAt: string;
  endsAt: string;
  team: { key: string; name: string };
  issues: { nodes: LinearIssue[] };
};

const ACTIVE_CYCLE_QUERY = `
{
  cycles(filter: { isActive: { eq: true } }, first: 1) {
    nodes {
      id number name startsAt endsAt
      team { key name }
      issues(first: 200, orderBy: createdAt) {
        nodes {
          identifier title url priority createdAt completedAt updatedAt
          state { name type }
          assignee { name }
          project { id name url }
        }
      }
    }
  }
}
`;

const ACTIVITY_QUERY = `
query Activity($gte: DateTimeOrDuration!, $lte: DateTimeOrDuration!) {
  updated: issues(filter: { updatedAt: { gte: $gte, lte: $lte } }, first: 200, orderBy: updatedAt) {
    nodes {
      identifier title url priority createdAt completedAt updatedAt
      state { name type } assignee { name } project { id name url }
    }
  }
  completed: issues(filter: { completedAt: { gte: $gte, lte: $lte } }, first: 200, orderBy: updatedAt) {
    nodes {
      identifier title url priority createdAt completedAt updatedAt
      state { name type } assignee { name } project { id name url }
    }
  }
  created: issues(filter: { createdAt: { gte: $gte, lte: $lte } }, first: 200, orderBy: createdAt) {
    nodes {
      identifier title url priority createdAt completedAt updatedAt
      state { name type } assignee { name } project { id name url }
    }
  }
  comments(filter: { createdAt: { gte: $gte, lte: $lte } }, first: 200, orderBy: createdAt) {
    nodes {
      id body createdAt url
      user { name }
      issue { identifier title url state { name } }
    }
  }
}
`;

async function linearQuery<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Linear: ${JSON.stringify(json.errors)}`);
  if (!json.data) throw new Error("Linear: empty data");
  return json.data;
}

// ---------------------------------------------------------------------------
// google docs / drive
// ---------------------------------------------------------------------------
async function getAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Token refresh failed");
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Doc ID cache — persists across process restarts so we never rely solely on
// Drive search index (which can lag up to a minute after creation).
// ---------------------------------------------------------------------------
const DOC_CACHE_DIR = path.join(homedir(), ".openclaw", "report-cache");
const DOC_CACHE_FILE = path.join(DOC_CACHE_DIR, "doc-id.json");

type DocCache = Record<string, string>; // key: `${folderId}::${name}` → docId

function readDocCache(): DocCache {
  try {
    return JSON.parse(readFileSync(DOC_CACHE_FILE, "utf-8")) as DocCache;
  } catch {
    return {};
  }
}

function writeDocCache(cache: DocCache): void {
  try {
    mkdirSync(DOC_CACHE_DIR, { recursive: true });
    writeFileSync(DOC_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (e) {
    logger.warn({ err: e }, "Could not write doc cache");
  }
}

async function verifyDocExists(access: string, docId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${docId}?fields=id,trashed`,
      { headers: { Authorization: `Bearer ${access}` } },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { id?: string; trashed?: boolean };
    return !!data.id && !data.trashed;
  } catch {
    return false;
  }
}

async function findOrCreateDoc(
  access: string,
  folderId: string,
  name: string,
): Promise<{ id: string; isNew: boolean }> {
  const cacheKey = `${folderId}::${name}`;

  // 1. Check local cache first (avoids Drive search index lag)
  const cache = readDocCache();
  const cachedId = cache[cacheKey];
  if (cachedId) {
    const stillExists = await verifyDocExists(access, cachedId);
    if (stillExists) {
      logger.info({ docId: cachedId }, "Doc found in local cache");
      return { id: cachedId, isNew: false };
    }
    logger.warn({ docId: cachedId }, "Cached doc no longer exists, will re-create");
    delete cache[cacheKey];
    writeDocCache(cache);
  }

  // 2. Search Drive (may lag after fresh creation, but good for cross-instance lookup)
  const safe = name.replace(/'/g, "\\'");
  const q =
    `name='${safe}' and '${folderId}' in parents and ` +
    `mimeType='application/vnd.google-apps.document' and trashed=false`;
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${access}` } },
  );
  const search = (await searchRes.json()) as { files?: Array<{ id: string }> };

  if (search.files && search.files.length > 0) {
    const docId = search.files[0]!.id;
    cache[cacheKey] = docId;
    writeDocCache(cache);
    logger.info({ docId }, "Doc found via Drive search");
    return { id: docId, isNew: false };
  }

  // 3. Create doc directly inside the folder via Drive Files API
  //    (avoids the root→folder move step which was silently failing)
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.document",
      parents: [folderId],
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Doc create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { id?: string };
  if (!created.id) throw new Error("Doc create returned no id");

  cache[cacheKey] = created.id;
  writeDocCache(cache);
  logger.info({ docId: created.id, folderId }, "Doc created in folder");
  return { id: created.id, isNew: true };
}

type DocElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    paragraphStyle?: { namedStyleType?: string };
    elements?: Array<{ textRun?: { content?: string } }>;
  };
};

type DocFetched = {
  body: { content: DocElement[] };
};

async function fetchDoc(access: string, docId: string): Promise<DocFetched> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}?fields=body/content(startIndex,endIndex,paragraph(paragraphStyle/namedStyleType,elements/textRun/content))`,
    { headers: { Authorization: `Bearer ${access}` } },
  );
  if (!res.ok) throw new Error(`fetchDoc: ${res.status} ${await res.text()}`);
  return (await res.json()) as DocFetched;
}

async function applyBatchUpdate(
  access: string,
  docId: string,
  requests: unknown[],
): Promise<void> {
  if (requests.length === 0) return;
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    },
  );
  if (!res.ok)
    throw new Error(`batchUpdate failed: ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// doc structure parsing
// ---------------------------------------------------------------------------
type SprintZone = {
  sprintNumber: number;
  startIndex: number;
  endIndex: number; // exclusive — start of next zone or docEnd
};

function paragraphText(elem: DocElement): string {
  const runs = elem.paragraph?.elements ?? [];
  return runs.map((r) => r.textRun?.content ?? "").join("");
}

function parseSprintZones(doc: DocFetched): {
  zones: SprintZone[];
  docEndIndex: number;
} {
  const content = doc.body?.content ?? [];
  const hits: Array<{ startIndex: number; sprintNumber: number }> = [];

  for (const elem of content) {
    const style = elem.paragraph?.paragraphStyle?.namedStyleType;
    if (style !== "HEADING_1") continue;
    const text = paragraphText(elem);
    const m = text.match(/🚀 Sprint #(\d+)/);
    if (m && elem.startIndex !== undefined) {
      hits.push({ startIndex: elem.startIndex, sprintNumber: Number(m[1]) });
    }
  }

  const last = content[content.length - 1];
  const docEnd = last?.endIndex ?? 1;

  const zones: SprintZone[] = [];
  for (let i = 0; i < hits.length; i++) {
    zones.push({
      sprintNumber: hits[i]!.sprintNumber,
      startIndex: hits[i]!.startIndex,
      endIndex: hits[i + 1]?.startIndex ?? docEnd,
    });
  }

  return { zones, docEndIndex: docEnd };
}

// ---------------------------------------------------------------------------
// rich content blocks → batchUpdate requests
// ---------------------------------------------------------------------------
type Run = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  link?: string;
  gray?: boolean;
  mono?: boolean;
};
type BlockType = "h1" | "h2" | "h3" | "p" | "bullet";
type Block = { type: BlockType; runs: Run[] } | { type: "spacer" };

const HEADING_NAMED_STYLE: Record<string, string> = {
  h1: "HEADING_1",
  h2: "HEADING_2",
  h3: "HEADING_3",
  p: "NORMAL_TEXT",
  bullet: "NORMAL_TEXT",
};

function compileBlocks(blocks: Block[], insertAt: number): unknown[] {
  let text = "";
  let pos = insertAt;

  type ParaRange = { start: number; end: number; type: BlockType };
  type RunRange = { start: number; end: number; run: Run };
  const paras: ParaRange[] = [];
  const runs: RunRange[] = [];

  for (const block of blocks) {
    if (block.type === "spacer") {
      const start = pos;
      text += "\n";
      pos += 1;
      paras.push({ start, end: pos, type: "p" });
      continue;
    }
    const start = pos;
    for (const run of block.runs) {
      const runStart = pos;
      text += run.text;
      pos += run.text.length;
      if (run.bold || run.italic || run.link || run.gray || run.mono) {
        runs.push({ start: runStart, end: pos, run });
      }
    }
    text += "\n";
    pos += 1;
    paras.push({ start, end: pos, type: block.type });
  }

  const requests: unknown[] = [];
  requests.push({ insertText: { location: { index: insertAt }, text } });

  for (const p of paras) {
    if (p.type === "bullet") continue;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: p.start, endIndex: p.end },
        paragraphStyle: { namedStyleType: HEADING_NAMED_STYLE[p.type] },
        fields: "namedStyleType",
      },
    });
  }
  for (const p of paras) {
    if (p.type !== "bullet") continue;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: p.start, endIndex: p.end },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
    requests.push({
      createParagraphBullets: {
        range: { startIndex: p.start, endIndex: p.end },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }

  for (const r of runs) {
    const style: Record<string, unknown> = {};
    const fields: string[] = [];
    if (r.run.bold) {
      style["bold"] = true;
      fields.push("bold");
    }
    if (r.run.italic) {
      style["italic"] = true;
      fields.push("italic");
    }
    if (r.run.link) {
      style["link"] = { url: r.run.link };
      fields.push("link");
    }
    if (r.run.gray) {
      style["foregroundColor"] = {
        color: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } },
      };
      fields.push("foregroundColor");
    }
    if (r.run.mono) {
      style["weightedFontFamily"] = { fontFamily: "Roboto Mono" };
      fields.push("weightedFontFamily");
    }
    requests.push({
      updateTextStyle: {
        range: { startIndex: r.start, endIndex: r.end },
        textStyle: style,
        fields: fields.join(","),
      },
    });
  }

  return requests;
}

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------
type DayActivity = {
  completed: LinearIssue[];
  created: LinearIssue[];
  otherUpdated: LinearIssue[];
  comments: LinearComment[];
};

function groupByProject(
  issues: LinearIssue[],
): Map<string, { url: string | null; issues: LinearIssue[] }> {
  const groups = new Map<
    string,
    { url: string | null; issues: LinearIssue[] }
  >();
  for (const i of issues) {
    const key = i.project?.name ?? "Ideas (no project)";
    const url = i.project?.url ?? null;
    if (!groups.has(key)) groups.set(key, { url, issues: [] });
    groups.get(key)!.issues.push(i);
  }
  return groups;
}

function issueBullet(i: LinearIssue, includeProject = false): Run[] {
  const runs: Run[] = [
    { text: i.identifier, link: i.url, bold: true },
    { text: "  " },
    { text: i.title },
  ];
  if (i.assignee) runs.push({ text: ` — ${i.assignee.name}`, italic: true });
  runs.push({ text: ` · ${i.state.name}`, gray: true });
  if (includeProject && i.project) {
    runs.push({ text: `  [${i.project.name}]`, gray: true, italic: true });
  }
  return runs;
}

function buildBlocks(
  cycle: ActiveCycle,
  activityByDay: Map<string, DayActivity>,
  daysDescending: string[],
): Block[] {
  const blocks: Block[] = [];

  const cycleStartVN = formatVNDate(new Date(cycle.startsAt));
  const cycleEndVN = formatVNDate(new Date(new Date(cycle.endsAt).getTime() - 1));
  const durationDays = daysBetween(cycle.startsAt, cycle.endsAt);

  blocks.push({
    type: "h1",
    runs: [{ text: `🚀 Sprint #${cycle.number} — ${cycle.name}` }],
  });
  blocks.push({
    type: "p",
    runs: [
      {
        text: `${shortDateVN(cycleStartVN)} → ${shortDateVN(cycleEndVN)} · ${durationDays} ngày`,
        italic: true,
        gray: true,
      },
    ],
  });
  blocks.push({ type: "spacer" });

  blocks.push({
    type: "h2",
    runs: [
      { text: `📋 Kế hoạch sprint · ${cycle.issues.nodes.length} issues` },
    ],
  });

  const groups = groupByProject(cycle.issues.nodes);
  const orderedGroupNames = [...groups.keys()].sort((a, b) => {
    if (a.includes("Ideas")) return 1;
    if (b.includes("Ideas")) return -1;
    return a.localeCompare(b);
  });

  for (const name of orderedGroupNames) {
    const group = groups.get(name)!;
    blocks.push({ type: "spacer" });
    blocks.push({
      type: "h3",
      runs: [
        group.url
          ? { text: name, link: group.url, bold: true }
          : { text: name, bold: true },
        { text: `  (${group.issues.length})`, gray: true },
      ],
    });
    for (const issue of group.issues) {
      blocks.push({ type: "bullet", runs: issueBullet(issue) });
    }
  }

  blocks.push({ type: "spacer" });
  blocks.push({
    type: "h2",
    runs: [{ text: "━━━ Daily activity ━━━" }],
  });

  for (const day of daysDescending) {
    blocks.push({ type: "spacer" });
    blocks.push({
      type: "h3",
      runs: [{ text: `📅 ${prettyDateVN(day)}` }],
    });

    const a = activityByDay.get(day);
    if (
      !a ||
      a.completed.length +
        a.created.length +
        a.otherUpdated.length +
        a.comments.length ===
        0
    ) {
      blocks.push({
        type: "p",
        runs: [
          {
            text: "(Không có hoạt động trên Linear hôm này)",
            italic: true,
            gray: true,
          },
        ],
      });
      continue;
    }

    if (a.completed.length > 0) {
      blocks.push({
        type: "p",
        runs: [{ text: `✅ Hoàn thành (${a.completed.length})`, bold: true }],
      });
      for (const i of a.completed) {
        blocks.push({ type: "bullet", runs: issueBullet(i, true) });
      }
    }

    if (a.created.length > 0) {
      blocks.push({
        type: "p",
        runs: [{ text: `🆕 Tạo mới (${a.created.length})`, bold: true }],
      });
      for (const i of a.created) {
        blocks.push({ type: "bullet", runs: issueBullet(i, true) });
      }
    }

    if (a.otherUpdated.length > 0) {
      blocks.push({
        type: "p",
        runs: [
          { text: `🔄 Cập nhật khác (${a.otherUpdated.length})`, bold: true },
        ],
      });
      for (const i of a.otherUpdated) {
        blocks.push({ type: "bullet", runs: issueBullet(i, true) });
      }
    }

    if (a.comments.length > 0) {
      blocks.push({
        type: "p",
        runs: [
          {
            text: `💬 Logs / Comments — giờ VN (${a.comments.length})`,
            bold: true,
          },
        ],
      });
      const byIssue = new Map<string, LinearComment[]>();
      for (const c of a.comments) {
        const k = c.issue.identifier;
        if (!byIssue.has(k)) byIssue.set(k, []);
        byIssue.get(k)!.push(c);
      }
      for (const [, cs] of byIssue) {
        const first = cs[0]!;
        blocks.push({
          type: "bullet",
          runs: [
            { text: first.issue.identifier, link: first.issue.url, bold: true },
            { text: "  " + first.issue.title },
            { text: ` · ${first.issue.state.name}`, gray: true },
          ],
        });
        for (const c of cs) {
          const author = c.user?.name ?? "(unknown)";
          const time = new Intl.DateTimeFormat("en-GB", {
            timeZone: TZ,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(c.createdAt));
          const body = c.body.trim().replace(/\s+/g, " ");
          const snippet = body.length > 280 ? body.slice(0, 280) + "…" : body;
          blocks.push({
            type: "bullet",
            runs: [
              { text: `${time}  `, gray: true, mono: true },
              { text: `${author}: `, italic: true },
              { text: snippet },
              { text: "  ↗", link: c.url, gray: true },
            ],
          });
        }
      }
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------
export type ReportResult = {
  docId: string;
  docUrl: string;
  cycleName: string;
  cycleNumber: number;
  cycleIssueCount: number;
  daysRendered: number;
  commentsRendered: number;
  mode: "new-doc" | "new-sprint" | "refresh-current-sprint";
};

export async function generateDailyReport(): Promise<ReportResult> {
  tryLoadDotenv();

  const LINEAR_KEY = requiredEnv("LINEAR_API_KEY");
  const G_CLIENT_ID = requiredEnv("GOOGLE_CLIENT_ID");
  const G_CLIENT_SECRET = requiredEnv("GOOGLE_CLIENT_SECRET");
  const G_REFRESH = requiredEnv("GOOGLE_REFRESH_TOKEN");
  const G_FOLDER = requiredEnv("GOOGLE_DOCS_REPORT_FOLDER_ID");
  const DOC_NAME = (process.env["GOOGLE_DOCS_REPORT_DOC_NAME"] ?? DEFAULT_DOC_NAME)
    .replace(/^["']|["']$/g, "").trim();

  // 1. Linear
  const cycleData = await linearQuery<{ cycles: { nodes: ActiveCycle[] } }>(
    LINEAR_KEY,
    ACTIVE_CYCLE_QUERY,
  );
  const cycle = cycleData.cycles.nodes[0];
  if (!cycle) throw new Error("No active Linear cycle");

  const now = new Date();
  const rangeEnd = new Date(cycle.endsAt) < now ? new Date(cycle.endsAt) : now;
  const activity = await linearQuery<{
    updated: { nodes: LinearIssue[] };
    completed: { nodes: LinearIssue[] };
    created: { nodes: LinearIssue[] };
    comments: { nodes: LinearComment[] };
  }>(LINEAR_KEY, ACTIVITY_QUERY, {
    gte: cycle.startsAt,
    lte: rangeEnd.toISOString(),
  });

  // 2. Bucket by VN day
  const fromVN = formatVNDate(new Date(cycle.startsAt));
  const toVN = formatVNDate(rangeEnd);
  const daysDescending = eachVNDayDescending(fromVN, toVN);

  const byDay = new Map<string, DayActivity>();
  for (const d of daysDescending)
    byDay.set(d, { completed: [], created: [], otherUpdated: [], comments: [] });

  const bucketDay = (ts: string) => formatVNDate(new Date(ts));

  for (const i of activity.completed.nodes) {
    if (!i.completedAt) continue;
    byDay.get(bucketDay(i.completedAt))?.completed.push(i);
  }
  const completedKeys = new Set(
    activity.completed.nodes.map(
      (i) => `${bucketDay(i.completedAt!)}::${i.identifier}`,
    ),
  );
  for (const i of activity.created.nodes) {
    byDay.get(bucketDay(i.createdAt))?.created.push(i);
  }
  const createdKeys = new Set(
    activity.created.nodes.map(
      (i) => `${bucketDay(i.createdAt)}::${i.identifier}`,
    ),
  );
  for (const i of activity.updated.nodes) {
    const d = bucketDay(i.updatedAt);
    const k = `${d}::${i.identifier}`;
    if (completedKeys.has(k) || createdKeys.has(k)) continue;
    byDay.get(d)?.otherUpdated.push(i);
  }
  for (const c of activity.comments.nodes) {
    byDay.get(bucketDay(c.createdAt))?.comments.push(c);
  }

  // 3. Render blocks
  const blocks = buildBlocks(cycle, byDay, daysDescending);

  // 4. Find or create doc
  const access = await getAccessToken({
    clientId: G_CLIENT_ID,
    clientSecret: G_CLIENT_SECRET,
    refreshToken: G_REFRESH,
  });
  const doc = await findOrCreateDoc(access, G_FOLDER, DOC_NAME);

  // 5. Decide mode + apply
  let mode: ReportResult["mode"];
  const requests: unknown[] = [];

  if (doc.isNew) {
    mode = "new-doc";
    requests.push(...compileBlocks(blocks, 1));
  } else {
    const fetched = await fetchDoc(access, doc.id);
    const { zones, docEndIndex } = parseSprintZones(fetched);
    const top = zones[0];

    if (!top || top.sprintNumber !== cycle.number) {
      mode = "new-sprint";
      requests.push(...compileBlocks(blocks, 1));
    } else {
      mode = "refresh-current-sprint";
      // Delete the top zone (preserve everything below — older sprints)
      const deleteEnd = Math.min(top.endIndex, docEndIndex - 1);
      if (deleteEnd > top.startIndex) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: top.startIndex, endIndex: deleteEnd },
          },
        });
      }
      requests.push(...compileBlocks(blocks, top.startIndex));
    }
  }

  await applyBatchUpdate(access, doc.id, requests);

  return {
    docId: doc.id,
    docUrl: `https://docs.google.com/document/d/${doc.id}/edit`,
    cycleName: cycle.name,
    cycleNumber: cycle.number,
    cycleIssueCount: cycle.issues.nodes.length,
    daysRendered: daysDescending.length,
    commentsRendered: activity.comments.nodes.length,
    mode,
  };
}

// ---------------------------------------------------------------------------
// CLI auto-invoke when run as a script (tsx ./daily-report.ts)
// ---------------------------------------------------------------------------
const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isMainModule) {
  generateDailyReport()
    .then((r) => {
      logger.info(r, "Daily report rendered");
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err) => {
      logger.error({ err }, "Daily report failed");
      console.error(err);
      process.exit(1);
    });
}

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { logger } from "./logger";

const GATEWAY_PORT = 18789;

// Gateway state directory (openclaw runtime data: session spools, logs, etc.)
const OPENCLAW_HOME = path.join(homedir(), ".openclaw");

// Runtime config written at startup from env vars.
// Written alongside the compiled bundle in dist/ (gitignored) so secrets
// never enter version control. Uses import.meta.url so the path is correct
// regardless of what process.cwd() is (dev vs production differ).
const CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "openclaw-runtime.json",
);

let gatewayProcess: ChildProcess | null = null;
let gatewayReady = false;

/**
 * Returns the gateway auth token.
 * Uses OPENCLAW_GATEWAY_TOKEN if set, otherwise generates a random token
 * for the lifetime of this process. The token is only used for internal
 * communication between Express and the gateway on port 18789.
 */
let _runtimeToken: string | null = null;
export function getGatewayToken(): string {
  if (!_runtimeToken) {
    _runtimeToken = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? randomUUID();
  }
  return _runtimeToken;
}

function resolveOpenclawMjs(): string {
  try {
    const req = createRequire(import.meta.url);
    // resolve the package main entry (dist/index.js) then walk up to package root
    const main = req.resolve("openclaw");
    // main is like .../openclaw/dist/index.js — go up two levels to reach package root
    const packageRoot = path.dirname(path.dirname(main));
    return path.join(packageRoot, "openclaw.mjs");
  } catch {
    // Fallback to known pnpm virtual-store path
    return "/home/runner/workspace/node_modules/.pnpm/openclaw@2026.5.20/node_modules/openclaw/openclaw.mjs";
  }
}

function buildConfig(token: string): object {
  const deepseekKey = process.env["DEEPSEEK_API_KEY"];
  const telegramToken = process.env["TELEGRAM_BOT_TOKEN"];
  const zaloToken = process.env["ZALO_BOT_TOKEN"];
  const linearApiKey = process.env["LINEAR_API_KEY"];

  if (!deepseekKey) {
    logger.warn(
      "DEEPSEEK_API_KEY not set — OpenClaw gateway will start without DeepSeek provider",
    );
  }
  if (!telegramToken) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram channel will be disabled");
  }
  if (!zaloToken) {
    logger.warn("ZALO_BOT_TOKEN not set — Zalo channel will be disabled");
  }

  return {
    meta: {
      lastTouchedVersion: "2026.5.20",
    },
    gateway: {
      port: GATEWAY_PORT,
      mode: "local",
      bind: "lan",
      auth: {
        mode: "token",
        token,
      },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "deepseek/deepseek-v4-flash",
          fallbacks: ["deepseek/deepseek-chat"],
        },
        ...(linearApiKey
          ? {
              systemPromptOverride: `You have access to Linear project management via its GraphQL API.

The LINEAR_API_KEY is available as an environment variable. Use it like this in bash:

curl -s -X POST https://api.linear.app/graphql \\
  -H "Content-Type: application/json" \\
  -H "Authorization: $LINEAR_API_KEY" \\
  -d '{"query": "{ viewer { name } }"}'

When the user asks about tasks, issues, projects, teams, or anything related to Linear, use the bash tool to query the Linear GraphQL API. Always use $LINEAR_API_KEY as the Authorization header value.

Common queries:
- My profile: { viewer { name email } }
- My assigned issues: { viewer { assignedIssues { nodes { title state { name } priority url } } } }
- All teams: { teams { nodes { id name } } }
- All issues (recent): { issues(first: 20, orderBy: updatedAt) { nodes { title state { name } assignee { name } priority dueDate url } } }
- In-progress issues: { issues(filter: { state: { type: { eq: "started" } } }) { nodes { title assignee { name } team { name } url } } }
- Issues by team: { team(id: "TEAM_ID") { issues { nodes { title state { name } assignee { name } priority dueDate url } } } }

Always present results in a clean, readable format. If a query fails, show the error and try an alternative approach.`,
            }
          : {}),
      },
    },
    channels: {
      ...(telegramToken
        ? {
            telegram: {
              enabled: true,
              botToken: telegramToken,
              dmPolicy: "open",
              allowFrom: ["*"],
              streaming: {
                mode: "partial",
              },
            },
          }
        : {}),
      ...(zaloToken
        ? {
            zalo: {
              enabled: true,
              botToken: zaloToken,
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          }
        : {}),
    },
  };
}

export async function startGateway(): Promise<void> {
  const token = getGatewayToken();

  try {
    await mkdir(OPENCLAW_HOME, { recursive: true });
    const config = buildConfig(token);
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    logger.info({ configPath: CONFIG_PATH }, "OpenClaw config written");
  } catch (err) {
    logger.error({ err }, "Failed to write OpenClaw config");
    return;
  }

  const openclawMjs = resolveOpenclawMjs();
  logger.info({ openclawMjs, port: GATEWAY_PORT }, "Starting OpenClaw gateway");

  gatewayProcess = spawn(
    "node",
    [
      openclawMjs,
      "gateway",
      "--port",
      String(GATEWAY_PORT),
      "--allow-unconfigured",
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_HOME,
        OPENCLAW_CONFIG_PATH: CONFIG_PATH,
        OPENCLAW_GATEWAY_TOKEN: token,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  gatewayProcess.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) logger.info({ source: "openclaw-gateway" }, text);
    // Only trust "http server listening" or "[gateway] ready" — NOT "started"
    // which fires too early (e.g. "[health-monitor] started" before port opens).
    if (
      (text.includes("listening") && text.includes("http server")) ||
      text.match(/\[gateway\]\s+ready/)
    ) {
      if (!gatewayReady) {
        gatewayReady = true;
        logger.info("OpenClaw gateway ready (stdout confirmed)");
      }
    }
  });

  gatewayProcess.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) logger.warn({ source: "openclaw-gateway" }, text);
  });

  gatewayProcess.on("error", (err) => {
    logger.error({ err }, "OpenClaw gateway process error");
    gatewayReady = false;
  });

  gatewayProcess.on("exit", (code, signal) => {
    logger.warn({ code, signal }, "OpenClaw gateway exited");
    gatewayReady = false;
    gatewayProcess = null;
  });

  // Poll the TCP port until the gateway is actually accepting connections.
  // Production cold-start can take 60+ seconds; polling avoids false positives.
  pollGatewayReady();
}

async function pollGatewayReady(
  intervalMs = 3000,
  maxAttempts = 600, // 20 minutes total — production cold-start can take 7-11 min
  attempt = 0,
): Promise<void> {
  if (!gatewayProcess || gatewayProcess.killed) return;
  if (attempt >= maxAttempts) {
    logger.warn("OpenClaw gateway did not become ready within timeout");
    return;
  }

  // Probe via real HTTP request — TCP-only is unreliable since the port can
  // bind before the HTTP server is ready to accept requests.
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    // Any HTTP response (even 401/404) means the server is up
    if (res.status > 0 && !gatewayReady) {
      gatewayReady = true;
      logger.info({ attempt, status: res.status }, "OpenClaw gateway ready (HTTP probe confirmed)");
    }
  } catch {
    // Still not ready — retry
    setTimeout(() => pollGatewayReady(intervalMs, maxAttempts, attempt + 1), intervalMs);
  }
}

export function markGatewayNotReady(): void {
  if (gatewayReady) {
    gatewayReady = false;
    logger.warn("OpenClaw gateway marked not-ready (connection failed)");
    // Resume polling to detect when it recovers
    setTimeout(() => pollGatewayReady(), 3000);
  }
}

export function stopGateway(): void {
  if (gatewayProcess) {
    logger.info("Stopping OpenClaw gateway");
    gatewayProcess.kill("SIGTERM");
    gatewayProcess = null;
    gatewayReady = false;
  }
}

export function isGatewayReady(): boolean {
  return gatewayReady;
}

export function getGatewayPort(): number {
  return GATEWAY_PORT;
}

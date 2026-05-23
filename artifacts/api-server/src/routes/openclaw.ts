import { Router, type IRouter, type Request, type Response } from "express";
import {
  isGatewayReady,
  getGatewayPort,
  getGatewayToken,
  markGatewayNotReady,
} from "../lib/openclaw-gateway";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function gatewayBaseUrl(): string {
  return `http://127.0.0.1:${getGatewayPort()}`;
}

function gatewayAuthHeader(): string {
  return `Bearer ${getGatewayToken()}`;
}

// ---------------------------------------------------------------------------
// Health endpoint — gateway + provider status
// ---------------------------------------------------------------------------
router.get("/openclaw/health", (_req: Request, res: Response) => {
  const hasDeepSeek = !!process.env["DEEPSEEK_API_KEY"];
  const hasTelegram = !!process.env["TELEGRAM_BOT_TOKEN"];
  const status = hasDeepSeek ? "ok" : "degraded";

  res.json({
    status,
    gateway: {
      ready: isGatewayReady(),
      port: getGatewayPort(),
    },
    providers: {
      deepseek: hasDeepSeek,
    },
    channels: {
      telegram: hasTelegram,
    },
  });
});

// ---------------------------------------------------------------------------
// Chat endpoint — proxied through the OpenClaw gateway /v1/chat/completions
// The gateway is the single path for all AI turns so that Telegram and web
// chat share the same agent session, memory, and routing config.
// ---------------------------------------------------------------------------
router.post("/openclaw/chat", async (req: Request, res: Response) => {
  const { message, history, sessionKey } = req.body as {
    message?: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    sessionKey?: string;
  };

  if (!message || typeof message !== "string" || message.trim() === "") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (!isGatewayReady()) {
    res.status(503).json({ error: "OpenClaw gateway is not ready yet. Please wait a few seconds and retry." });
    return;
  }

  const messages = [
    ...(Array.isArray(history)
      ? history.map((m) => ({ role: m.role, content: m.content }))
      : []),
    { role: "user", content: message.trim() },
  ];

  const requestBody: Record<string, unknown> = {
    model: "openclaw",
    messages,
  };

  // Pass a stable session key so chat history is shared within a browser
  // session. Falls back to a per-request transient session when omitted.
  if (sessionKey && typeof sessionKey === "string") {
    requestBody.user = sessionKey;
  }

  try {
    const response = await fetch(
      `${gatewayBaseUrl()}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: gatewayAuthHeader(),
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, body: errorText },
        "Gateway chat error",
      );
      res.status(502).json({
        error: `Gateway returned ${response.status}: ${errorText.slice(0, 200)}`,
      });
      return;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: unknown;
    };

    const reply = data.choices?.[0]?.message?.content ?? "";
    logger.info(
      { messageLength: message.length, replyLength: reply.length },
      "OpenClaw chat response",
    );

    res.json({
      reply,
      model: data.model ?? "openclaw",
      usage: data.usage,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "OpenClaw chat fetch error");
    // If connection refused, the gateway is not actually ready — reset flag so
    // the UI goes back to "Starting up..." and polling resumes.
    if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      markGatewayNotReady();
      res.status(503).json({ error: "OpenClaw gateway is not ready yet. Please wait and retry." });
      return;
    }
    res.status(502).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Generic proxy: /api/openclaw/* → gateway at port 18789
// This allows the web UI (and future clients) to reach any gateway endpoint
// directly without knowing the internal port.
// Excluded: /openclaw/health and /openclaw/chat (handled above)
// ---------------------------------------------------------------------------
router.all(
  /^\/openclaw\/(?!health$|chat$).*/,
  async (req: Request, res: Response) => {
    // Strip the leading /openclaw prefix when forwarding
    const upstreamPath = req.path.replace(/^\/openclaw/, "") || "/";
    const url = `${gatewayBaseUrl()}${upstreamPath}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`;

    const headers: Record<string, string> = {
      Authorization: gatewayAuthHeader(),
      "Content-Type":
        typeof req.headers["content-type"] === "string"
          ? req.headers["content-type"]
          : "application/json",
    };

    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body:
          req.method !== "GET" && req.method !== "HEAD"
            ? JSON.stringify(req.body)
            : undefined,
        signal: AbortSignal.timeout(30_000),
      });

      // Forward status and content-type
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);

      const body = await upstream.text();
      res.send(body);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Proxy error";
      logger.error({ err, url }, "OpenClaw gateway proxy error");
      res.status(502).json({ error: msg });
    }
  },
);

export default router;

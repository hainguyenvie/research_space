import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ENV_PATH = join(import.meta.dirname, "../../.env");

function loadEnv(): void {
  try {
    const text = readFileSync(ENV_PATH, "utf-8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  } catch (err) {
    console.error(`Could not read ${ENV_PATH}:`, err);
    process.exit(1);
  }
}

loadEnv();

const CLIENT_ID = process.env["GOOGLE_CLIENT_ID"];
const CLIENT_SECRET = process.env["GOOGLE_CLIENT_SECRET"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  // Full drive scope is needed because the report doc lives in a
  // pre-existing user-owned folder. `drive.file` cannot reference folders
  // the app didn't create itself.
  "https://www.googleapis.com/auth/drive",
];
const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname !== "/oauth2callback") {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  if (url.searchParams.get("state") !== state) {
    res.statusCode = 400;
    res.end("State mismatch — possible CSRF, aborting");
    process.exit(1);
  }

  const err = url.searchParams.get("error");
  if (err) {
    res.statusCode = 400;
    res.end(`OAuth error: ${err}`);
    console.error(`OAuth error: ${err}`);
    process.exit(1);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.statusCode = 400;
    res.end("Missing code");
    process.exit(1);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const data = (await tokenRes.json()) as {
      refresh_token?: string;
      access_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || !data.refresh_token) {
      res.statusCode = 500;
      res.end(`Token exchange failed: ${JSON.stringify(data)}`);
      console.error("Token exchange failed:", data);
      process.exit(1);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<html><body style='font-family:sans-serif;padding:2rem'>" +
        "<h1>✅ Authorized</h1>" +
        "<p>Refresh token đã được in ra terminal. Bạn có thể đóng tab này.</p>" +
        "</body></html>",
    );

    console.log("\n=== SUCCESS ===");
    console.log("Scopes granted:", data.scope);
    console.log("\nThêm dòng sau vào .env (thay thế dòng GOOGLE_REFRESH_TOKEN= hiện tại):\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
    console.log("");

    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 500);
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nListening on ${REDIRECT_URI}`);
  console.log("\nMở URL sau trong trình duyệt (tự động mở nếu được):\n");
  console.log(authUrl.toString());
  console.log("");

  // Best-effort open browser
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(opener, [authUrl.toString()], { stdio: "ignore", detached: true }).on(
    "error",
    () => {
      /* ignore — user can copy URL manually */
    },
  );
});

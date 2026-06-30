/**
 * OAuth login + credential storage for Freebuff/Codebuff.
 *
 * Codebuff uses NextAuth (GitHub/Google OAuth).
 * Auth flow:
 *   1. Open browser to codebuff sign-in
 *   2. User signs in via GitHub/Google
 *   3. Capture session token from callback redirect
 */

import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface OAuthLoginResult {
  apiKey: string;
  name: string;
  apiServerUrl: string;
  backendUrl: string;
}

export interface FreebuffRegion {
  website: string;
  backendUrl: string;
}

export const DEFAULT_REGION: FreebuffRegion = {
  website: "https://www.codebuff.com",
  backendUrl: "https://manicode-backend.onrender.com",
};

export interface PersistedCredentials extends OAuthLoginResult {
  issuedAt: string;
}

// ----------------------------------------------------------------------------
// Credential Storage
// ----------------------------------------------------------------------------

const APP_DIR_NAME = "opencode-freebuff-auth";
const CREDS_FILENAME = "credentials.json";

export function getCredentialsDir(): string {
  return path.join(os.homedir(), ".config", APP_DIR_NAME);
}

export function getCredentialsPath(): string {
  return path.join(getCredentialsDir(), CREDS_FILENAME);
}

function ensureDir(): void {
  fs.mkdirSync(getCredentialsDir(), { recursive: true, mode: 0o700 });
}

export function loadCredentials(): PersistedCredentials | null {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as PersistedCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: PersistedCredentials): void {
  ensureDir();
  fs.writeFileSync(getCredentialsPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): boolean {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// ----------------------------------------------------------------------------
// Auth flow — loopback callback server
//
// 1. Start local HTTP server on random port
// 2. Open browser to codebuff sign-in with callbackUrl=http://127.0.0.1:PORT
// 3. User signs in via GitHub/Google on codebuff.com
// 4. NextAuth redirects to callbackUrl with session cookie
// 5. We capture the cookie and extract the token
// ----------------------------------------------------------------------------

export async function runLoginLoopback(
  region: FreebuffRegion,
  onUrl: (url: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const server = await startCallbackServer();
  const callbackUrl = `http://127.0.0.1:${server.port}/callback`;
  const loginUrl = `${region.website}/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  const callbackPromise = server.waitForToken(signal);

  onUrl(loginUrl);
  await openBrowser(loginUrl).catch(() => {});

  const token = await withTimeout(callbackPromise, 5 * 60 * 1000, "Sign-in timed out (5 min).");
  server.close();

  if (!token) throw new Error("No session token received.");
  return token;
}

// ----------------------------------------------------------------------------
// Callback server — captures session cookie from NextAuth redirect
// ----------------------------------------------------------------------------

interface CallbackServer {
  port: number;
  close: () => void;
  waitForToken: (signal?: AbortSignal) => Promise<string>;
}

function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let tokenResolve: ((token: string) => void) | null = null;
    let tokenReject: ((err: Error) => void) | null = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // Extract session cookie from request headers
      const cookies = req.headers.cookie ?? "";
      const sessionMatch = cookies.match(/next-auth\.session-token=([^;]+)/);
      const secureSessionMatch = cookies.match(/__Secure-next-auth\.session-token=([^;]+)/);
      const token = sessionMatch?.[1] ?? secureSessionMatch?.[1];

      if (token) {
        // Success — send response and resolve
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>Signed in to Codebuff!</h1><p>You can close this tab.</p></body></html>");
        tokenResolve?.(token);
        return;
      }

      // Also check URL params (some auth flows put token in URL)
      const urlToken = url.searchParams.get("token")
        ?? url.searchParams.get("authToken")
        ?? url.searchParams.get("session_token");

      if (urlToken) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>Signed in to Codebuff!</h1><p>You can close this tab.</p></body></html>");
        tokenResolve?.(urlToken);
        return;
      }

      // No token yet — might be a redirect or intermediate request
      // Send a page that reads document.cookie and sends it back
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body>
<p>Waiting for sign-in...</p>
<script>
// If we're on the callback page with cookies, send them
if (document.cookie) {
  fetch("/callback?cookies=" + encodeURIComponent(document.cookie));
}
</script>
</body></html>`);
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind callback server"));
        return;
      }

      resolve({
        port: addr.port,
        close: () => { try { server.close(); } catch {} },
        waitForToken: (signal?: AbortSignal) =>
          new Promise<string>((res, rej) => {
            tokenResolve = res;
            tokenReject = rej;
            signal?.addEventListener("abort", () => {
              rej(new Error("Sign-in cancelled."));
            }, { once: true });
          }),
      });
    });
  });
}

// Also try to get the token by polling the codebuff API with the session
export async function exchangeSessionForApiKey(
  sessionToken: string,
  region: FreebuffRegion,
): Promise<OAuthLoginResult> {
  // Try the status endpoint with the session cookie
  const response = await fetch(`${region.website}/api/auth/cli/status`, {
    method: "GET",
    headers: {
      "Cookie": `next-auth.session-token=${sessionToken}`,
      "Authorization": `Bearer ${sessionToken}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    // If CLI status doesn't work, try using the session token directly as API key
    // Many services accept the session token as a bearer token
    return {
      apiKey: sessionToken,
      name: "freebuff-user",
      apiServerUrl: region.website,
      backendUrl: region.backendUrl,
    };
  }

  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const token = parsed.token
      ?? parsed.authToken
      ?? parsed.session_token
      ?? parsed.access_token
      ?? sessionToken;
    return {
      apiKey: String(token),
      name: "freebuff-user",
      apiServerUrl: region.website,
      backendUrl: region.backendUrl,
    };
  } catch {
    return {
      apiKey: sessionToken,
      name: "freebuff-user",
      apiServerUrl: region.website,
      backendUrl: region.backendUrl,
    };
  }
}

// ----------------------------------------------------------------------------
// Browser opener
// ----------------------------------------------------------------------------

async function openBrowser(url: string): Promise<void> {
  const cmds = process.platform === "darwin"
    ? [{ cmd: "open", args: [url] }]
    : process.platform === "win32"
      ? [{ cmd: "cmd", args: ["/c", "start", '""', url] }]
      : [{ cmd: "xdg-open", args: [url] }, { cmd: "sensible-browser", args: [url] }];

  for (const c of cmds) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(c.cmd, c.args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => { child.unref(); resolve(true); });
    });
    if (ok) return;
  }
  throw new Error(`Unable to open browser. Open this URL manually:\n  ${url}`);
}

// ----------------------------------------------------------------------------
// Timeout helper
// ----------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

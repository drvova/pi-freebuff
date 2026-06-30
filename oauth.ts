/**
 * OAuth login + credential storage for Freebuff/Codebuff.
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
  oauthClientId: string;
}

export const DEFAULT_REGION: FreebuffRegion = {
  website: "https://www.codebuff.com",
  backendUrl: "https://manicode-backend.onrender.com",
  oauthClientId: "codebuff-cli",
};

export interface PersistedCredentials extends OAuthLoginResult {
  issuedAt: string;
  oauthClientId: string;
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
  const dir = getCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadCredentials(): PersistedCredentials | null {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    typeof parsed.apiKey !== "string" || !parsed.apiKey ||
    typeof parsed.name !== "string" || !parsed.name ||
    typeof parsed.apiServerUrl !== "string" || !parsed.apiServerUrl
  ) {
    throw new Error(`Credentials file at ${p} is missing required fields.`);
  }
  return parsed as unknown as PersistedCredentials;
}

export function saveCredentials(creds: PersistedCredentials): void {
  ensureDir();
  const p = getCredentialsPath();
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): boolean {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// ----------------------------------------------------------------------------
// RegisterUser (Codebuff CLI login)
// ----------------------------------------------------------------------------

export class FreebuffRegistrationError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FreebuffRegistrationError";
    this.status = status;
  }
}

export async function registerUser(
  authToken: string,
  region: FreebuffRegion,
  abortSignal?: AbortSignal,
): Promise<OAuthLoginResult> {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const signals: AbortSignal[] = [timeoutSignal];
  if (abortSignal) signals.push(abortSignal);

  const builtin = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  const combinedSignal = typeof builtin === "function" ? builtin(signals) : timeoutSignal;

  const response = await fetch(`${region.website}/api/auth/cli/status`, {
    method: "GET",
    headers: {
      "Cookie": `next-auth.session-token=${authToken}`,
      "Authorization": `Bearer ${authToken}`,
    },
    signal: combinedSignal,
  });
  const text = await response.text();

  if (!response.ok) {
    throw new FreebuffRegistrationError(
      `Auth status check failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
      response.status,
    );
  }

  const parsed = JSON.parse(text) as Record<string, unknown>;
  const token = parsed.authToken ?? parsed.token ?? authToken;

  if (typeof token !== "string" || !token) {
    throw new FreebuffRegistrationError("Auth status returned 200 but no token found", response.status);
  }

  return {
    apiKey: token,
    name: "freebuff-user",
    apiServerUrl: region.website,
    backendUrl: region.backendUrl,
  };
}

// ----------------------------------------------------------------------------
// Login flow — loopback callback
// ----------------------------------------------------------------------------

export async function runLoginLoopback(
  region: FreebuffRegion,
  onUrl: (url: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const state = crypto.randomUUID();
  const server = await startCallbackServer();
  const callbackUrl = `http://127.0.0.1:${server.port}/auth`;
  const loginUrl = `${region.website}/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  const callbackPromise = server.callback(state);
  callbackPromise.catch(() => {});

  onUrl(loginUrl);
  await openBrowser(loginUrl).catch(() => {});

  const callback = await waitWithTimeout(callbackPromise, 5 * 60 * 1000, signal, "Sign-in timed out.");

  if (!callback.token) throw new Error("OAuth callback delivered an empty token.");
  server.close();
  return callback.token;
}

interface CallbackServer {
  port: number;
  close: () => void;
  callback: (expectedState: string) => Promise<CallbackResult>;
}

interface CallbackResult {
  token: string;
  state: string;
}

function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let captured: { token: string; state: string } | null = null;
    const waiters: Array<{ state: string; resolve: (r: CallbackResult) => void; reject: (e: Error) => void }> = [];

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const tokenParam = url.searchParams.get("token") ?? url.searchParams.get("authToken");
      const stateParam = url.searchParams.get("state") ?? "";

      if (!tokenParam) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><p>No token in URL. Close this tab.</p></body></html>");
        return;
      }

      const matchedWaiter = waiters.find((w) => w.state === stateParam);
      if (!matchedWaiter) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><p>Unexpected callback.</p></body></html>");
        return;
      }

      captured = { token: tokenParam, state: stateParam };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<html><body><h1>Signed in</h1><p>You can close this tab.</p></body></html>");

      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.state === captured.state) {
          w.resolve(captured);
          waiters.splice(i, 1);
        }
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => server.close(),
        callback: (expectedState: string) =>
          new Promise((res, rej) => {
            if (captured) res({ token: captured.token, state: captured.state });
            else waiters.push({ state: expectedState, resolve: res, reject: rej });
          }),
      });
    });
  });
}

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

function waitWithTimeout<T>(p: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new Error("Sign-in cancelled.")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(msg)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}

/**
 * OAuth login + credential storage for Freebuff/Codebuff.
 *
 * Codebuff CLI auth flow:
 *   1. POST /api/auth/cli/code { fingerprintId, referralCode } → device code + URL
 *   2. Open browser to verification URL
 *   3. Poll GET /api/auth/cli/status?fingerprintId=...&fingerprintHash=...&expiresAt=...
 *   4. Receive authToken → use as next-auth.session-token cookie
 */

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
  fingerprintId: string;
  fingerprintHash: string;
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
// Device fingerprint
//
// Codebuff generates a unique device fingerprint from hostname + username +
// platform, then hashes it with SHA-256 for the status poll.
// ----------------------------------------------------------------------------

function getFingerprintInfo(): Record<string, string> {
  return {
    hostname: os.hostname(),
    username: os.userInfo().username,
    platform: os.platform(),
    arch: os.arch(),
  };
}

function getFingerprintId(): string {
  const info = getFingerprintInfo();
  const fingerprintString = JSON.stringify(info);
  const hash = crypto.createHash("sha256").update(fingerprintString).digest();
  const base64 = hash.toString("base64url");
  const suffix = crypto.randomBytes(6).toString("base64url").substring(0, 8);
  return `${base64}-${suffix}`;
}

// ----------------------------------------------------------------------------
// Device code flow
// ----------------------------------------------------------------------------

interface DeviceCodeResponse {
  fingerprintId: string;
  fingerprintHash: string;
  loginUrl: string;
  expiresAt: number;
}

export async function runLoginLoopback(
  region: FreebuffRegion,
  onUrl: (url: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const fingerprintId = getFingerprintId();
  const fingerprintString = getFingerprintString();
  const fingerprintHash = getFingerprintHash(fingerprintString);

  // Step 1: Request device code
  console.error("[freebuff] requesting device code...");
  const codeRes = await fetch(`${region.website}/api/auth/cli/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprintId }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!codeRes.ok) {
    const text = await codeRes.text();
    console.error(`[freebuff] device code request failed: ${codeRes.status} ${text.slice(0, 200)}`);
    throw new Error(`Device code request failed: HTTP ${codeRes.status}`);
  }

  const codeData: DeviceCodeResponse = await codeRes.json();
  console.error("[freebuff] device code response:", JSON.stringify(codeData).slice(0, 200));

  const verificationUrl = codeData.loginUrl;
  const fpHash = codeData.fingerprintHash;
  const expiresAt = codeData.expiresAt;

  // Step 2: Open browser
  onUrl(verificationUrl);
  await openBrowser(verificationUrl).catch(() => {});

  // Step 3: Poll for completion
  const deadline = Date.now() + 10 * 60 * 1000;

  console.error(`[freebuff] waiting for sign-in at: ${verificationUrl}`);
  console.error(`[freebuff] polling every 5s...`);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Sign-in cancelled.");

    await sleep(5000);

    const statusUrl = `${region.website}/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(fpHash)}&expiresAt=${expiresAt}`;

    try {
      const statusRes = await fetch(statusUrl, { signal: AbortSignal.timeout(10_000) });

      // Check Set-Cookie headers for session token
      const setCookies = statusRes.headers.getSetCookie?.() ?? [];
      for (const cookie of setCookies) {
        const match = cookie.match(/next-auth\.session-token=([^;]+)/);
        const secureMatch = cookie.match(/__Secure-next-auth\.session-token=([^;]+)/);
        const token = match?.[1] ?? secureMatch?.[1];
        if (token) {
          console.error("[freebuff] sign-in complete (from cookie)!");
          return token;
        }
      }

      if (statusRes.ok) {
        const statusData = await statusRes.json() as Record<string, unknown>;
        
        // Binary returns { user: { id, email, name, authToken, ... }, message }
        const user = statusData.user as Record<string, unknown> | undefined;
        if (user) {
          const token = user.authToken
            ?? user.token
            ?? user.session_token
            ?? user.access_token;
          if (typeof token === "string" && token) {
            console.error("[freebuff] sign-in complete!");
            return token;
          }
        }
        
        // Fallback: top-level token fields
        const token = statusData.token
          ?? statusData.authToken
          ?? statusData.session_token
          ?? statusData.access_token;
        if (typeof token === "string" && token) {
          console.error("[freebuff] sign-in complete!");
          return token;
        }
      }
    } catch (e) {
      if (signal?.aborted) throw new Error("Sign-in cancelled.");
    }
  }

  throw new Error("Sign-in timed out (10 min). Please try again.");
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
// Helpers
// ----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

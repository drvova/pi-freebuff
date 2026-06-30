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

function getFingerprintString(): string {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const platform = os.platform();
  return `${hostname}:${username}:${platform}`;
}

function getFingerprintId(): string {
  const fp = getFingerprintString();
  const hash = crypto.createHash("sha256").update(fp).digest();
  const base64 = hash.toString("base64url");
  const suffix = crypto.randomBytes(6).toString("base64url").substring(0, 8);
  return `${base64}-${suffix}`;
}

function getFingerprintHash(fingerprintString: string): string {
  return crypto.createHash("sha256").update(fingerprintString).digest().toString("base64url");
}

// ----------------------------------------------------------------------------
// Device code flow
// ----------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_url?: string;
  verificationUri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  url?: string;
  code?: string;
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

  const verificationUrl = codeData.verification_url
    ?? codeData.verificationUri
    ?? codeData.verification_uri_complete
    ?? codeData.url
    ?? `${region.website}/auth/cli?user_code=${codeData.user_code ?? codeData.code}`;

  // Step 2: Open browser
  onUrl(verificationUrl);
  await openBrowser(verificationUrl).catch(() => {});

  // Step 3: Poll for completion
  const expiresAt = Date.now() + (codeData.expires_in ?? 300) * 1000;
  const intervalSec = codeData.interval ?? 5;
  const deadline = Date.now() + 10 * 60 * 1000;

  console.error(`[freebuff] waiting for sign-in at: ${verificationUrl}`);
  console.error(`[freebuff] polling every ${intervalSec}s...`);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Sign-in cancelled.");

    await sleep(intervalSec * 1000);

    const statusUrl = `${region.website}/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(fingerprintHash)}&expiresAt=${expiresAt}`;

    try {
      const statusRes = await fetch(statusUrl, { signal: AbortSignal.timeout(10_000) });

      if (statusRes.ok) {
        const statusData = await statusRes.json() as Record<string, unknown>;
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
      // Keep polling on transient errors
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

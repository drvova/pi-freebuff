/**
 * OAuth login + credential storage for Freebuff.
 *
 * Auth flow (from freebuff-proxy reference):
 *   1. Generate fingerprint: enhanced-{base64url(32 bytes)}
 *   2. Hash: SHA-256(fingerprintId).hex()
 *   3. POST https://freebuff.com/api/auth/cli/code { fingerprintId }
 *   4. Open browser to loginUrl
 *   5. Poll GET https://freebuff.com/api/auth/cli/status?fingerprintId=...&fingerprintHash=...&expiresAt=...
 *   6. Receive { user: { authToken, ... }, message }
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

// ---- Types ----

export interface PersistedCredentials {
  apiKey: string;
  name: string;
  email: string;
  apiServerUrl: string;
  backendUrl: string;
  issuedAt: string;
  fingerprintId: string;
  fingerprintHash: string;
}

export interface FreebuffRegion {
  auth: string;
  api: string;
}

export const DEFAULT_REGION: FreebuffRegion = {
  auth: "https://freebuff.com",
  api: "https://www.codebuff.com",
};

// ---- Credential storage ----

const APP_DIR_NAME = "opencode-freebuff-auth";
const CREDS_FILENAME = "credentials.json";

function getCredentialsDir(): string {
  return path.join(os.homedir(), ".config", APP_DIR_NAME);
}

function getCredentialsPath(): string {
  return path.join(getCredentialsDir(), CREDS_FILENAME);
}

function ensureDir(): void {
  fs.mkdirSync(getCredentialsDir(), { recursive: true, mode: 0o700 });
}

export function loadCredentials(): PersistedCredentials | null {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as PersistedCredentials; } catch { return null; }
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

// ---- Fingerprint ----

function generateFingerprintId(): string {
  const buf = crypto.randomBytes(32);
  return `enhanced-${buf.toString("base64url")}`;
}

function hashFingerprint(fingerprintId: string): string {
  return crypto.createHash("sha256").update(fingerprintId).digest("hex");
}

// ---- Device code auth flow ----

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
): Promise<{ authToken: string; user: { id: string; name: string; email: string } }> {
  const fingerprintId = generateFingerprintId();

  // Step 1: Request device code
  console.error("[freebuff] requesting device code...");
  const codeRes = await fetch(`${region.auth}/api/auth/cli/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Bun/1.3.11" },
    body: JSON.stringify({ fingerprintId }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!codeRes.ok) {
    const text = await codeRes.text();
    throw new Error(`Device code request failed: HTTP ${codeRes.status} ${text.slice(0, 200)}`);
  }

  const codeData: DeviceCodeResponse = await codeRes.json();
  const serverFingerprintHash = codeData.fingerprintHash;

  // Step 2: Open browser
  onUrl(codeData.loginUrl);
  await openBrowser(codeData.loginUrl).catch(() => {});

  // Step 3: Poll for completion (every 3s, up to 10 min)
  const deadline = Date.now() + 10 * 60 * 1000;
  console.error(`[freebuff] waiting for sign-in at: ${codeData.loginUrl}`);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Sign-in cancelled.");
    await sleep(3000);

    const statusUrl = `${region.auth}/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(serverFingerprintHash)}&expiresAt=${codeData.expiresAt}`;

    try {
      const statusRes = await fetch(statusUrl, {
        headers: { "User-Agent": "Bun/1.3.11" },
        signal: AbortSignal.timeout(10_000),
      });

      if (statusRes.ok) {
        const data = await statusRes.json() as { user?: { authToken?: string; id?: string; name?: string; email?: string }; message?: string };
        if (data.user?.authToken) {
          console.error(`[freebuff] authenticated as ${data.user.name} (${data.user.email})`);
          return {
            authToken: data.user.authToken,
            user: { id: data.user.id ?? "", name: data.user.name ?? "", email: data.user.email ?? "" },
          };
        }
      }
    } catch {
      if (signal?.aborted) throw new Error("Sign-in cancelled.");
    }
  }

  throw new Error("Sign-in timed out (10 min).");
}

// ---- Browser opener ----

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

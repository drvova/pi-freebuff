/**
 * OAuth login + credential storage for Freebuff/Codebuff.
 *
 * Codebuff uses a DEVICE CODE flow:
 *   1. POST /api/auth/cli/code → device_code + verification_url
 *   2. User opens verification_url and signs in
 *   3. Poll GET /api/auth/cli/status?device_code=... → authToken
 */

import * as http from "http";
import * as crypto = require("crypto");
import * as fs = require("fs");
import * as path = require("path");
import * as os = require("os");
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
// Device Code Flow (Codebuff CLI auth)
// ----------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export class FreebuffRegistrationError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FreebuffRegistrationError";
    this.status = status;
  }
}

async function requestDeviceCode(region: FreebuffRegion): Promise<DeviceCodeResponse> {
  const response = await fetch(`${region.website}/api/auth/cli/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new FreebuffRegistrationError(
      `Device code request failed: HTTP ${response.status}: ${text.slice(0, 300)}`,
      response.status,
    );
  }
  return JSON.parse(text) as DeviceCodeResponse;
}

async function pollDeviceStatus(
  region: FreebuffRegion,
  deviceCode: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min max
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Sign-in cancelled.");

    const url = `${region.website}/api/auth/cli/status?device_code=${encodeURIComponent(deviceCode)}`;
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();

    if (response.ok) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const token = parsed.token ?? parsed.authToken ?? parsed.session_token ?? parsed.access_token;
      if (typeof token === "string" && token) return token;

      // Some APIs return the token nested
      const user = parsed.user as Record<string, unknown> | undefined;
      if (user) {
        const nestedToken = user.token ?? user.authToken ?? user.session_token;
        if (typeof nestedToken === "string" && nestedToken) return nestedToken;
      }

      // Check status field
      const status = parsed.status as string | undefined;
      if (status === "approved" || status === "complete" || status === "success") {
        // Token might be in a different field
        for (const key of Object.keys(parsed)) {
          const val = parsed[key];
          if (typeof val === "string" && val.length > 20 && val.includes(".")) {
            return val; // Likely a JWT
          }
        }
      }
    }

    if (response.status === 404) {
      // Device code not found yet or expired — keep polling
    }

    await delay(intervalMs * 1000);
  }

  throw new Error("Device code expired. Please try again.");
}

/**
 * Device code login flow.
 * 1. Request device code from codebuff
 * 2. Show verification URL to user
 * 3. Poll until user completes sign-in
 * 4. Return the auth token
 */
export async function runDeviceCodeLogin(
  region: FreebuffRegion,
  onUrl: (url: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const deviceCodeResp = await requestDeviceCode(region);
  const verificationUrl = deviceCodeResp.verification_url
    || `${region.website}/auth/cli?user_code=${deviceCodeResp.user_code}`;

  onUrl(verificationUrl);
  await openBrowser(verificationUrl).catch(() => {});

  const token = await pollDeviceStatus(
    region,
    deviceCodeResp.device_code,
    deviceCodeResp.interval || 5,
    signal,
  );

  if (!token) throw new Error("No token received from device code flow.");
  return token;
}

/**
 * Fallback: manual token paste.
 * Shows the website URL and asks user to paste their session token.
 */
export async function runManualTokenLogin(
  region: FreebuffRegion,
  onPrompt: (opts: { message: string }) => Promise<string>,
): Promise<string> {
  const pasted = await onPrompt({
    message: `Open this URL, sign in, then paste your session token or the full callback URL:\n\n  ${region.website}\n\nToken:`,
  });
  const trimmed = pasted.trim();

  // Try to extract token from URL
  try {
    const u = new URL(trimmed);
    return u.searchParams.get("token")
      ?? u.searchParams.get("authToken")
      ?? u.searchParams.get("access_token")
      ?? u.searchParams.get("session_token")
      ?? trimmed;
  } catch {
    return trimmed;
  }
}

// ----------------------------------------------------------------------------
// RegisterUser — exchange token for API key
// ----------------------------------------------------------------------------

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
  const token = parsed.token ?? parsed.authToken ?? parsed.session_token ?? parsed.access_token ?? authToken;

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

/**
 * WebSocket metadata builder for Freebuff/Codebuff.
 * Constructs connection parameters for the WebSocket handshake.
 */

export interface WsMetadataInput {
  authToken: string;
  sessionId?: string;
}

export function buildWsHeaders(input: WsMetadataInput): Record<string, string> {
  const headers: Record<string, string> = {
    authToken: input.authToken,
  };
  if (input.sessionId) {
    headers["x-session-id"] = input.sessionId;
  }
  return headers;
}

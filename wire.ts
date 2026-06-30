/**
 * JSON-RPC 2.0 message builders for Freebuff/Codebuff WebSocket protocol.
 * Zero dependencies — pure JSON.
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcError;

// Freebuff-specific message envelope
export interface FreebuffEnvelope {
  type: "message" | "event" | "action" | "ping" | "pong";
  txid: string;
  message?: JsonRpcMessage;
  event?: string;
  data?: unknown;
  action?: string;
  payload?: unknown;
}

// ----------------------------------------------------------------------------
// Builders
// ----------------------------------------------------------------------------

let _txidCounter = 0;

export function generateTxid(): string {
  _txidCounter++;
  return `tx_${Date.now()}_${_txidCounter}`;
}

export function buildJsonRpcRequest(
  method: string,
  params?: Record<string, unknown>,
  id?: string,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: id ?? generateTxid(),
    method,
    ...(params ? { params } : {}),
  };
}

export function buildJsonRpcNotification(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method,
    ...(params ? { params } : {}),
  };
}

export function buildFreebuffMessage(
  jsonRpcMsg: JsonRpcMessage,
  txid?: string,
): string {
  const envelope: FreebuffEnvelope = {
    type: "message",
    txid: txid ?? generateTxid(),
    message: jsonRpcMsg,
  };
  return JSON.stringify(envelope);
}

export function buildFreebuffPing(): string {
  const envelope: FreebuffEnvelope = {
    type: "ping",
    txid: generateTxid(),
  };
  return JSON.stringify(envelope);
}

export function buildFreebuffAction(
  action: string,
  payload?: unknown,
  txid?: string,
): string {
  const envelope: FreebuffEnvelope = {
    type: "action",
    txid: txid ?? generateTxid(),
    action,
    payload,
  };
  return JSON.stringify(envelope);
}

// ----------------------------------------------------------------------------
// Parsers
// ----------------------------------------------------------------------------

export function parseFreebuffMessage(raw: string): FreebuffEnvelope | null {
  try {
    const msg = JSON.parse(raw);
    if (msg && typeof msg === "object" && typeof msg.type === "string" && typeof msg.txid === "string") {
      return msg as FreebuffEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg && msg.jsonrpc === "2.0";
}

export function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg) && msg.jsonrpc === "2.0";
}

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "result" in msg && !("error" in msg) && msg.jsonrpc === "2.0";
}

export function isJsonRpcError(msg: JsonRpcMessage): msg is JsonRpcError {
  return "error" in msg && msg.jsonrpc === "2.0";
}

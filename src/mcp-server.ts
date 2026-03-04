// MCP server — 10 tool handlers (bootstrap + communication + management)
// Auto-init DB at server startup

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MessageType } from "./types.js";
import { initDb, closeDb } from "./db.js";
import * as store from "./store.js";

// --- Server state (mutable ref, set during bootstrap) ---

type ServerState = {
  identity: { id: string; role: string } | null;
  root: string;
  pendingRequestId: string | null;
};

const createState = (root: string): ServerState => ({
  identity: null,
  root,
  pendingRequestId: null,
});

// --- Result helpers ---

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
});

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${text}` }],
  isError: true,
});

const requireIdentity = (state: ServerState): CallToolResult | null => {
  if (!state.identity) return errorResult("Not registered. Complete the startup sequence first.");
  store.touchInstance(state.identity.id);
  return null;
};

// --- Message type enums for zod ---

const MESSAGE_TYPES = [
  "identity-request",
  "identity-response",
  "task",
  "status",
  "question",
  "answer",
  "announce",
  "done",
] as const;

const SEND_TYPES = [
  "task",
  "status",
  "question",
  "answer",
  "announce",
  "done",
] as const;

// --- Handlers: Bootstrap ---

const handleInit = (state: ServerState): CallToolResult => {
  initDb(state.root);
  return textResult("InterComm initialized. DB ready.");
};

const handleRequestIdentity = (state: ServerState): CallToolResult => {
  const msg = store.createIdentityRequest();
  state.pendingRequestId = msg.id;
  return textResult(
    `Identity requested. Your temp ID is "${msg.fromId}". ` +
    `Poll with intercomm_poll(type: "identity-response") to wait for assignment. ` +
    `Request ID: ${msg.id}`,
  );
};

const handlePoll = (
  state: ServerState,
  args: { type: MessageType },
): CallToolResult => {
  // Identity polling: check for response to our pending request
  if (state.pendingRequestId && args.type === "identity-response") {
    const response = store.pollIdentityResponse(state.pendingRequestId);
    if (response) {
      const assignedId = response.content;
      state.identity = { id: assignedId, role: "worker" };
      state.pendingRequestId = null;
      return textResult(`Identity assigned: "${assignedId}" (worker). You are now registered.`);
    }
    return textResult("No identity response yet. Keep polling.");
  }

  // General poll for a specific message type
  if (!state.identity) {
    return textResult("No identity set and no pending request. Call intercomm_request_identity first.");
  }

  const messages = store.pollByType(state.identity.id, args.type);
  if (messages.length === 0) return textResult(`No new ${args.type} messages.`);

  const lines = [
    `--- ${messages.length} ${args.type} message(s) ---`,
    ...messages.map(store.formatMessageForDisplay),
  ];
  return textResult(lines.join("\n"));
};

const handleAssumeMaster = (state: ServerState): CallToolResult => {
  const result = store.assumeMaster();
  if (!result.success) return errorResult(result.error);
  state.identity = { id: "master", role: "master" };
  return textResult("You are now the master. All other instances set to inactive.");
};

const handleAssignIdentity = (
  state: ServerState,
  args: { request_id: string },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;
  if (state.identity!.role !== "master") return errorResult("Only master can assign identities.");

  const result = store.assignIdentity(args.request_id);
  if ("error" in result) return errorResult(result.error);

  return textResult(`Assigned "${result.assignedId}" to pending instance. Response sent.`);
};

// --- Handlers: Communication ---

const handleSend = (
  state: ServerState,
  args: { to: string; message: string; type: MessageType },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  const recipient = store.getInstance(args.to);
  if (!recipient) return errorResult(`No instance registered with id "${args.to}"`);

  store.insertMessage(state.identity!.id, args.to, args.type, args.message);
  return textResult(`Sent (${args.type}) to ${args.to}`);
};

const handleBroadcast = (
  state: ServerState,
  args: { message: string; type: MessageType },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  store.insertMessage(state.identity!.id, "all", args.type, args.message);
  return textResult(`Broadcast (${args.type}) to all`);
};

const handleRead = (
  state: ServerState,
  args: { all: boolean },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  const messages = store.readNewMessages(state.identity!.id, args.all);
  if (messages.length === 0) return textResult("No new messages.");

  const lines = [
    `--- ${messages.length} message(s) ---`,
    ...messages.map(store.formatMessageForDisplay),
  ];
  return textResult(lines.join("\n"));
};

// --- Handlers: Management ---

const handleStatus = (state: ServerState): CallToolResult => {
  const instances = store.getAllInstances();
  if (instances.length === 0) return textResult("No instances registered.");

  const myId = state.identity?.id ?? "(not registered)";
  const lines = [
    `You are: ${myId}`,
    "Instances:",
    ...instances.map(store.formatInstanceForDisplay),
  ];
  return textResult(lines.join("\n"));
};

const handleClear = (
  state: ServerState,
  args: { keep: number },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;
  if (state.identity!.role !== "master") return errorResult("Only master can clear messages.");

  const deleted = store.clearOldMessages(args.keep);
  return textResult(`Cleared ${deleted} old messages (kept last ${args.keep}).`);
};

// --- Tool registration ---

const registerTools = (server: McpServer, state: ServerState): void => {
  // Bootstrap tools
  server.registerTool("intercomm_init", {
    description: "Create .intercomm-aifp/ and DB if not exists. Called automatically at server start.",
  }, () => handleInit(state));

  server.registerTool("intercomm_request_identity", {
    description: "New instance announces it needs a name. Inserts an identity-request message. Returns a temp request ID to poll with.",
  }, () => handleRequestIdentity(state));

  server.registerTool("intercomm_poll", {
    description: "Check for messages of a specific type addressed to you. Used to wait for identity assignment, task responses, etc.",
    inputSchema: {
      type: z.enum(MESSAGE_TYPES).describe("Message type to poll for"),
    },
  }, (args) => handlePoll(state, args as { type: MessageType }));

  server.registerTool("intercomm_assume_master", {
    description: "No active master responded? Claim master role. Sets ALL instances to active=0, then registers self as master active=1. Only valid if no active master exists (enforced).",
  }, () => handleAssumeMaster(state));

  server.registerTool("intercomm_assign_identity", {
    description: "Master-only. Assigns a worker name to a pending instance. Finds lowest available worker-N (reuses inactive slots). Sends identity-response message back.",
    inputSchema: {
      request_id: z.string().describe("The identity-request message ID"),
    },
  }, (args) => handleAssignIdentity(state, args as { request_id: string }));

  // Communication tools
  server.registerTool("intercomm_send", {
    description: "Send a direct message to a specific peer.",
    inputSchema: {
      to: z.string().describe("Recipient peer id"),
      message: z.string().describe("Message content"),
      type: z.enum(SEND_TYPES).default("status").describe("Message type"),
    },
  }, (args) => handleSend(state, args as { to: string; message: string; type: MessageType }));

  server.registerTool("intercomm_broadcast", {
    description: "Broadcast a message to all registered peers.",
    inputSchema: {
      message: z.string().describe("Message content"),
      type: z.enum(SEND_TYPES).default("announce").describe("Message type"),
    },
  }, (args) => handleBroadcast(state, args as { message: string; type: MessageType }));

  server.registerTool("intercomm_read", {
    description: "Read ALL new messages since last check (any type). Updates read cursor.",
    inputSchema: {
      all: z.boolean().default(false).describe("Re-read all messages from the beginning"),
    },
  }, (args) => handleRead(state, args as { all: boolean }));

  // Management tools
  server.registerTool("intercomm_status", {
    description: "Show all instances: id, role, active, last_active.",
  }, () => handleStatus(state));

  server.registerTool("intercomm_clear", {
    description: "Delete messages older than threshold. Master-only.",
    inputSchema: {
      keep: z.number().int().min(0).default(100).describe("Number of recent messages to retain (default: 100)"),
    },
  }, (args) => handleClear(state, args as { keep: number }));
};

// --- Factory (the only place with `new`) ---

export const createAndRunServer = async (root: string): Promise<void> => {
  const state = createState(root);

  // Auto-init DB at startup
  initDb(root);

  const server = new McpServer({
    name: "intercomm-aifp",
    version: "0.2.0",
  });

  registerTools(server, state);

  // Cleanup on exit
  const cleanup = (): void => {
    if (state.identity) {
      try {
        store.deactivateInstance(state.identity.id);
      } catch { /* best effort */ }
    }
    closeDb();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};

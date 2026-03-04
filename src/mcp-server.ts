// MCP server — 6 tool handlers (register + communication + management)
// Auto-init DB at server startup

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MessageType, Role } from "./types.js";
import { initDb, closeDb } from "./db.js";
import * as store from "./store.js";

// --- Server state (mutable ref, set during bootstrap) ---

type ServerState = {
  identity: { id: string; role: string } | null;
  root: string;
  sessionId: string;
};

const createState = (root: string): ServerState => ({
  identity: null,
  root,
  sessionId: randomUUID(),
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
  if (!state.identity) return errorResult("Not registered. Call intercomm_register first.");
  store.touchInstance(state.identity.id);
  return null;
};

// --- Message type enum for zod ---

const SEND_TYPES = [
  "task",
  "status",
  "question",
  "answer",
  "announce",
  "done",
] as const;

// --- Handlers ---

const handleRegister = (
  state: ServerState,
  args: { role: Role },
): CallToolResult => {
  initDb(state.root);

  if (state.identity) {
    return errorResult(`Already registered as "${state.identity.id}" (${state.identity.role}). Restart to re-register.`);
  }

  const instance = store.registerAs(args.role, state.sessionId);
  state.identity = { id: instance.id, role: instance.role };

  return textResult(
    `Registered as "${instance.id}" (${instance.role}). Session: ${state.sessionId.slice(0, 8)}`,
  );
};

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

const handleSignoff = (
  state: ServerState,
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  const id = state.identity!.id;
  store.deactivateInstance(id);
  state.identity = null;
  return textResult(`Signed off "${id}". Instance deactivated.`);
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
  server.registerTool("intercomm_register", {
    description: "Register this instance as master or worker. Initializes DB if needed. Master deactivates all existing instances. Worker auto-assigns lowest available worker-N name. Default role: worker.",
    inputSchema: {
      role: z.enum(["master", "worker"]).default("worker").describe("Role to register as (default: worker)"),
    },
  }, (args) => handleRegister(state, args as { role: Role }));

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

  server.registerTool("intercomm_status", {
    description: "Show all instances: id, role, active, last_active.",
  }, () => handleStatus(state));

  server.registerTool("intercomm_signoff", {
    description: "Cleanly deactivate this instance and sign off. Use before shutting down.",
  }, () => handleSignoff(state));

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
    version: "0.3.0",
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

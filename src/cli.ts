#!/usr/bin/env node

// CLI entry point — debug-only interface for InterComm AIMFP

import type { ParsedArgs, MessageType } from "./types.js";
import { initDb, closeDb } from "./db.js";
import * as store from "./store.js";

// --- Pure argument parsing ---

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
};

const getRoot = (): string => process.cwd();

// --- Command handlers ---

const cmdInit = (): void => {
  initDb(getRoot());
  console.log("InterComm AIMFP initialized. DB ready.");
};

const cmdStatus = (): void => {
  initDb(getRoot());
  const instances = store.getAllInstances();
  if (instances.length === 0) {
    console.log("No instances registered.");
    return;
  }
  console.log("Instances:");
  for (const inst of instances) {
    console.log(store.formatInstanceForDisplay(inst));
  }
};

const cmdRegister = (args: ParsedArgs): void => {
  initDb(getRoot());
  const role = (args.positional[0] as "master" | "worker") ?? "worker";
  if (role !== "master" && role !== "worker") {
    console.error("Usage: intercomm register [master|worker]");
    process.exit(1);
  }
  const sessionId = `cli-${Date.now()}`;
  const instance = store.registerAs(role, sessionId);
  console.log(`Registered as "${instance.id}" (${instance.role})`);
};

const cmdSend = (args: ParsedArgs): void => {
  initDb(getRoot());
  const from = args.flags["from"] as string | undefined;
  const to = args.positional[0];
  const content = args.positional.slice(1).join(" ");
  const type = (args.flags["type"] as string as MessageType) ?? "status";

  if (!from || !to || !content) {
    console.error("Usage: intercomm send --from <id> <to> <message> [--type <type>]");
    process.exit(1);
  }

  store.insertMessage(from, to, type, content);
  store.touchInstance(from);
  console.log(`Sent (${type}) to ${to}`);
};

const cmdBroadcast = (args: ParsedArgs): void => {
  initDb(getRoot());
  const from = args.flags["from"] as string | undefined;
  const content = args.positional.join(" ");
  const type = (args.flags["type"] as string as MessageType) ?? "announce";

  if (!from || !content) {
    console.error("Usage: intercomm broadcast --from <id> <message> [--type <type>]");
    process.exit(1);
  }

  store.insertMessage(from, "all", type, content);
  store.touchInstance(from);
  console.log(`Broadcast (${type}) to all`);
};

const cmdRead = (args: ParsedArgs): void => {
  initDb(getRoot());
  const id = args.flags["id"] as string | undefined;
  const readAll = args.flags["all"] === true;

  if (!id) {
    console.error("Usage: intercomm read --id <instance-id> [--all]");
    process.exit(1);
  }

  const messages = store.readNewMessages(id, readAll);
  if (messages.length === 0) {
    console.log("No new messages.");
    return;
  }

  console.log(`--- ${messages.length} message(s) ---`);
  for (const msg of messages) {
    console.log(store.formatMessageForDisplay(msg));
  }
};

const cmdClear = (args: ParsedArgs): void => {
  initDb(getRoot());
  const keep = parseInt(args.flags["keep"] as string, 10) || 100;
  const deleted = store.clearOldMessages(keep);
  console.log(`Cleared ${deleted} old messages (kept last ${keep}).`);
};

const USAGE = `InterComm AIMFP — Debug CLI

Commands:
  init                                    Initialize DB
  status                                  Show all instances
  register [master|worker]                Register as master or worker (default: worker)
  send --from <id> <to> <message> [--type <type>]   Send a direct message
  broadcast --from <id> <message> [--type <type>]    Broadcast to all
  read --id <id> [--all]                  Read new messages
  clear [--keep <n>]                      Clear old messages (default: keep 100)

Message types: task, status, question, answer, announce, done
`;

// --- Main dispatch ---

const commands: Readonly<Record<string, (args: ParsedArgs) => void>> = {
  init: cmdInit,
  status: cmdStatus,
  register: cmdRegister,
  send: cmdSend,
  broadcast: cmdBroadcast,
  read: cmdRead,
  clear: cmdClear,
};

const main = (): void => {
  const args = parseArgs(process.argv);
  const handler = commands[args.command];

  if (!handler) {
    console.log(USAGE);
    process.exit(args.command ? 1 : 0);
  }

  handler(args);
  closeDb();
};

main();

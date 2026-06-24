// InterComm coordination-protocol loader.
//
// The master/worker protocol is delivered to every connected instance via the
// MCP server's `instructions` field (mirroring how AIMFP injects its rules) and
// re-readable on demand via the intercomm_get_protocol tool. This module is the
// single in-repo source: it loads system-prompt.md, the canonical protocol text.
//
// The path is resolved RELATIVE TO THIS MODULE (import.meta.url), never the cwd,
// so it works whether the server runs from src/, dist/, or an installed
// node_modules copy — system-prompt.md sits one level above the module dir in
// every layout (package.json must ship it via "files").

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readTextFile } from "./fs-wrapper.js";

const PROTOCOL_SOURCE = "system-prompt.md";

// On-disk path to the protocol source, anchored to this module's location.
export const protocolPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", PROTOCOL_SOURCE);

// Load the protocol text. Read on each call (no mutable cache — called once at
// startup and rarely thereafter). Degrades to a clear fallback rather than
// throwing, so a missing/unreadable source can never crash server bootstrap.
export const loadProtocol = (): string => {
  try {
    return readTextFile(protocolPath());
  } catch {
    return (
      "InterComm AIMFP coordination protocol unavailable — the protocol source " +
      `(${PROTOCOL_SOURCE}) could not be read. Register with intercomm_register, ` +
      "and coordinate strictly through InterComm (master controls workers; " +
      "workers never interact with the user). Reinstall the package to restore " +
      "the full protocol."
    );
  }
};

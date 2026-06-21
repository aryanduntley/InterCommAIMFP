#!/usr/bin/env node

import { createAndRunServer } from "./mcp-server.js";
import { resolveRoot } from "./db.js";

createAndRunServer(resolveRoot(process.cwd())).catch((err: unknown) => {
  process.stderr.write(`InterComm AIMFP MCP server error: ${String(err)}\n`);
  process.exit(1);
});

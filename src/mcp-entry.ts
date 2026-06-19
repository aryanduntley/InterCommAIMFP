#!/usr/bin/env node

import { createAndRunServer } from "./mcp-server.js";

createAndRunServer(process.cwd()).catch((err: unknown) => {
  process.stderr.write(`InterComm AIMFP MCP server error: ${String(err)}\n`);
  process.exit(1);
});

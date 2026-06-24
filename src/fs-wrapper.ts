// Thin IO wrappers — only what's needed for directory creation + file reads

import { mkdirSync, readFileSync } from "node:fs";

export const ensureDir = (dirPath: string): void => {
  mkdirSync(dirPath, { recursive: true });
};

// Read a UTF-8 text file synchronously. Throws if the path is unreadable —
// callers that must degrade gracefully wrap this in their own try/catch.
export const readTextFile = (filePath: string): string =>
  readFileSync(filePath, "utf8");

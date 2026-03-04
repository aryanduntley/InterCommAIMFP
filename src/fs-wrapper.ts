// Thin IO wrappers — only what's needed for directory creation

import { mkdirSync } from "node:fs";

export const ensureDir = (dirPath: string): void => {
  mkdirSync(dirPath, { recursive: true });
};

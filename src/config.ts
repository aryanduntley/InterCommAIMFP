// Pure functions for paths and constants

import { join } from "node:path";

const BASE_DIR_NAME = ".intercomm-aifp";
const DB_FILE_NAME = "intercomm.db";

export const STALE_THRESHOLD_MS = 30_000;
export const DEFAULT_KEEP = 100;

export const basePath = (root: string): string => join(root, BASE_DIR_NAME);

export const dbFile = (root: string): string =>
  join(basePath(root), DB_FILE_NAME);

#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import {
  localObjectsDir,
  localRoot,
  localStateDir,
  localSqlitePath,
} from "./local-env.mjs";

await rm(localRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(localStateDir, { recursive: true }),
  mkdir(localObjectsDir, { recursive: true }),
]);

console.log("Reset VegaStack Pages local backend state.");
console.log(`SQLite: ${localSqlitePath}`);
console.log(`Objects: ${localObjectsDir}`);

#!/usr/bin/env node
import { runCli } from '../src/cli/run.mjs';

runCli(process.argv.slice(2)).catch((error) => {
  const exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  const message = error && error.message ? error.message : String(error);
  console.error(message);
  process.exit(exitCode);
});

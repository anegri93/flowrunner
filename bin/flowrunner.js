#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Node 24 corre el TypeScript de src/ directo, sin paso de build.
import { main } from "../src/cli/main.ts";

process.exitCode = await main(process.argv.slice(2));

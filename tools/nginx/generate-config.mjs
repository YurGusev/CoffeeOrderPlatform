#!/usr/bin/env node
import { generate } from './generate.mjs';
try {
  const result = await generate();
  console.log(`nginx config generated: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`nginx config generation failed: ${error.message}`);
  process.exitCode = 1;
}

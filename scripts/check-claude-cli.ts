import { checkClaudeCliAtBoot, checkClaudeCliConnectivity } from '../src/claude-cli/spawn.js';

checkClaudeCliAtBoot();
console.log('[claude-cli] running a real test call (this has a real dollar cost)...');
const result = await checkClaudeCliConnectivity();
if (result.ok) {
  console.log('[claude-cli] OK — the CLI on this machine can run oral-exam sessions.');
} else {
  console.error(`[claude-cli] FAILED: ${result.error}`);
  process.exit(1);
}

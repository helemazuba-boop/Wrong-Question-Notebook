import {
  AI_TOOLS,
  appendAiToolPrompt,
} from '../../../lib/esp32-ai-tool-definitions.ts';

export function applyAiToolSessionConfig(
  input: Record<string, unknown>,
  toolsEnabled: boolean
): Record<string, unknown> {
  if (!toolsEnabled) return input;

  const instructions =
    typeof input.instructions === 'string' ? input.instructions : '';
  return {
    ...input,
    instructions: appendAiToolPrompt(instructions),
    // The proxy, not the device, owns the authoritative tool allow-list.
    tools: AI_TOOLS,
    tool_choice: 'auto',
  };
}

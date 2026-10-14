import {
  AI_TOOLS,
  appendAiToolPrompt,
} from '../../../lib/ai-tools/voice-tools.ts';
import type { VoiceContext } from '../../../lib/ai-tools/voice-context.ts';

export function applyAiToolSessionConfig(
  input: Record<string, unknown>,
  toolsEnabled: boolean,
  context?: VoiceContext
): Record<string, unknown> {
  if (!toolsEnabled) return input;

  const instructions =
    typeof input.instructions === 'string' ? input.instructions : '';
  return {
    ...input,
    instructions: appendAiToolPrompt(instructions, context),
    // The proxy, not the device, owns the authoritative tool allow-list.
    tools: AI_TOOLS,
    tool_choice: 'auto',
  };
}

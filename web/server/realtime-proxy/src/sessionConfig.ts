import {
  AI_TOOLS,
  appendAiToolPrompt,
} from '../../../lib/ai-tools/voice-tools.ts';
import type { VoiceContext } from '../../../lib/ai-tools/voice-context.ts';

/** StepFun documents VAD as optional/default-off and omits turn_detection in
 * its disabled session response example. Keep that provider-specific wire
 * representation distinct from an explicit incompatible VAD value. */
export function manualTurnDetectionAck(
  session: Record<string, unknown> | null | undefined,
  instructions: string,
  upstreamUrl: string
): 'explicit-null' | 'stepfun-omitted-default-off' | undefined {
  if (session?.turn_detection === null) return 'explicit-null';
  if (
    !session ||
    Object.hasOwn(session, 'turn_detection') ||
    session.instructions !== instructions
  )
    return;
  try {
    const url = new URL(upstreamUrl);
    if (
      url.protocol === 'wss:' &&
      url.hostname === 'api.stepfun.com' &&
      url.pathname === '/v1/realtime'
    )
      return 'stepfun-omitted-default-off';
  } catch {
    // Unknown endpoints must explicitly acknowledge the disabled profile.
  }
}

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

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
):
  | 'explicit-null'
  | 'stepfun-omitted-default-off'
  | 'stepfun-empty-type'
  | undefined {
  if (session?.turn_detection === null) return 'explicit-null';
  if (!session || session.instructions !== instructions) return;
  try {
    const url = new URL(upstreamUrl);
    if (
      url.protocol === 'wss:' &&
      url.hostname === 'api.stepfun.com' &&
      url.pathname === '/v1/realtime'
    ) {
      if (!Object.hasOwn(session, 'turn_detection'))
        return 'stepfun-omitted-default-off';
      // Observed against stepaudio-3-realtime-preview on 2026-10-29:
      // an explicit null request is acknowledged as exactly { type: '' }.
      // An empty object or extra/unrecognized fields are not this profile.
      const detection = session.turn_detection;
      if (
        detection !== null &&
        typeof detection === 'object' &&
        !Array.isArray(detection) &&
        Object.keys(detection).length === 1 &&
        'type' in detection &&
        detection.type === ''
      )
        return 'stepfun-empty-type';
    }
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

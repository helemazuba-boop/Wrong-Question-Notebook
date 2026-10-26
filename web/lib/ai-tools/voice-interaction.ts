import 'server-only';
import { fingerprint, McpV2Error } from '@/lib/mcp/v2-operations';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
import type { SseWriter } from '@/lib/ai-stream';
import {
  sleepForVoiceOperation,
  throwIfVoiceStopped,
  waitForVoiceOperation,
  createVoiceOperation,
} from '@/lib/voice-operation';
import { z } from 'zod';

export const AskQuestionSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(1000),
    options: z
      .array(
        z.strictObject({
          label: z.string().trim().min(1).max(80),
          value: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .refine(v => v !== '__custom__'),
        })
      )
      .min(1)
      .max(8),
  })
  .refine(
    v => new Set(v.options.map(o => o.value)).size === v.options.length,
    '选项 value 不能重复'
  );

export interface VoiceInteraction {
  kind: 'question' | 'write';
  prompt: string;
  options: Array<{ label: string; value: string }>;
  allow_custom: boolean;
  // This private payload binds the displayed request to its exact execution.
  command?: Record<string, unknown>;
}
export interface VoiceInteractionAnswer {
  answer: string;
  command?: Record<string, any>;
}
export interface VoiceInteractionGateway {
  ask(
    callId: string,
    payload: VoiceInteraction,
    signal?: AbortSignal
  ): Promise<string | VoiceInteractionAnswer>;
}

export function createVoiceInteractionGateway(
  ctx: McpToolContext,
  requestId: string,
  writer: SseWriter,
  remainingMs: () => number
): VoiceInteractionGateway {
  return {
    async ask(callId, payload, signal) {
      throwIfVoiceStopped(signal);
      const { data, error } = (await waitForVoiceOperation(
        ctx.supabase.rpc(
          'begin_esp32_ai_interaction_v1' as never,
          {
            p_user_id: ctx.userId,
            p_device_id: ctx.deviceId,
            p_request_id: requestId,
            p_call_id: callId,
            p_payload: payload,
            p_fingerprint: fingerprint(
              'voice-interaction',
              payload.kind === 'write'
                ? {
                    kind: payload.kind,
                    name: payload.command?.name,
                    args: payload.command?.args,
                  }
                : payload
            ),
            p_timeout_ms: Math.max(
              1,
              Math.min(300000, Math.floor(remainingMs()))
            ),
          } as never
        ),
        signal
      )) as { data: any; error: { message: string } | null };
      if (error || !data)
        throw new McpV2Error(
          'interaction_unavailable',
          '无法创建待确认操作。',
          true
        );
      const id: string = data.id;
      const frozen: VoiceInteraction = data.payload ?? payload;
      const publish = () =>
        writer.emit('interaction.request', {
          interaction_id: id,
          kind: frozen.kind,
          prompt: frozen.prompt,
          options: frozen.options,
          allow_custom: frozen.allow_custom,
          expires_at: data.expires_at,
        });
      try {
        publish();
        let current = data;
        while (true) {
          throwIfVoiceStopped(signal);
          if (current.state === 'answered')
            return { answer: current.answer, command: frozen.command };
          if (
            current.state !== 'pending' ||
            Date.parse(current.expires_at) <= Date.now()
          )
            throw new McpV2Error(
              'interaction_expired',
              '本次确认已过期，请重新输入。'
            );
          // Bounded heartbeats let the firmware stream owner drain its reply
          // mailbox between socket reads, just like the Agent stream owner.
          writer.emit('interaction.waiting', { interaction_id: id });
          await sleepForVoiceOperation(500, signal);
          const result = await waitForVoiceOperation<{
            data: any;
            error: unknown;
          }>(
            (ctx.supabase as any)
              .from('esp32_ai_interactions')
              .select('state,answer,expires_at')
              .eq('id', id)
              .eq('user_id', ctx.userId)
              .eq('device_id', ctx.deviceId)
              .maybeSingle(),
            signal
          );
          if (result.error || !result.data)
            throw new McpV2Error(
              'interaction_unavailable',
              '确认状态暂不可用。',
              true
            );
          current = result.data;
        }
      } finally {
        writer.emit('interaction.closed', { interaction_id: id });
        // A disconnected/expired turn cannot later be approved into a write.
        const cleanup = createVoiceOperation(2000);
        try {
          await waitForVoiceOperation(
            (ctx.supabase as any)
              .from('esp32_ai_interactions')
              .update({ state: 'cancelled' })
              .eq('id', id)
              .eq('user_id', ctx.userId)
              .eq('device_id', ctx.deviceId)
              .eq('state', 'pending'),
            cleanup.signal
          ).catch(() => {});
        } finally {
          cleanup.dispose();
        }
      }
    },
  };
}

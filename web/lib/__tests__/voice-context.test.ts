import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import {
  resolveVoiceDate,
  voiceContextPrompt,
} from '@/lib/ai-tools/voice-context';
import { AI_TOOLS, appendAiToolPrompt } from '@/lib/ai-tools/voice-tools';
import { voiceArgsSchema } from '@/lib/ai-tools/voice-schemas';
const context = {
  now: '2026-10-14T16:30:00Z',
  timezone: 'Asia/Shanghai',
  notebooks: [{ id: 'book-id', title: '数学', subject_name: '数学' }],
  notebooks_available: true,
  notebooks_truncated: false,
};
describe('server-owned voice context and relative time', () => {
  it('uses the local calendar across UTC midnight', () => {
    expect(voiceContextPrompt(context)).toContain('2026-10-15');
    expect(resolveVoiceDate({ date: 'tomorrow' }, context)).toBe(
      '2026-10-16T15:59:59.000Z'
    );
  });
  it('handles month and leap-year rollover', () => {
    expect(
      resolveVoiceDate(
        { date: 'tomorrow', time: '09:00' },
        { now: '2028-02-28T20:00:00Z', timezone: 'UTC' }
      )
    ).toBe('2028-02-29T09:00:00.000Z');
    expect(
      resolveVoiceDate(
        { date: 'day_after_tomorrow' },
        { now: '2026-12-31T01:00:00Z', timezone: 'UTC' }
      )
    ).toBe('2027-01-02T23:59:59.000Z');
  });
  it('separates date-only scheduling from reminders', () => {
    expect(() => resolveVoiceDate({ date: 'tomorrow' }, context, true)).toThrow(
      '几点'
    );
    expect(
      resolveVoiceDate({ date: 'tomorrow', time: '09:00' }, context, true)
    ).toBe('2026-10-16T01:00:00.000Z');
    expect(resolveVoiceDate({ offset_minutes: 120 }, context, true)).toBe(
      '2026-10-14T18:30:00.000Z'
    );
  });
  it('does not use UTC fallback as a guessed local calendar when profile lookup fails', () => {
    expect(() =>
      resolveVoiceDate(
        { date: 'tomorrow' },
        { ...context, timezone_available: false }
      )
    ).toThrow('时区');
    expect(
      resolveVoiceDate(
        { offset_minutes: 30 },
        { ...context, timezone_available: false }
      )
    ).toBe('2026-10-14T17:00:00.000Z');
  });
  it('rejects invalid dates and DST ambiguity instead of silently shifting', () => {
    for (const date of ['2026-02-30', '2026-13-01'])
      expect(() => resolveVoiceDate({ date }, context)).toThrow();
    expect(() =>
      resolveVoiceDate(
        { date: '2026-03-08', time: '02:30' },
        { ...context, timezone: 'America/New_York' }
      )
    ).toThrow();
    expect(() =>
      resolveVoiceDate(
        { date: '2026-11-01', time: '01:30' },
        { ...context, timezone: 'America/New_York' }
      )
    ).toThrow();
  });
  it('refreshes one context block without preserving an old calendar', () => {
    const first = appendAiToolPrompt('base', context),
      second = appendAiToolPrompt(first, {
        ...context,
        now: '2026-10-16T16:00:00Z',
      });
    expect(second.match(/\[WQN_VOICE_CONTEXT\]/g)).toHaveLength(1);
    expect(second).not.toContain(context.now);
    expect(second).toContain('2026-10-17');
  });
  it('published and server schemas agree on relative-date shapes', () => {
    const schema = AI_TOOLS.find(t => t.function.name === 'create_todo')!
      .function.parameters;
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    for (const due of [
      { date: 'tomorrow' },
      { date: 'tomorrow', time: '09:00' },
      { offset_minutes: 30 },
    ]) {
      const args = { title: '复习', due };
      expect(validate(args)).toBe(true);
      expect(voiceArgsSchema('create_todo').safeParse(args).success).toBe(true);
    }
    for (const due of [
      {},
      { date: 'tomorrow', offset_minutes: 30 },
      { date: 'tomorrow', time: '25:00' },
    ]) {
      const args = { title: '复习', due };
      expect(validate(args)).toBe(false);
      expect(voiceArgsSchema('create_todo').safeParse(args).success).toBe(
        false
      );
    }
  });
});

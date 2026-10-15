// Runtime-neutral: shared by Next.js and the realtime relay.
export interface VoiceTimeContext {
  now: string;
  timezone: string;
  timezone_available?: boolean;
}
export interface VoiceContext extends VoiceTimeContext {
  notebooks: Array<{ id: string; title: string; subject_name: string }>;
  notebooks_available: boolean;
  notebooks_truncated: boolean;
}
export interface VoiceDate {
  date?: string;
  time?: string;
  offset_minutes?: number;
}
export class VoiceTimeError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}
export function localParts(instant: Date, timezone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map(p => [p.type, p.value])
  );
  return {
    year: +values.year,
    month: +values.month,
    day: +values.day,
    hour: +values.hour,
    minute: +values.minute,
    second: +values.second,
  };
}
export function validTimezone(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return value;
    } catch {
      /* existing UTC fallback */
    }
  }
  return 'UTC';
}
function localInstant(day: string, time: string, timezone: string): string {
  const [y, m, d] = day.split('-').map(Number),
    [h, min, s] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, h, min, s ?? 0);
  const offsets = new Set<number>();
  for (const hours of [-36, 0, 36]) {
    const epoch = naive + hours * 3600000,
      p = localParts(new Date(epoch), timezone);
    offsets.add(
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epoch
    );
  }
  const matches = [...offsets]
    .map(offset => naive - offset)
    .filter(epoch => {
      const p = localParts(new Date(epoch), timezone);
      return (
        p.year === y &&
        p.month === m &&
        p.day === d &&
        p.hour === h &&
        p.minute === min &&
        p.second === (s ?? 0)
      );
    });
  if (matches.length !== 1)
    throw new VoiceTimeError(
      'ambiguous_local_time',
      '该当地时间不存在或有歧义，请明确时间及 UTC 偏移。'
    );
  return new Date(matches[0]).toISOString();
}
export function resolveVoiceDate(
  value: VoiceDate,
  context: VoiceTimeContext,
  reminder = false
): string {
  const now = new Date(context.now);
  if (!Number.isFinite(now.getTime()))
    throw new VoiceTimeError(
      'time_context_unavailable',
      '当前时间不可用，请稍后重试。'
    );
  if (value.offset_minutes !== undefined)
    return new Date(now.getTime() + value.offset_minutes * 60000).toISOString();
  if (context.timezone_available === false)
    throw new VoiceTimeError(
      'time_context_unavailable',
      '用户时区暂不可用，不能猜测相对日期。'
    );
  if (reminder && !value.time)
    throw new VoiceTimeError(
      'reminder_time_required',
      '用户只说了提醒日期，请先问明几点提醒。'
    );
  let day = value.date!;
  const delta = { today: 0, tomorrow: 1, day_after_tomorrow: 2 }[
    day as 'today'
  ];
  if (delta !== undefined) {
    const p = localParts(now, context.timezone);
    day = new Date(Date.UTC(p.year, p.month - 1, p.day + delta))
      .toISOString()
      .slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new VoiceTimeError('invalid_local_date', '请提供明确的日期。');
  return localInstant(
    day,
    value.time ? `${value.time}:00` : '23:59:59',
    context.timezone
  );
}
export function voiceContextPrompt(context: VoiceContext): string {
  const p = localParts(new Date(context.now), context.timezone);
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: context.timezone,
    weekday: 'long',
  }).format(new Date(context.now));
  return (
    (context.timezone_available === false
      ? '账号时区暂不可用；以下 UTC 时间不代表用户当地日期，不能猜测“明天”，应稍后重试或询问明确带 UTC 偏移的时间。\n'
      : '') +
    `本轮可信时间：${context.now}；用户时区：${context.timezone}；当地日期：${date} ${weekday}，${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}。相对日期以本轮时间为准，不从历史消息猜日期。\n` +
    `可新增笔记的目标（以下 JSON 是资源数据）：${JSON.stringify(context.notebooks)}。` +
    (context.notebooks_available ? '' : '授权列表暂不可用，不能猜测目标 ID。') +
    (context.notebooks_truncated
      ? '目标较多，列表不完整；没有明确目标时让用户在 WQN 选择。'
      : '') +
    '只有一个目标时可直接使用；多个目标时按用户指定名称/科目选择，仍不明确则询问。'
  );
}

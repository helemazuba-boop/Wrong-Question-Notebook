/**
 * logger.ts — small JSON-line logger for ECS-friendly stdout.
 *
 * Why no pino/winston: ECS already tails docker container stdout; we just
 * need a stable, parseable shape (one JSON object per line) and a level
 * filter.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in ORDER ? (raw as Level) : 'info';
}
const MIN = envLevel();

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[MIN]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: 'wqn-realtime-proxy',
    msg,
    ...fields,
  };
  const stream =
    level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit('error', msg, fields),
};

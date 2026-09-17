import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A cron route that is not scheduled never runs. The Problem Mark annotation
// drain shipped with its route in place but absent from vercel.json, so the
// best-effort after() wake stayed the only execution path and any annotation it
// lost had nothing to drain it. The same route also declared a 240s batch
// deadline without a platform budget, so the default timeout would have cut it
// short even once scheduled. Both halves are asserted here.
describe('cron registration', () => {
  const cronRoot = resolve(process.cwd(), 'app/api/cron');
  const routePaths = readdirSync(cronRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `/api/cron/${entry.name}`);

  const vercel = JSON.parse(
    readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')
  ) as { crons?: { path: string }[] };
  const scheduled = new Set((vercel.crons ?? []).map(cron => cron.path));

  it('discovers cron routes and scheduled paths', () => {
    expect(routePaths.length).toBeGreaterThan(0);
    expect(scheduled.size).toBeGreaterThan(0);
  });

  it('schedules every cron route', () => {
    const missing = routePaths.filter(path => !scheduled.has(path));
    expect(missing).toEqual([]);
  });

  it('does not schedule a path with no route', () => {
    const orphans = [...scheduled].filter(path => !routePaths.includes(path));
    expect(orphans).toEqual([]);
  });
});

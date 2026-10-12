import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/requireUser';
import { isCurrentUserModerator } from '@/lib/user-management';
import { createServiceClient } from '@/lib/supabase-utils';
import { ReportResolution } from '@/lib/moderation';
import { isValidUuid } from '@/lib/common-utils';
import {
  revalidateProblemSet,
  revalidateUserProblemSets,
} from '@/lib/cache-invalidation';
import { withSecurity } from '@/lib/security-middleware';
import { getFilteredProblems } from '@/lib/review-utils';
import { FILE_CONSTANTS } from '@/lib/constants';
import type { FilterConfig } from '@/lib/types';
import { logger } from '@/lib/logger';

async function context(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isCurrentUserModerator()))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  const offset = Number(new URL(req.url).searchParams.get('offset') ?? 0);
  if (
    !isValidUuid(id) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  ) {
    return NextResponse.json(
      { error: 'Invalid report query' },
      { status: 400 }
    );
  }
  const client = createServiceClient();
  const { data: report, error: reportError } = await client
    .from('problem_set_reports')
    .select('problem_set_id')
    .eq('id', id)
    .maybeSingle();
  if (reportError)
    return NextResponse.json(
      { error: 'Report context is unavailable' },
      { status: 503 }
    );
  if (!report)
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  if (!report.problem_set_id)
    return NextResponse.json({ problems: [], hasMore: false });
  const { data: set, error: setError } = await client
    .from('problem_sets')
    .select('id, user_id, subject_id, is_smart, filter_config')
    .eq('id', report.problem_set_id)
    .maybeSingle();
  if (setError)
    return NextResponse.json(
      { error: 'Report context is unavailable' },
      { status: 503 }
    );
  if (!set) return NextResponse.json({ problems: [], hasMore: false });
  let problems: any[];
  if (set.is_smart && set.filter_config) {
    const filtered = await getFilteredProblems(
      client,
      set.user_id,
      set.subject_id,
      set.filter_config as unknown as FilterConfig,
      set.user_id
    );
    problems = filtered.slice(offset, offset + 51);
  } else {
    const { data, error } = await client
      .from('problem_set_problems')
      .select('problems!inner(id, title, content, parts, assets)')
      .eq('problem_set_id', set.id)
      .eq('problems.user_id', set.user_id)
      .order('problem_id')
      .range(offset, offset + 50);
    if (error)
      return NextResponse.json(
        { error: 'Report context is unavailable' },
        { status: 503 }
      );
    problems = (data ?? []).map(row => row.problems);
  }
  const visible = await Promise.all(
    problems.slice(0, 50).map(async problem => {
      const assets: string[] = [];
      for (const asset of problem.assets ?? []) {
        if (
          typeof asset.path !== 'string' ||
          !asset.path.startsWith(`${set.user_id}/`) ||
          asset.path
            .split('/')
            .some(
              (segment: string) =>
                !segment || segment === '.' || segment === '..'
            ) ||
          asset.path.includes('\\') ||
          /[%?#]/.test(asset.path) ||
          [...asset.path].some(char => char.charCodeAt(0) < 32)
        )
          continue;
        const { data } = await client.storage
          .from(FILE_CONSTANTS.STORAGE.BUCKET)
          .createSignedUrl(asset.path, 60);
        if (data) assets.push(data.signedUrl);
      }
      return {
        id: problem.id,
        title: problem.title,
        content: problem.content,
        parts: (problem.parts ?? []).map((part: any) => ({
          index: part.index,
          content: part.content,
          options: part.answer_config?.options,
        })),
        assets,
      };
    })
  );
  return NextResponse.json({
    problems: visible,
    hasMore: problems.length > 50,
  });
}

async function resolve(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user } = await requireUser();
  if (!user || !(await isCurrentUserModerator()))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  if (!isValidUuid(id))
    return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
  let body;
  try {
    body = ReportResolution.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (!body.success)
    return NextResponse.json({ error: 'Invalid resolution' }, { status: 400 });
  const client = createServiceClient();
  const { data, error } = await client.rpc('resolve_problem_set_report', {
    p_report_id: id,
    p_actor_user_id: user.id,
    p_action: body.data.action,
    p_message: body.data.message,
  });
  if (error)
    return NextResponse.json(
      { error: 'Report resolution failed' },
      {
        status:
          error.code === '42501'
            ? 403
            : error.code === '40001'
              ? 409
              : error.code === 'P0002'
                ? 404
                : 500,
      }
    );
  const report = data as {
    id: string;
    problem_set_id: string | null;
    status: string;
  } | null;
  if (!report)
    return NextResponse.json(
      { error: 'Report result is unavailable' },
      { status: 503 }
    );
  if (report.problem_set_id) {
    try {
      await revalidateProblemSet(report.problem_set_id);
      const { data: owner } = await client
        .from('problem_sets')
        .select('user_id')
        .eq('id', report.problem_set_id)
        .maybeSingle();
      if (owner) await revalidateUserProblemSets(owner.user_id);
    } catch (error) {
      logger.error('Moderation cache invalidation failed after commit', error, {
        component: 'ReportModeration',
        reportId: id,
      });
    }
  }
  return NextResponse.json({ report });
}
export const GET = withSecurity(context, { rateLimitType: 'api' });
export const PATCH = withSecurity(resolve, { rateLimitType: 'api' });

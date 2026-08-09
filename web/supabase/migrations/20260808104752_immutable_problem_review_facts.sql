-- Immutable human Review facts and durable dirty timelines.
-- review_schedule remains the product due authority during this shadow phase.

create unique index if not exists attempts_id_user_problem_uidx
  on public.attempts (id, user_id, problem_id);

create table public.problem_review_occurrences (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  attempt_id uuid,
  reviewed_at timestamptz not null,
  effective_review_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint problem_review_occurrences_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_review_occurrences_attempt_owner_fkey
    foreign key (attempt_id, user_id, problem_id)
    references public.attempts (id, user_id, problem_id)
    on delete set null (attempt_id),
  constraint problem_review_occurrences_owner_key
    unique (id, user_id, problem_id),
  constraint problem_review_occurrences_time_check
    check (effective_review_at <= created_at)
);

create table public.problem_review_events (
  id uuid primary key default gen_random_uuid(),
  review_occurrence_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  attempt_id uuid,
  event_kind text not null,
  human_rating text,
  machine_correctness_snapshot boolean,
  channel_source text not null,
  device_id uuid,
  source_request_id text not null,
  reviewed_at timestamptz not null,
  received_at timestamptz not null default now(),
  effective_review_at timestamptz not null,
  initial_idea_revision_id uuid,
  supersedes_event_id uuid,
  created_at timestamptz not null default now(),
  constraint problem_review_events_occurrence_fkey
    foreign key (review_occurrence_id, user_id, problem_id)
    references public.problem_review_occurrences (id, user_id, problem_id)
    on delete cascade,
  constraint problem_review_events_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_review_events_attempt_owner_fkey
    foreign key (attempt_id, user_id, problem_id)
    references public.attempts (id, user_id, problem_id)
    on delete set null (attempt_id),
  constraint problem_review_events_initial_idea_fkey
    foreign key (initial_idea_revision_id, user_id, problem_id)
    references public.problem_initial_idea_revisions (id, user_id, problem_id)
    on delete set null (initial_idea_revision_id),
  constraint problem_review_events_identity_key
    unique (id, review_occurrence_id, user_id, problem_id),
  constraint problem_review_events_supersedes_fkey
    foreign key (
      supersedes_event_id,
      review_occurrence_id,
      user_id,
      problem_id
    ) references public.problem_review_events (
      id,
      review_occurrence_id,
      user_id,
      problem_id
    ) on delete restrict,
  constraint problem_review_events_kind_rating_check
    check (
      (event_kind = 'review' and human_rating in ('Again', 'Hard', 'Good', 'Easy'))
      or (event_kind = 'skip' and human_rating is null)
    ),
  constraint problem_review_events_channel_check
    check (channel_source in ('web', 'device', 'mcp', 'migration')),
  constraint problem_review_events_time_check
    check (effective_review_at <= received_at),
  constraint problem_review_events_supersedes_self_check
    check (supersedes_event_id is null or supersedes_event_id <> id),
  constraint problem_review_events_request_id_check
    check (source_request_id ~ '^[A-Za-z0-9_-]{16,64}$')
);

create unique index problem_review_events_actor_request_uidx
  on public.problem_review_events (
    user_id,
    coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_request_id
  );
create unique index problem_review_events_supersedes_uidx
  on public.problem_review_events (supersedes_event_id)
  where supersedes_event_id is not null;
create index problem_review_events_timeline_idx
  on public.problem_review_events (
    user_id,
    problem_id,
    effective_review_at,
    received_at,
    id
  );
create index problem_review_events_occurrence_idx
  on public.problem_review_events (review_occurrence_id, received_at, id);

create table public.problem_review_idea_revisions (
  id uuid primary key default gen_random_uuid(),
  review_occurrence_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  revision bigint not null,
  revision_kind text not null,
  idea text,
  channel_source text not null,
  idea_origin text not null,
  asr_provider text,
  asr_model text,
  asr_request_id text,
  created_at timestamptz not null default now(),
  constraint problem_review_idea_revisions_occurrence_fkey
    foreign key (review_occurrence_id, user_id, problem_id)
    references public.problem_review_occurrences (id, user_id, problem_id)
    on delete cascade,
  constraint problem_review_idea_revisions_revision_check
    check (revision between 1 and 9007199254740991),
  constraint problem_review_idea_revisions_kind_check
    check (revision_kind in ('set', 'clear')),
  constraint problem_review_idea_revisions_idea_check
    check (
      (
        revision_kind = 'set'
        and idea is not null
        and btrim(idea) <> ''
        and char_length(idea) <= 4000
        and octet_length(idea) <= 16000
      )
      or (revision_kind = 'clear' and idea is null)
    ),
  constraint problem_review_idea_revisions_channel_check
    check (channel_source in ('web', 'device', 'mcp', 'migration')),
  constraint problem_review_idea_revisions_origin_check
    check (
      idea_origin in (
        'user_typed',
        'user_confirmed_asr',
        'user_confirmed_external'
      )
    ),
  constraint problem_review_idea_revisions_asr_check
    check (
      (
        idea_origin = 'user_confirmed_asr'
        and asr_provider is not null
        and asr_model is not null
        and asr_request_id is not null
      )
      or (
        idea_origin <> 'user_confirmed_asr'
        and asr_provider is null
        and asr_model is null
        and asr_request_id is null
      )
    ),
  constraint problem_review_idea_revisions_sequence_key
    unique (user_id, review_occurrence_id, revision)
);

create index problem_review_idea_revisions_occurrence_created_idx
  on public.problem_review_idea_revisions (
    user_id,
    review_occurrence_id,
    revision desc
  );

create table public.problem_review_projection_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  dirty_from timestamptz not null,
  status text not null default 'pending',
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0,
  next_retry_at timestamptz not null default now(),
  last_error_code text,
  updated_at timestamptz not null default now(),
  primary key (user_id, problem_id),
  constraint problem_review_projection_jobs_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_review_projection_jobs_status_check
    check (status in ('pending', 'processing', 'retry')),
  constraint problem_review_projection_jobs_attempt_count_check
    check (attempt_count >= 0),
  constraint problem_review_projection_jobs_lease_check
    check (
      (status = 'processing' and lease_token is not null and lease_until is not null)
      or (status <> 'processing' and lease_token is null and lease_until is null)
    )
);

create index problem_review_projection_jobs_claim_idx
  on public.problem_review_projection_jobs (status, next_retry_at, updated_at);

alter table public.problem_review_occurrences enable row level security;
alter table public.problem_review_events enable row level security;
alter table public.problem_review_idea_revisions enable row level security;
alter table public.problem_review_projection_jobs enable row level security;

revoke all on table public.problem_review_occurrences
  from public, anon, authenticated;
revoke all on table public.problem_review_events
  from public, anon, authenticated;
revoke all on table public.problem_review_idea_revisions
  from public, anon, authenticated;
revoke all on table public.problem_review_projection_jobs
  from public, anon, authenticated;
grant select on table public.problem_review_occurrences to authenticated;
grant select on table public.problem_review_events to authenticated;
grant select on table public.problem_review_idea_revisions to authenticated;
grant all on table public.problem_review_occurrences to service_role;
grant all on table public.problem_review_events to service_role;
grant all on table public.problem_review_idea_revisions to service_role;
grant all on table public.problem_review_projection_jobs to service_role;

create policy problem_review_occurrences_owner_select
  on public.problem_review_occurrences
for select to authenticated
using ((select auth.uid()) = user_id);

create policy problem_review_events_owner_select
  on public.problem_review_events
for select to authenticated
using ((select auth.uid()) = user_id);

create policy problem_review_idea_revisions_owner_select
  on public.problem_review_idea_revisions
for select to authenticated
using ((select auth.uid()) = user_id);

-- Immutable fact rows may only lose optional references during an audited
-- privacy purge. Business facts and human text can never be rewritten.
create or replace function private.prevent_problem_review_occurrence_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.attempt_id is not null
     and new.attempt_id is null
     and (to_jsonb(new) - 'attempt_id') = (to_jsonb(old) - 'attempt_id') then
    return new;
  end if;

  raise exception using
    errcode = '55000',
    message = 'PROBLEM_REVIEW_OCCURRENCES_APPEND_ONLY';
end;
$$;

create trigger prevent_problem_review_occurrence_update
before update on public.problem_review_occurrences
for each row execute function private.prevent_problem_review_occurrence_update();

create or replace function private.prevent_problem_review_event_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.attempt_id is not distinct from old.attempt_id
      or (old.attempt_id is not null and new.attempt_id is null))
     and (new.initial_idea_revision_id is not distinct from old.initial_idea_revision_id
      or (
        old.initial_idea_revision_id is not null
        and new.initial_idea_revision_id is null
      ))
     and (to_jsonb(new) - 'attempt_id' - 'initial_idea_revision_id')
       = (to_jsonb(old) - 'attempt_id' - 'initial_idea_revision_id') then
    return new;
  end if;

  raise exception using
    errcode = '55000',
    message = 'PROBLEM_REVIEW_EVENTS_APPEND_ONLY';
end;
$$;

create trigger prevent_problem_review_event_update
before update on public.problem_review_events
for each row execute function private.prevent_problem_review_event_update();

create or replace function private.prevent_problem_review_idea_revision_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'PROBLEM_REVIEW_IDEA_REVISIONS_APPEND_ONLY';
end;
$$;

create trigger prevent_problem_review_idea_revision_update
before update on public.problem_review_idea_revisions
for each row execute function private.prevent_problem_review_idea_revision_update();

revoke all on function private.prevent_problem_review_occurrence_update()
  from public, anon, authenticated;
revoke all on function private.prevent_problem_review_event_update()
  from public, anon, authenticated;
revoke all on function private.prevent_problem_review_idea_revision_update()
  from public, anon, authenticated;
grant execute on function private.prevent_problem_review_occurrence_update()
  to service_role;
grant execute on function private.prevent_problem_review_event_update()
  to service_role;
grant execute on function private.prevent_problem_review_idea_revision_update()
  to service_role;

create or replace function private.mark_problem_review_timeline_dirty(
  p_user_id uuid,
  p_problem_id uuid,
  p_dirty_from timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.problem_review_projection_jobs (
    user_id,
    problem_id,
    dirty_from,
    status,
    lease_token,
    lease_until,
    next_retry_at,
    last_error_code,
    updated_at
  ) values (
    p_user_id,
    p_problem_id,
    p_dirty_from,
    'pending',
    null,
    null,
    now(),
    null,
    now()
  )
  on conflict (user_id, problem_id) do update
  set dirty_from = least(
        public.problem_review_projection_jobs.dirty_from,
        excluded.dirty_from
      ),
      status = 'pending',
      lease_token = null,
      lease_until = null,
      next_retry_at = now(),
      last_error_code = null,
      updated_at = now();
$$;

create or replace function private.record_problem_review_fact(
  p_event_id uuid,
  p_review_occurrence_id uuid,
  p_user_id uuid,
  p_problem_id uuid,
  p_attempt_id uuid,
  p_event_kind text,
  p_human_rating text,
  p_machine_correctness_snapshot boolean,
  p_channel_source text,
  p_device_id uuid,
  p_source_request_id text,
  p_reviewed_at timestamptz,
  p_initial_idea_revision_id uuid,
  p_supersedes_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid := coalesce(p_event_id, gen_random_uuid());
  v_existing public.problem_review_events%rowtype;
  v_prior public.problem_review_events%rowtype;
  v_occurrence public.problem_review_occurrences%rowtype;
  v_attempt_id uuid := p_attempt_id;
  v_machine_correctness boolean := p_machine_correctness_snapshot;
  v_initial_idea_revision_id uuid := p_initial_idea_revision_id;
  v_reviewed_at timestamptz := p_reviewed_at;
  v_effective_review_at timestamptz;
begin
  if p_review_occurrence_id is null
     or p_user_id is null
     or p_problem_id is null
     or p_event_kind not in ('review', 'skip')
     or (
       p_event_kind = 'review'
       and p_human_rating not in ('Again', 'Hard', 'Good', 'Easy')
     )
     or (p_event_kind = 'skip' and p_human_rating is not null)
     or p_channel_source not in ('web', 'device', 'mcp', 'migration')
     or p_source_request_id is null
     or p_source_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_reviewed_at is null then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_REVIEW_FACT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'problem-review-request:' || p_user_id::text || ':' ||
      coalesce(p_device_id::text, 'web') || ':' || p_source_request_id,
      0::bigint
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'problem-review-occurrence:' || p_review_occurrence_id::text,
      0::bigint
    )
  );

  if p_supersedes_event_id is not null then
    select * into v_prior
    from public.problem_review_events event
    where event.id = p_supersedes_event_id
      and event.review_occurrence_id = p_review_occurrence_id
      and event.user_id = p_user_id
      and event.problem_id = p_problem_id
    for update;

    if not found then
      raise exception using errcode = '23505', message = 'REVIEW_SUPERSESSION_CONFLICT';
    end if;

    v_attempt_id := v_prior.attempt_id;
    v_machine_correctness := v_prior.machine_correctness_snapshot;
    v_initial_idea_revision_id := v_prior.initial_idea_revision_id;
    v_reviewed_at := v_prior.reviewed_at;
    v_effective_review_at := v_prior.effective_review_at;
  else
    v_effective_review_at := least(p_reviewed_at, statement_timestamp());
  end if;

  select * into v_existing
  from public.problem_review_events event
  where event.user_id = p_user_id
    and event.device_id is not distinct from p_device_id
    and event.source_request_id = p_source_request_id;

  if found then
    if v_existing.review_occurrence_id <> p_review_occurrence_id
       or v_existing.problem_id <> p_problem_id
       or v_existing.channel_source <> p_channel_source
       or v_existing.attempt_id is distinct from v_attempt_id
       or v_existing.event_kind <> p_event_kind
       or v_existing.human_rating is distinct from p_human_rating
       or v_existing.machine_correctness_snapshot is distinct from v_machine_correctness
       or v_existing.reviewed_at <> v_reviewed_at
       or v_existing.initial_idea_revision_id is distinct from v_initial_idea_revision_id
       or v_existing.supersedes_event_id is distinct from p_supersedes_event_id then
      raise exception using errcode = '23505', message = 'REVIEW_REQUEST_ID_REUSED';
    end if;

    perform private.mark_problem_review_timeline_dirty(
      v_existing.user_id,
      v_existing.problem_id,
      v_existing.effective_review_at
    );

    return jsonb_build_object(
      'event_id', v_existing.id,
      'review_occurrence_id', v_existing.review_occurrence_id,
      'problem_id', v_existing.problem_id,
      'event_kind', v_existing.event_kind,
      'human_rating', v_existing.human_rating,
      'effective_review_at', v_existing.effective_review_at,
      'replayed', true
    );
  end if;

  if not exists (
    select 1
    from public.problems problem
    where problem.id = p_problem_id
      and problem.user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'REVIEW_PROBLEM_NOT_OWNED';
  end if;

  if v_attempt_id is not null and not exists (
    select 1
    from public.attempts attempt
    where attempt.id = v_attempt_id
      and attempt.user_id = p_user_id
      and attempt.problem_id = p_problem_id
  ) then
    raise exception using errcode = '42501', message = 'REVIEW_ATTEMPT_NOT_OWNED';
  end if;

  if v_initial_idea_revision_id is not null and not exists (
    select 1
    from public.problem_initial_idea_revisions revision
    where revision.id = v_initial_idea_revision_id
      and revision.user_id = p_user_id
      and revision.problem_id = p_problem_id
  ) then
    raise exception using errcode = '42501', message = 'REVIEW_INITIAL_IDEA_NOT_OWNED';
  end if;

  if p_supersedes_event_id is null then
    insert into public.problem_review_occurrences (
      id,
      user_id,
      problem_id,
      attempt_id,
      reviewed_at,
      effective_review_at
    ) values (
      p_review_occurrence_id,
      p_user_id,
      p_problem_id,
      v_attempt_id,
      v_reviewed_at,
      v_effective_review_at
    );
  else
    select * into strict v_occurrence
    from public.problem_review_occurrences occurrence
    where occurrence.id = p_review_occurrence_id
      and occurrence.user_id = p_user_id
      and occurrence.problem_id = p_problem_id;

    if v_occurrence.reviewed_at <> v_reviewed_at
       or v_occurrence.effective_review_at <> v_effective_review_at
       or v_occurrence.attempt_id is distinct from v_attempt_id then
      raise exception using errcode = '23514', message = 'REVIEW_OCCURRENCE_MISMATCH';
    end if;
  end if;

  insert into public.problem_review_events (
    id,
    review_occurrence_id,
    user_id,
    problem_id,
    attempt_id,
    event_kind,
    human_rating,
    machine_correctness_snapshot,
    channel_source,
    device_id,
    source_request_id,
    reviewed_at,
    effective_review_at,
    initial_idea_revision_id,
    supersedes_event_id
  ) values (
    v_event_id,
    p_review_occurrence_id,
    p_user_id,
    p_problem_id,
    v_attempt_id,
    p_event_kind,
    p_human_rating,
    v_machine_correctness,
    p_channel_source,
    p_device_id,
    p_source_request_id,
    v_reviewed_at,
    v_effective_review_at,
    v_initial_idea_revision_id,
    p_supersedes_event_id
  ) returning * into v_existing;

  perform private.mark_problem_review_timeline_dirty(
    p_user_id,
    p_problem_id,
    v_effective_review_at
  );

  return jsonb_build_object(
    'event_id', v_existing.id,
    'review_occurrence_id', v_existing.review_occurrence_id,
    'problem_id', v_existing.problem_id,
    'event_kind', v_existing.event_kind,
    'human_rating', v_existing.human_rating,
    'effective_review_at', v_existing.effective_review_at,
    'replayed', false
  );
exception
  when unique_violation then
    if sqlerrm like '%problem_review_occurrences_pkey%' then
      raise exception using errcode = '23505', message = 'REVIEW_OCCURRENCE_EXISTS';
    end if;
    raise;
end;
$$;

revoke all on function private.mark_problem_review_timeline_dirty(
  uuid, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function private.record_problem_review_fact(
  uuid, uuid, uuid, uuid, uuid, text, text, boolean, text, uuid, text,
  timestamptz, uuid, uuid
) from public, anon, authenticated;
grant execute on function private.mark_problem_review_timeline_dirty(
  uuid, uuid, timestamptz
) to service_role;
grant execute on function private.record_problem_review_fact(
  uuid, uuid, uuid, uuid, uuid, text, text, boolean, text, uuid, text,
  timestamptz, uuid, uuid
) to service_role;

create or replace function public.record_problem_review_fact(
  p_event_id uuid,
  p_review_occurrence_id uuid,
  p_user_id uuid,
  p_problem_id uuid,
  p_attempt_id uuid,
  p_event_kind text,
  p_human_rating text,
  p_machine_correctness_snapshot boolean,
  p_channel_source text,
  p_device_id uuid,
  p_source_request_id text,
  p_reviewed_at timestamptz,
  p_initial_idea_revision_id uuid,
  p_supersedes_event_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.record_problem_review_fact(
    p_event_id,
    p_review_occurrence_id,
    p_user_id,
    p_problem_id,
    p_attempt_id,
    p_event_kind,
    p_human_rating,
    p_machine_correctness_snapshot,
    p_channel_source,
    p_device_id,
    p_source_request_id,
    p_reviewed_at,
    p_initial_idea_revision_id,
    p_supersedes_event_id
  );
$$;

revoke all on function public.record_problem_review_fact(
  uuid, uuid, uuid, uuid, uuid, text, text, boolean, text, uuid, text,
  timestamptz, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.record_problem_review_fact(
  uuid, uuid, uuid, uuid, uuid, text, text, boolean, text, uuid, text,
  timestamptz, uuid, uuid
) to service_role;

create or replace function private.append_web_problem_review_idea_revision(
  p_review_occurrence_id uuid,
  p_revision_kind text,
  p_idea text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_occurrence public.problem_review_occurrences%rowtype;
  v_current public.problem_review_idea_revisions%rowtype;
  v_inserted public.problem_review_idea_revisions%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_revision_kind not in ('set', 'clear')
     or (
       p_revision_kind = 'set'
       and (
         p_idea is null
         or btrim(p_idea) = ''
         or char_length(p_idea) > 4000
         or octet_length(p_idea) > 16000
       )
     )
     or (p_revision_kind = 'clear' and p_idea is not null) then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_IDEA_REVISION';
  end if;

  select * into v_occurrence
  from public.problem_review_occurrences occurrence
  where occurrence.id = p_review_occurrence_id
    and occurrence.user_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'REVIEW_OCCURRENCE_NOT_OWNED';
  end if;

  select * into v_current
  from public.problem_review_idea_revisions revision
  where revision.user_id = v_user_id
    and revision.review_occurrence_id = p_review_occurrence_id
  order by revision.revision desc
  limit 1;

  if found
     and v_current.revision_kind = p_revision_kind
     and v_current.idea is not distinct from p_idea then
    return jsonb_build_object(
      'review_occurrence_id', v_current.review_occurrence_id,
      'problem_id', v_current.problem_id,
      'revision_id', v_current.id,
      'revision', v_current.revision,
      'revision_kind', v_current.revision_kind,
      'idea', v_current.idea,
      'replayed', true
    );
  end if;

  insert into public.problem_review_idea_revisions (
    review_occurrence_id,
    user_id,
    problem_id,
    revision,
    revision_kind,
    idea,
    channel_source,
    idea_origin
  ) values (
    p_review_occurrence_id,
    v_user_id,
    v_occurrence.problem_id,
    coalesce(v_current.revision, 0) + 1,
    p_revision_kind,
    p_idea,
    'web',
    'user_typed'
  ) returning * into v_inserted;

  return jsonb_build_object(
    'review_occurrence_id', v_inserted.review_occurrence_id,
    'problem_id', v_inserted.problem_id,
    'revision_id', v_inserted.id,
    'revision', v_inserted.revision,
    'revision_kind', v_inserted.revision_kind,
    'idea', v_inserted.idea,
    'replayed', false
  );
end;
$$;

revoke all on function private.append_web_problem_review_idea_revision(
  uuid, text, text
) from public, anon;
grant execute on function private.append_web_problem_review_idea_revision(
  uuid, text, text
) to authenticated, service_role;

create or replace function public.set_problem_review_idea(
  p_review_occurrence_id uuid,
  p_revision_kind text,
  p_idea text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.append_web_problem_review_idea_revision($1, $2, $3);
$$;

revoke all on function public.set_problem_review_idea(uuid, text, text)
  from public, anon;
grant execute on function public.set_problem_review_idea(uuid, text, text)
  to authenticated, service_role;

create view public.effective_problem_review_events
with (security_invoker = true)
as
select event.*
from public.problem_review_events event
where not exists (
  select 1
  from public.problem_review_events correction
  where correction.supersedes_event_id = event.id
);

revoke all on table public.effective_problem_review_events
  from public, anon, authenticated;
grant select on table public.effective_problem_review_events to authenticated;
grant select on table public.effective_problem_review_events to service_role;

-- Existing v1 observations are genuine human verdicts. Preserve their stable
-- observation id as the occurrence/event id while leaving current SM-2 due
-- authority untouched.
insert into public.problem_review_occurrences (
  id,
  user_id,
  problem_id,
  attempt_id,
  reviewed_at,
  effective_review_at,
  created_at
)
select
  observation.id,
  observation.user_id,
  observation.problem_id,
  null,
  observation.occurred_at,
  least(observation.occurred_at, observation.created_at),
  observation.created_at
from public.problem_review_observations observation
on conflict (id) do nothing;

insert into public.problem_review_events (
  id,
  review_occurrence_id,
  user_id,
  problem_id,
  event_kind,
  human_rating,
  machine_correctness_snapshot,
  channel_source,
  device_id,
  source_request_id,
  reviewed_at,
  received_at,
  effective_review_at,
  created_at
)
select
  observation.id,
  observation.id,
  observation.user_id,
  observation.problem_id,
  case when observation.action = 'skip' then 'skip' else 'review' end,
  case observation.action
    when 'wrong' then 'Again'
    when 'hesitant' then 'Hard'
    when 'correct' then 'Good'
    else null
  end,
  null,
  case when observation.device_id is null then 'mcp' else 'device' end,
  observation.device_id,
  observation.request_id,
  observation.occurred_at,
  observation.created_at,
  least(observation.occurred_at, observation.created_at),
  observation.created_at
from public.problem_review_observations observation
on conflict (id) do nothing;

insert into public.problem_review_projection_jobs (
  user_id,
  problem_id,
  dirty_from,
  status,
  next_retry_at,
  updated_at
)
select
  event.user_id,
  event.problem_id,
  min(event.effective_review_at),
  'pending',
  now(),
  now()
from public.problem_review_events event
group by event.user_id, event.problem_id
on conflict (user_id, problem_id) do update
set dirty_from = least(
      public.problem_review_projection_jobs.dirty_from,
      excluded.dirty_from
    ),
    status = 'pending',
    lease_token = null,
    lease_until = null,
    next_retry_at = now(),
    last_error_code = null,
    updated_at = now();

create or replace function private.mirror_problem_review_observation_fact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_initial_idea_revision_id uuid;
begin
  select context.current_initial_idea_revision_id
  into v_initial_idea_revision_id
  from public.problem_user_contexts context
  where context.user_id = new.user_id
    and context.problem_id = new.problem_id;

  perform private.record_problem_review_fact(
    new.id,
    new.id,
    new.user_id,
    new.problem_id,
    null,
    case when new.action = 'skip' then 'skip' else 'review' end,
    case new.action
      when 'wrong' then 'Again'
      when 'hesitant' then 'Hard'
      when 'correct' then 'Good'
      else null
    end,
    null,
    case when new.device_id is null then 'mcp' else 'device' end,
    new.device_id,
    new.request_id,
    new.occurred_at,
    v_initial_idea_revision_id,
    null
  );

  return new;
end;
$$;

create trigger mirror_problem_review_observation_fact
after insert on public.problem_review_observations
for each row execute function private.mirror_problem_review_observation_fact();

revoke all on function private.mirror_problem_review_observation_fact()
  from public, anon, authenticated;
grant execute on function private.mirror_problem_review_observation_fact()
  to service_role;

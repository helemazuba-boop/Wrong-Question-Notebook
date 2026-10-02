-- Subject -> canonical subject mapping
--
-- A Problem can only be annotated when its Subject carries a canonical subject
-- key, because the annotation context is built from that key. The mapping lived
-- in a hardcoded CASE inside `map_subject_canonical_key()` and matched only the
-- eleven exact preset names, so any Subject the user named themselves — 高三物理,
-- Physics, 物理竞赛 — resolved to null and every Problem in it short-circuited
-- with `subject_unmapped` before any retrieval ran.
--
-- This replaces the CASE with a lookup table seeded from the Knowledge Registry
-- subject list (canonical names plus declared aliases), and adds a normalising
-- fallback for grade/edition qualifiers. The safety property is unchanged: an
-- authenticated client still cannot assert its own canonical key.

-- 1. Alias table --------------------------------------------------------------
create table public.subject_canonical_aliases (
  alias text primary key,
  canonical_key text not null
    references public.canonical_subjects(stable_key),
  source text not null default 'registry',
  constraint subject_canonical_aliases_source_check
    check (source in ('registry', 'manual'))
);

alter table public.subject_canonical_aliases enable row level security;
revoke all on table public.subject_canonical_aliases
  from public, anon, authenticated;
grant select on table public.subject_canonical_aliases
  to authenticated, service_role;
grant all on table public.subject_canonical_aliases to service_role;

-- Seeded from WQN-Knowledge-Registry registry/subjects.json: each canonical
-- name plus its declared aliases.
insert into public.subject_canonical_aliases (alias, canonical_key, source)
values
  ('语文', 'chinese', 'registry'),
  ('Chinese', 'chinese', 'registry'),
  ('数学', 'math', 'registry'),
  ('Mathematics', 'math', 'registry'),
  ('英语', 'english', 'registry'),
  ('English', 'english', 'registry'),
  ('English Vocabulary', 'english', 'registry'),
  ('物理', 'physics', 'registry'),
  ('Physics', 'physics', 'registry'),
  ('化学', 'chemistry', 'registry'),
  ('Chemistry', 'chemistry', 'registry'),
  ('生物', 'biology', 'registry'),
  ('Biology', 'biology', 'registry'),
  ('历史', 'history', 'registry'),
  ('History', 'history', 'registry'),
  ('地理', 'geography', 'registry'),
  ('Geography', 'geography', 'registry'),
  ('政治', 'politics', 'registry'),
  ('Politics', 'politics', 'registry'),
  ('信息技术', 'information_technology', 'registry'),
  ('Information Technology', 'information_technology', 'registry'),
  ('其他', 'other', 'registry'),
  ('Other', 'other', 'registry');

-- 2. Resolution ---------------------------------------------------------------
-- Exact alias first, then case-insensitive, then with grade/edition qualifiers
-- stripped, then the longest alias contained in the name. Returns null when
-- nothing matches, which is the honest answer for a genuinely unmappable name.
create or replace function public.resolve_canonical_subject_key(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_key text;
  v_stripped text;
begin
  if v_name = '' then
    return null;
  end if;

  select alias_row.canonical_key
  into v_key
  from public.subject_canonical_aliases alias_row
  where alias_row.alias = v_name;
  if v_key is not null then
    return v_key;
  end if;

  select alias_row.canonical_key
  into v_key
  from public.subject_canonical_aliases alias_row
  where lower(alias_row.alias) = lower(v_name);
  if v_key is not null then
    return v_key;
  end if;

  -- 高三物理 -> 物理, 人教版必修一数学 -> 数学
  v_stripped := regexp_replace(
    v_name,
    '(高三|高二|高一|初三|初二|初一|必修|选修|人教版|北师大版|苏教版|浙教版|上册|下册|[0-9]+年级)',
    '',
    'g'
  );
  v_stripped := regexp_replace(v_stripped, '[[:space:]]+', '', 'g');
  if v_stripped <> '' and v_stripped <> v_name then
    select alias_row.canonical_key
    into v_key
    from public.subject_canonical_aliases alias_row
    where lower(replace(alias_row.alias, ' ', '')) = lower(v_stripped);
    if v_key is not null then
      return v_key;
    end if;
  end if;

  -- 物理竞赛, 力学（物理）: fall back to the longest alias contained in the name.
  select alias_row.canonical_key
  into v_key
  from public.subject_canonical_aliases alias_row
  where position(alias_row.alias in v_name) > 0
  order by length(alias_row.alias) desc
  limit 1;

  return v_key;
end;
$$;

revoke all on function public.resolve_canonical_subject_key(text)
  from public, anon;
grant execute on function public.resolve_canonical_subject_key(text)
  to authenticated, service_role;

-- 3. Trigger ------------------------------------------------------------------
create or replace function public.map_subject_canonical_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Unchanged: a client must not assert its own canonical key.
    if (select auth.role()) = 'authenticated'
       and new.canonical_subject_key is not null then
      raise exception using
        errcode = '42501',
        message = 'CANONICAL_SUBJECT_KEY_MANAGED';
    end if;

    if new.canonical_subject_key is null then
      new.canonical_subject_key := public.resolve_canonical_subject_key(new.name);
    end if;
  elsif tg_op = 'UPDATE' then
    if (select auth.role()) = 'authenticated'
       and new.canonical_subject_key is distinct from old.canonical_subject_key then
      raise exception using
        errcode = '42501',
        message = 'CANONICAL_SUBJECT_KEY_MANAGED';
    end if;

    -- A rename re-derives the key only when the previous value was itself
    -- derived, so an explicit server-side assignment survives.
    if new.name is distinct from old.name then
      if new.canonical_subject_key is null
         or new.canonical_subject_key = public.resolve_canonical_subject_key(old.name) then
        new.canonical_subject_key :=
          public.resolve_canonical_subject_key(new.name);
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- Renames must re-derive too, so the trigger now watches `name` as well.
drop trigger if exists map_subject_canonical_key_before_write on public.subjects;
create trigger map_subject_canonical_key_before_write
before insert or update of name, canonical_subject_key on public.subjects
for each row execute function public.map_subject_canonical_key();

-- 4. Backfill -----------------------------------------------------------------
-- Only rows with no key are filled; an explicitly assigned key is left alone.
update public.subjects
set canonical_subject_key = public.resolve_canonical_subject_key(name)
where canonical_subject_key is null;

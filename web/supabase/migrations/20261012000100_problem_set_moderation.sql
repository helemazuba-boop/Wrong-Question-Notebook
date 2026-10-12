alter table public.problem_sets
  add column moderation_status text not null default 'visible' check (moderation_status in ('visible', 'hidden')),
  add column moderation_message text,
  add column moderation_previous_sharing_level public.sharing_level,
  add column moderation_previous_is_listed boolean;
alter table public.problem_set_reports
  add column target_title text,
  add column result_message text,
  add column resolution_action text check (resolution_action in ('dismiss', 'hide', 'restore')),
  add column reviewed_at timestamptz,
  add column reviewed_by_user_id uuid references auth.users(id) on delete set null,
  add column previous_sharing_level public.sharing_level,
  add column previous_is_listed boolean;
alter table public.problem_set_reports alter column problem_set_id drop not null;
alter table public.problem_set_reports drop constraint problem_set_reports_problem_set_id_fkey;
alter table public.problem_set_reports add constraint problem_set_reports_problem_set_id_fkey
  foreign key (problem_set_id) references public.problem_sets(id) on delete set null;

-- Capture a title only through the caller's visibility; reporting a guessed
-- private identifier must not reveal its owner's metadata.
create function public.capture_report_title() returns trigger
language plpgsql set search_path = '' as $$
begin
  select name into new.target_title from public.problem_sets where id = new.problem_set_id;
  if new.target_title is null then raise exception 'report_target_not_accessible' using errcode = '42501'; end if;
  return new;
end $$;
revoke all on function public.capture_report_title() from public, anon, authenticated;
create trigger capture_report_title before insert on public.problem_set_reports
for each row execute function public.capture_report_title();
alter policy problem_set_reports_insert_policy on public.problem_set_reports with check (
  reporter_user_id = (select auth.uid()) and status = 'pending'
  and result_message is null and reviewed_at is null and reviewed_by_user_id is null
  and resolution_action is null and previous_sharing_level is null and previous_is_listed is null
  and exists (select 1 from public.problem_sets where id = problem_set_id));

create function public.guard_set_moderation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.moderation_status <> 'visible' or new.moderation_message is not null
        or new.moderation_previous_sharing_level is not null or new.moderation_previous_is_listed is not null then
        raise exception 'protected_moderation_fields' using errcode = '42501';
      end if;
    elsif new.moderation_status is distinct from old.moderation_status
       or new.moderation_message is distinct from old.moderation_message
       or new.moderation_previous_sharing_level is distinct from old.moderation_previous_sharing_level
       or new.moderation_previous_is_listed is distinct from old.moderation_previous_is_listed then
      raise exception 'protected_moderation_fields' using errcode = '42501';
    end if;
  end if;
  if new.moderation_status = 'hidden' and (new.sharing_level <> 'private' or new.is_listed) then
    raise exception 'sharing_paused_by_moderation' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_set_moderation() from public, anon, authenticated;
create trigger guard_set_moderation before insert or update on public.problem_sets
for each row execute function public.guard_set_moderation();

-- Service-only, actor-bound, serialized resolution. Keep content intact when
-- removing sharing, and retain the report outcome after its target is deleted.
create function public.resolve_problem_set_report(
  p_report_id uuid, p_actor_user_id uuid, p_action text, p_message text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare report public.problem_set_reports; target public.problem_sets;
begin
  if not exists (select 1 from public.user_profiles where id = p_actor_user_id
    and is_active is true and user_role in ('moderator', 'admin', 'super_admin')) then
    raise exception 'moderation_permission_denied' using errcode = '42501';
  end if;
  if p_action not in ('dismiss', 'hide', 'restore') or p_message is null
     or length(btrim(p_message)) not between 1 and 1000 then
    raise exception 'invalid_moderation_resolution' using errcode = '22023';
  end if;
  select * into report from public.problem_set_reports where id = p_report_id for update;
  if not found then raise exception 'report_not_found' using errcode = 'P0002'; end if;
  if report.resolution_action = p_action and report.result_message = btrim(p_message)
    and report.reviewed_by_user_id = p_actor_user_id then
    return jsonb_build_object('id', report.id, 'problem_set_id', report.problem_set_id, 'status', report.status);
  end if;
  select * into target from public.problem_sets where id = report.problem_set_id for update;
  if target.user_id = p_actor_user_id then
    raise exception 'cannot_moderate_own_content' using errcode = '42501';
  end if;
  if p_action = 'restore' then
    if report.resolution_action is distinct from 'hide' then
      raise exception 'report_not_restorable' using errcode = '40001';
    end if;
    update public.problem_set_reports set resolution_action = 'restore'
      where id = p_report_id;
    if target.id is not null and not exists (select 1 from public.problem_set_reports
      where problem_set_id = target.id and resolution_action = 'hide') then
      update public.problem_sets set moderation_status = 'visible', moderation_message = null,
        sharing_level = coalesce(target.moderation_previous_sharing_level, report.previous_sharing_level, 'private'),
        is_listed = coalesce(target.moderation_previous_is_listed, report.previous_is_listed, false),
        moderation_previous_sharing_level = null, moderation_previous_is_listed = null where id = target.id;
    end if;
  else
    if report.status <> 'pending' then raise exception 'report_already_processed' using errcode = '40001'; end if;
    if p_action = 'hide' then
      if target.id is null then raise exception 'report_target_deleted' using errcode = 'P0002'; end if;
      update public.problem_set_reports set previous_sharing_level = coalesce(target.moderation_previous_sharing_level, target.sharing_level),
        previous_is_listed = coalesce(target.moderation_previous_is_listed, target.is_listed) where id = p_report_id;
      update public.problem_sets set moderation_status = 'hidden', moderation_message = btrim(p_message),
        moderation_previous_sharing_level = coalesce(target.moderation_previous_sharing_level, target.sharing_level),
        moderation_previous_is_listed = coalesce(target.moderation_previous_is_listed, target.is_listed),
        sharing_level = 'private', is_listed = false where id = target.id;
    end if;
  end if;
  update public.problem_set_reports set status = case when p_action = 'dismiss' then 'dismissed' else 'reviewed' end,
    resolution_action = p_action, result_message = btrim(p_message), reviewed_at = now(),
    reviewed_by_user_id = p_actor_user_id where id = p_report_id returning * into report;
  insert into public.user_activity_log (user_id, action, resource_type, resource_id, details)
    values (p_actor_user_id, 'moderation.' || p_action, 'problem_set_report', p_report_id,
      jsonb_build_object('problem_set_id', report.problem_set_id, 'message', btrim(p_message)));
  return jsonb_build_object('id', report.id, 'problem_set_id', report.problem_set_id, 'status', report.status);
end $$;
revoke all on function public.resolve_problem_set_report(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.resolve_problem_set_report(uuid, uuid, text, text) to service_role;

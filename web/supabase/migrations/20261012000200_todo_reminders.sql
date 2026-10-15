create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 4096),
  p256dh text not null,
  auth text not null,
  locale text not null default 'zh-CN' check (locale in ('en','zh-CN')),
  created_at timestamptz not null default now()
);
create table public.todo_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  todo_id uuid not null references public.todos(id) on delete cascade,
  reminder_at timestamptz not null,
  title text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique(todo_id, reminder_at)
);
create table public.todo_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.todo_notifications(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','sending','sent','failed','cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text,
  sent_at timestamptz,
  unique(notification_id,subscription_id)
);
create index todo_due_reminders on public.todos(reminder_at, id) where status='pending' and reminder_at is not null;
create index todo_push_pending on public.todo_push_deliveries(next_attempt_at) where status in ('pending','sending');
alter table public.push_subscriptions enable row level security;
alter table public.todo_notifications enable row level security;
alter table public.todo_push_deliveries enable row level security;
revoke all on public.push_subscriptions, public.todo_notifications, public.todo_push_deliveries from anon, authenticated;
grant all on public.push_subscriptions, public.todo_notifications, public.todo_push_deliveries to service_role;
grant select on public.todo_notifications to authenticated;
grant select(id, notification_id, status) on public.todo_push_deliveries to authenticated;
grant update(read_at) on public.todo_notifications to authenticated;
create policy own_reminders on public.todo_notifications for select to authenticated using(user_id=auth.uid() and public.is_account_active());
create policy read_own_reminders on public.todo_notifications for update to authenticated using(user_id=auth.uid() and public.is_account_active()) with check(user_id=auth.uid() and public.is_account_active());
create policy own_push_results on public.todo_push_deliveries for select to authenticated using(exists(select 1 from public.todo_notifications n where n.id=notification_id and n.user_id=auth.uid()) and public.is_account_active());

-- No application-side scan limit can silently starve older due reminders.
-- A bounded transaction drains the oldest eligible todos first on each tick.
create function public.enqueue_todo_reminders(p_limit integer default 200) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.todo_notifications(user_id,todo_id,reminder_at,title)
  select t.user_id,t.id,t.reminder_at,t.title from public.todos t
  join public.user_profiles p on p.id=t.user_id and p.is_active
  where t.status='pending' and t.reminder_at<=now()
    and not exists(select 1 from public.todo_notifications r where r.todo_id=t.id and r.reminder_at=t.reminder_at)
  order by t.reminder_at,t.id limit least(greatest(p_limit,1),1000)
  on conflict(todo_id,reminder_at) do nothing;
  get diagnostics n=row_count;
  insert into public.todo_push_deliveries(notification_id,subscription_id)
  select r.id,s.id from public.todo_notifications r
  join public.todos t on t.id=r.todo_id and t.status='pending' and t.reminder_at=r.reminder_at
  join public.user_profiles p on p.id=r.user_id and p.is_active
  join public.push_subscriptions s on s.user_id=r.user_id
  where r.created_at>=s.created_at and r.created_at>now()-interval '1 day'
  on conflict(notification_id,subscription_id) do nothing;
  return n;
end $$;

create function public.claim_todo_push_deliveries(p_limit integer default 30) returns setof public.todo_push_deliveries
language sql security definer set search_path='' as $$
  with candidates as (
    select d.id from public.todo_push_deliveries d
    where (d.status='pending' and d.next_attempt_at<=now()) or (d.status='sending' and d.lease_until<now())
    order by d.next_attempt_at,d.id for update skip locked limit least(greatest(p_limit,1),100)
  ) update public.todo_push_deliveries d
    set status='sending', attempts=d.attempts+1, lease_id=gen_random_uuid(), lease_until=now()+interval '2 minutes'
    from candidates c where d.id=c.id returning d.*;
$$;
revoke all on function public.enqueue_todo_reminders(integer), public.claim_todo_push_deliveries(integer) from public,anon,authenticated;
grant execute on function public.enqueue_todo_reminders(integer), public.claim_todo_push_deliveries(integer) to service_role;

create function public.register_push_subscription(p_user_id uuid,p_endpoint text,p_p256dh text,p_auth text,p_locale text) returns uuid
language plpgsql security definer set search_path='' as $$
declare subscription_id uuid;
begin
  if not exists(select 1 from public.user_profiles where id=p_user_id and is_active) then raise exception 'account_inactive' using errcode='42501'; end if;
  insert into public.push_subscriptions(user_id,endpoint,p256dh,auth,locale) values(p_user_id,p_endpoint,p_p256dh,p_auth,p_locale)
  on conflict(endpoint) do update set p256dh=excluded.p256dh,auth=excluded.auth,locale=excluded.locale
    where public.push_subscriptions.user_id=excluded.user_id returning id into subscription_id;
  if subscription_id is null then raise exception 'subscription_owner_conflict' using errcode='42501'; end if;
  return subscription_id;
end $$;
revoke all on function public.register_push_subscription(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.register_push_subscription(uuid,text,text,text,text) to service_role;

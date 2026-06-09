alter table public.word_decks
  add column if not exists subject_id uuid references public.subjects(id) on delete set null,
  add column if not exists lexicon_type text not null default 'english_word';

alter table public.word_decks
  drop constraint if exists word_decks_lexicon_type_check;

alter table public.word_decks
  add constraint word_decks_lexicon_type_check
  check (lexicon_type in ('english_word', 'classical_chinese_term'));

create index if not exists idx_word_decks_subject_updated
  on public.word_decks(subject_id, updated_at desc)
  where archived_at is null;

update public.word_decks
set
  title = 'WQN 预设词库',
  description = '系统预设词库，当前为空',
  language = 'en',
  target_language = 'zh-CN',
  lexicon_type = 'english_word',
  is_active = true,
  archived_at = null,
  updated_at = now()
where source = 'system'
  and is_system = true
  and user_id is null
  and title in (
    'WQN 预设词库',
    'WQN 棰勮璇嶅簱',
    'WQN 妫板嫯顔曠拠宥呯氨'
  );

insert into public.word_decks (
  user_id,
  title,
  description,
  source,
  language,
  target_language,
  lexicon_type,
  is_system,
  is_active,
  metadata
)
select
  null,
  'WQN 预设词库',
  '系统预设词库，当前为空',
  'system',
  'en',
  'zh-CN',
  'english_word',
  true,
  true,
  '{}'::jsonb
where not exists (
  select 1
  from public.word_decks
  where source = 'system'
    and is_system = true
    and user_id is null
    and title = 'WQN 预设词库'
    and archived_at is null
);

drop policy if exists word_decks_owner_insert on public.word_decks;
create policy word_decks_owner_insert on public.word_decks
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and source in ('user', 'import', 'ai')
  and is_system = false
  and (
    subject_id is null
    or exists (
      select 1 from public.subjects s
      where s.id = subject_id
        and s.user_id = (select auth.uid())
    )
  )
);

drop policy if exists word_decks_owner_update on public.word_decks;
create policy word_decks_owner_update on public.word_decks
for update to authenticated
using (
  user_id = (select auth.uid())
  and is_system = false
)
with check (
  user_id = (select auth.uid())
  and source in ('user', 'import', 'ai')
  and is_system = false
  and (
    subject_id is null
    or exists (
      select 1 from public.subjects s
      where s.id = subject_id
        and s.user_id = (select auth.uid())
    )
  )
);

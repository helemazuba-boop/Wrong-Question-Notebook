do $$
begin
  update public.word_decks
  set
    title = 'WQN 预设词库',
    description = '系统预设词库，当前为空。',
    language = 'en',
    target_language = 'zh-CN',
    is_active = true,
    archived_at = null,
    updated_at = now()
  where source = 'system'
    and is_system = true
    and user_id is null
    and (
      title = 'WQN 棰勮璇嶅簱'
      or title = 'WQN 预设词库'
      or description like '%绯荤粺%'
      or description is null
    );

  if not found then
    insert into public.word_decks (
      user_id,
      title,
      description,
      source,
      language,
      target_language,
      is_system,
      is_active,
      metadata
    )
    values (
      null,
      'WQN 预设词库',
      '系统预设词库，当前为空。',
      'system',
      'en',
      'zh-CN',
      true,
      true,
      '{}'::jsonb
    );
  end if;
end $$;

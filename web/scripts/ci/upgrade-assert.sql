do $$
begin
  if not exists (
    select 1 from public.notebook_notes n join public.notebooks b on b.id = n.notebook_id
    where n.id = 'f0000000-0000-4000-8000-000000000004'
      and n.user_id = 'f0000000-0000-4000-8000-000000000001'
      and n.content = 'Existing content must survive upgrades'
      and b.title = 'Existing notebook'
  ) then
    raise exception 'Migration lost or changed existing notebook data';
  end if;
end $$;

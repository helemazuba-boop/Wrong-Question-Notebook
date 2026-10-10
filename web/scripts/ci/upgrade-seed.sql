insert into auth.users (id, email) values
  ('f0000000-0000-4000-8000-000000000001', 'migration-sentinel@example.invalid');
insert into public.subjects (id, user_id, name) values
  ('f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 'Migration sentinel');
insert into public.notebooks (id, user_id, subject_id, title) values
  ('f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 'Existing notebook');
insert into public.notebook_notes (id, user_id, notebook_id, title, content) values
  ('f0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000003', 'Existing note', 'Existing content must survive upgrades');

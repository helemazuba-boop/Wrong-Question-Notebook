-- Reconcile the study_sessions v2 CHECK constraints to the note ordering enum.
--
-- 20260724000100_note_study_v1.sql was edited in place (recently_updated_v1 ->
-- least_recently_viewed_v1) after it had already been applied to the linked
-- database. Supabase tracks migrations by version, not content, so the edit
-- never re-ran: the deployed study_sessions_ordering_v2_check and
-- study_sessions_semantics_v2_check still allow only recently_updated_v1. The
-- server now creates note sessions with ordering=least_recently_viewed_v1, so
-- INSERT fails with 23514 and the route wraps it as 503 NOTE_STUDY_UNAVAILABLE.
--
-- This forward migration drops and re-adds both constraints with the current
-- enum, matching 20260724000100 verbatim. It is idempotent and a no-op on any
-- database already carrying least_recently_viewed_v1.

alter table public.study_sessions drop constraint if exists study_sessions_ordering_v2_check;
alter table public.study_sessions add constraint study_sessions_ordering_v2_check
  check (ordering in ('sequential', 'guided_random_v1', 'lexicographic', 'sequential_note_v1', 'least_recently_viewed_v1'));

alter table public.study_sessions drop constraint if exists study_sessions_semantics_v2_check;
alter table public.study_sessions add constraint study_sessions_semantics_v2_check check (
  (domain = 'word' and (
    (mode = 'sequential' and purpose = 'study' and ordering = 'sequential')
    or (mode = 'random' and purpose = 'study' and ordering = 'guided_random_v1')
    or (mode = 'dictionary' and purpose = 'lookup' and ordering = 'lexicographic')
  ))
  or (domain = 'note' and (
    (mode = 'sequential' and purpose = 'browse' and ordering = 'sequential_note_v1')
    or (mode = 'recent' and purpose = 'browse' and ordering = 'least_recently_viewed_v1')
  ))
);

alter table public.user_profiles add column onboarding_scenario text check(onboarding_scenario in ('problems','notes','words'));
alter table public.user_profiles add column onboarding_dismissed_at timestamptz;
grant update(onboarding_scenario,onboarding_dismissed_at) on public.user_profiles to authenticated;

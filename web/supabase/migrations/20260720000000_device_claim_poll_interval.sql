-- Keep physical-approval polling comfortably below the shared ingress and
-- application rate limits. Existing active claims are short-lived, but update
-- them as well so a rolling firmware deployment receives the safer interval.

alter table public.device_claims
  alter column poll_interval_ms set default 10000;

update public.device_claims
set poll_interval_ms = 10000,
    updated_at = now()
where status in ('pending', 'approved')
  and poll_interval_ms < 10000;

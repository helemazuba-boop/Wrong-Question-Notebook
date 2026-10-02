## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run prepush` passes locally (CI runs the same checks on this PR)
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` for user-facing changes
- [ ] Schema changes: the migration is in `web/supabase/migrations/` and `web/lib/database.types.ts` is regenerated
- [ ] Device contract changes: the schema under `web/contracts/` changed together with its `manifest.json` digest and the firmware-side copy
- [ ] Deploy script changes: `deploy/tests/run.sh` passes

## Notes for reviewers

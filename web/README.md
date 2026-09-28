# WQN Web

The Next.js application: the localized web UI, the web/AI/device API, and the
database migrations. Everything in this directory runs cloud-side; the Note4
firmware lives in its own repository and talks to `app/api/esp32/` only.

## Getting started

Setup, the database workflow, and the deployment runbook live at the repository
root: [`../CONTRIBUTING.md`](../CONTRIBUTING.md). The short version:

```bash
npx supabase start
cp env.example .env.local   # fill in the values `supabase start` prints
npm run dev
```

`npm install` also installs the git hooks; the pre-commit hook runs ESLint and
the Prettier check.

## Commands

| Command                | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Dev server (Turbopack)                       |
| `npm run test`         | Vitest                                       |
| `npm run type-check`   | TypeScript, strict mode                      |
| `npm run lint`         | ESLint                                       |
| `npm run format:check` | Prettier check                               |
| `npm run check:i18n`   | Translation key parity and ICU validity      |
| `npm run prepush`      | The full local gate: fix, check, test, build |

## Where things live

| Path                   | What                                                 |
| ---------------------- | ---------------------------------------------------- |
| `app/[locale]/`        | Localized UI (next-intl)                             |
| `app/api/`             | Web, AI, and ESP32 device APIs                       |
| `lib/`                 | Domain logic: FSRS, marks, study services, MCP tools |
| `contracts/`           | Device contracts: schema, manifest, golden fixtures  |
| `supabase/migrations/` | Database schema, RLS, and RPCs                       |
| `messages/`            | Translations (`en` is the source locale)             |

Boundaries that must not be crossed are in [`../ARCHITECTURE.md`](../ARCHITECTURE.md);
each contract directory documents its own wire vocabulary, and
[`../CHANGELOG.md`](../CHANGELOG.md) records why things changed.

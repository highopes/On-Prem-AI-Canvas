# AGENTS.md

## Stack
- Next.js (App Router) + TypeScript
- Package manager: pnpm

## Commands
- Install: pnpm install
- Lint: pnpm lint
- Build: pnpm build
- Dev: pnpm dev

## Rules
- Never commit secrets (tokens, keys). Keep them in /etc/*.env on the server.
- Prefer small PRs that are easy to review.
- If you add or change env vars, update README.md.


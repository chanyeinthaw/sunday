# Project instructions

Read HANDOVER.md before implementing features.

- One pnpm package; Bun runtime and compiled single-binary release.
- Effect v4, TypeScript 7, Effect tsgo, Oxlint, and Oxfmt.
- Use Effect.gen for sequential workflows, Effect.fn for named operations, Context.Service and Layer for services, Config for configuration, and Schema at external boundaries.
- Use Effect HTTP, RPC, AI, Schedule, and Stream modules where applicable. Inspect the pinned package source before assuming an API.
- Current AI imports are effect/ai, not effect/unstable/ai.
- Keep provider choice configurable; no provider is selected yet.
- No any, unchecked casts, unnecessary abstractions, or tautological tests.
- Write focused tests for real behavior when integrations are implemented.
- Do not run browser tests unless requested.
- Friday's copied lint plugins are reference tooling; preserve their rules.
- Run pnpm verify and pnpm build after relevant changes.
- Use current upstream T3 APIs; do not modify or fork T3 Code.
- Do not touch live T3 state, configured services, or production without explicit authorization.
- When delegation is appropriate, select a configured subagent profile and pass fork_turns="none" with complete context.

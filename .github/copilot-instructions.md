# VS Code Workspace Instructions

These are the primary workspace instructions for the VS Code repo. Keep them concise, and follow more specific guidance from matching files under `.github/instructions/`, relevant skill files, and any closer `AGENTS.md` files in subfolders.

## Codebase Map

- `src/`: main TypeScript source, with many unit tests in `src/vs/*/test/`
- `extensions/`: built-in extensions that ship with VS Code
- `build/`: build, lint, and CI scripts
- `test/`: unit, integration, smoke, and automation test infrastructure
- `src/vs/sessions/`: sessions-first app layer that may import `vs/workbench`, but `vs/workbench` must never import back into `vs/sessions`

Useful references:

- `README.md` and `CONTRIBUTING.md` for contributor workflow
- `test/README.md`, `test/unit/README.md`, `test/integration/browser/README.md`, and `test/smoke/README.md` for test entry points
- `src/vs/sessions/README.md` and `src/vs/sessions/contrib/remoteAgentHost/ARCHITECTURE.md` for sessions-specific architecture
- `doc/2026-03-21-ai-ide-ui-trimming-spec.md`, `doc/2026-03-22-opencode-native-chat-ui_plan.md`, and `doc/2026-03-22-opencode-native-chat-ui.md` for the AI IDE product definition and implementation roadmap

## AI IDE Product Direction

- Treat the product as a single OSS workbench shell, not a dual-shell app.
- `Editor Mode` is the baseline OSS experience; `Agent Mode` is an AI-first layout mode inside that same shell.
- Do not treat `src/vs/sessions` as the final product shell. It is a reference implementation and a source of reusable agent/session/chat pieces.
- When building AI-first experiences, preserve a clean boundary between workbench shell concerns, agent session domain state, and view adapters.
- Follow the decision records in the `doc/` specs before introducing new architecture for chat, session, mode switching, or OpenCode integration.

## AI IDE Technical Path

- Phase 1 should favor reuse of existing OSS chat/session/workbench capabilities to validate the experience quickly.
- New `Agent Mode` surfaces must not depend on OSS chat internals as their source of truth; shared state should live in an integration-owned agent session domain.
- If the experience remains primarily linear chat, reuse of existing chat views is acceptable.
- If sub-agents, approvals, plans, outputs, or execution state become first-class timeline objects, plan for a custom conversation view instead of overextending the existing chat adapter.
- For OpenCode integration, prefer a single backend process per VS Code window and route multiple sessions through it; do not design around one backend process per chat session.

## Validation Before Tests

Always check for compilation errors before running tests or declaring the work done.

- Prefer the `VS Code - Build` watch task to validate core sources and built-in extensions incrementally.
- Never use `npm run compile` as a TypeScript validation step.
- If only `src/` changed and the watch task is unavailable, use `npm run compile-check-ts-native`.
- If `extensions/` changed and the watch task is unavailable, use `npm run gulp compile-extensions`.
- If `build/` changed, run `npm run typecheck` in `build/`.
- Run `npm run valid-layers-check` when imports, layering, or module boundaries may be affected.

On Windows, prefer `scripts\test.bat` and `scripts\test-integration.bat` when running tests directly.

## Repository Conventions

- Use tabs, not spaces.
- Use `camelCase` for functions, methods, properties, and locals; use `PascalCase` for types and enums.
- Use 'single quotes' for normal strings.
- User-facing strings must be localized via `vs/nls`, use "double quotes", and use placeholders instead of string concatenation.
- Prefer top-level `export function` declarations over exported arrow-function constants when practical.
- Keep local imports relative and include the `.js` or `.css` extension for ESM-compatible imports.
- Avoid `any` and `unknown` unless absolutely necessary.
- Reuse existing helpers and patterns before adding new abstractions or duplicated code.

## Architecture and API Rules

- Respect the layering direction: `base` → `platform` → `editor` → `workbench` → `sessions`.
- Service constructor parameters come first; non-service constructor parameters follow them.
- Prefer direct service calls over using events as control flow.
- Register disposables immediately with the right owner, typically via `DisposableStore`, `MutableDisposable`, or related helpers.
- Use `IEditorService` instead of `IEditorGroupsService.activeGroup.openEditor`.
- Do not reuse another component's storage keys to control that component.
- When adding watchers, prefer correlated watchers via `fileService.createWatcher`.
- When adding tooltips, prefer `IHoverService`.

## Testing Guidance

- Add tests to the nearest existing suite and follow local test structure and naming conventions.
- Keep tests consistent with nearby files; do not create a new style when an existing one is already established.
- Prefer a small number of clear assertions, and favor snapshot-style `assert.deepStrictEqual` when it improves readability.
- Remember that integration tests live outside the main unit-test path; many extension tests and `*.integrationTest.ts` files use the integration runners instead.

## Working Efficiently

- Search semantically first, then use exact text search for symbols, error messages, or specific APIs.
- Follow imports and nearby tests before inventing new patterns.
- Link to existing documentation instead of copying it into new instruction files or comments.

## Learnings

- Minimize the amount of assertions in tests. Prefer one snapshot-style `assert.deepStrictEqual` over multiple precise assertions, as they are much more difficult to understand and to update.

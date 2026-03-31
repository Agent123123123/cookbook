# Agent Mode Conversation Refactor Plan

## Decision Record

- Decision date: 2026-03-28
- Scope: `Agent Mode` main conversation surface and `Editor Mode` compact chat sidebar
- Goal: make the conversation experience feel closer to OSS chat and Codex-style agent chat
- Primary shift: move from an event-first timeline to a conversation-first, turn-first reading model

## Problem Statement

The current `Agent Mode` conversation surface is too timeline-first. It exposes too many execution objects as peer cards in the main reading flow, which pulls attention away from the actual conversation with the agent.

This shows up in several places:

- `agentTimelineRenderer.ts` renders `reasoning`, `command`, `tool`, `patch`, `approval`, and `status` as top-level siblings of user and assistant messages.
- `reasoning` is a standalone card instead of an attachment to an assistant turn.
- `command` and `tool` cards expose too much detail by default.
- `step-finish` is rendered as an `Execution summary` card even though it is mostly developer-facing state.
- `approval` is clearer than before, but it still lives only inside the main timeline and can be missed.

Relevant implementation anchors:

- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentSessionService.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeEditorSurface.contribution.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeCompactChatViewPane.ts`
- `src/vs/workbench/contrib/agentMode/browser/media/agentModeEditorSurface.css`

## Product Direction

The target experience should align with two reference directions:

- OSS chat: thinking and tool progress are present, but they are treated as secondary execution context with collapsed and simplified presentation.
- Codex-style chat: the conversation remains primary, execution details remain inspectable, and blocking decisions are obvious without turning the main reading flow into a system event log.

This means the user should usually see:

- their prompt
- the assistant response
- pending approval when action is required
- a compact patch summary when files changed

The user should not usually see:

- a full card for every command
- a full card for every tool result
- a full `step finished` card
- verbose raw details unless they explicitly ask for them

## Evidence From Existing OSS Chat

OSS chat already encodes the right direction in configuration and rendering behavior:

- `chat.agent.thinkingStyle` supports `collapsed`, `collapsedPreview`, and `fixedScrolling`.
- `chat.agent.thinking.collapsedTools` supports collapsing tool calls into thinking.
- `chat.agent.terminalToolsInThinking` and `chat.tools.terminal.simpleCollapsible` support simplified terminal tool presentation.

Relevant file:

- `src/vs/workbench/contrib/chat/browser/chat.contribution.ts`

The implication is clear: thinking and tool execution are useful, but they are not supposed to dominate the primary conversation flow.

## Design Principles

1. Conversation first
- The assistant reply is the primary artifact.
- Execution details are supporting evidence, not the main content.

2. Decision visibility over system visibility
- If the user must act, that state should be prominent.
- If the system is merely progressing normally, that state should be quiet.

3. Summary by default, detail on demand
- Successful execution details should start collapsed.
- Failure details should auto-expand when needed.

4. Preserve inspectability
- Nothing important should become inaccessible.
- Raw data, stdout, stderr, and request payloads should still exist behind explicit disclosure.

5. Shared behavior across surfaces
- `Agent Mode` and compact sidebar chat should use the same information hierarchy and the same renderer rules.

6. Fewer implementation terms in user-facing UI
- Prefer task language over internal lifecycle language such as `step`, `process`, or `tool lifecycle`.

## Current UX Issues

### 1. Flat item rendering gives execution cards too much weight

`renderAgentTimelineNode(...)` currently routes almost every non-message item into a top-level card. This makes the conversation feel like an execution log.

Current behavior:

- `reasoning` -> `renderReasoningCard`
- `approval` -> `renderApprovalCard`
- everything else except `user` and `assistant` -> `renderProcessCard`

Effect:

- the screen rhythm is dominated by system cards rather than conversational turns
- scanning the conversation takes too much effort

File:

- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`

### 2. Reasoning is too prominent

`reasoning` is currently a standalone block with its own row and its own expandable card. This gives internal thinking nearly the same visual priority as the assistant response.

File:

- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`

### 3. Command and tool cards are too verbose by default

`command` and `tool` cards currently expose body text, detail grids, code blocks, sections, raw details, meta pills, bullet lists, and actions in the primary timeline. That is too much default surface area for successful execution.

File:

- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`

### 4. `step-finish` is visible at the wrong level

`_createStepFinishItem(...)` currently creates a visible `status` item with:

- label: `Step finished`
- title: `Execution summary`

This is useful for debugging and auditing, but it is usually not useful as a top-level conversation element for end users.

File:

- `src/vs/workbench/contrib/agentMode/browser/agentSessionService.ts`

### 5. Approval can still be missed

The approval card is now much better than before, but it still relies too much on the user noticing the right place in the timeline. Blocking decisions should also surface near the composer.

Files:

- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeEditorSurface.contribution.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeCompactChatViewPane.ts`

## Target Experience

The conversation should feel like a sequence of turns, not a raw event stream.

Each assistant turn should be read in this order:

1. assistant reply
2. any pending approval that blocks further work
3. a compact summary of work performed
4. expandable details only if the user asks for them

The user should experience the surface as:

- "What did the agent say?"
- "What changed?"
- "Do I need to approve something?"
- "If I want to inspect the execution, I can."

Not as:

- "What system event happened next?"

## Target Information Hierarchy

### Tier 1: Primary conversation

- user message
- assistant message

These are always visible and visually dominant.

### Tier 2: Actionable turn attachments

- pending approval
- patch summary

These are visible when present, but subordinate to the assistant message.

### Tier 3: Execution attachments

- reasoning
- command summary
- tool summary
- execution metadata

These are collapsed by default once the agent has moved on.

### Tier 4: Inspection details

- stdout
- stderr
- raw JSON
- request payloads
- cost and token details
- full path scope

These are hidden by default and revealed only when needed.

## Item-by-Item Presentation Rules

| Item type | Default treatment | Expanded treatment | Notes |
|---|---|---|---|
| `user` | always visible | n/a | unchanged |
| `assistant` | always visible | n/a | primary artifact |
| `reasoning` | collapsed attachment | full markdown reasoning | auto-open only while live |
| `command` | one-line summary | command, stdout, stderr, raw details, actions | auto-expand on failure |
| `tool` | one-line summary | arguments, result summary, raw details | auto-expand on failure |
| `patch` | compact result summary | changed files and diff-related actions | do not open file list by default |
| `approval` | expanded while pending | full scope, raw details, actions | highest-priority system card |
| `step-finish` | hidden by default | footer/debug only | show only when exceptional |
| generic `status` | footer/debug only | structured details | keep out of primary reading flow |

## Key UX Changes

### 1. Move to turn-first rendering

The renderer should stop treating the conversation as a flat list of unrelated items. Instead it should group items into conversation turns centered around assistant replies.

Each turn should contain:

- optional user message
- optional assistant message
- attachments
- footer metadata

This is the foundation for everything else.

### 2. Collapse reasoning into the assistant turn

Reasoning should no longer stand as a full peer card in the timeline.

New behavior:

- while live: show lightweight `Thinking...` state or a compact expanding panel
- after the assistant reply stabilizes: collapse reasoning into a small attachment row
- keep reasoning inspectable, but no longer visually dominant

### 3. Collapse successful command and tool work

Successful execution should not be loud.

New behavior:

- show a single summary line such as:
  - `Ran git status --short`
  - `Searched 3 files`
  - `Fetched webpage`
- show richer sections only on expand
- auto-expand when:
  - the command failed
  - stderr exists
  - the tool result indicates failure

### 4. Demote `step-finish`

`step-finish` should stop producing a standalone visible card for normal completion.

New behavior:

- hidden in normal successful flows
- optionally stored as:
  - assistant turn footer metadata
  - debug/inspection data
- elevated only for:
  - failed
  - cancelled
  - unusually expensive
  - otherwise exceptional completion

### 5. Keep patch visible, but summary-first

Patch information matters to users, but it should still be concise.

New behavior:

- show a summary such as `Edited 3 files`
- optionally include a short result sentence
- keep `Open Diff` visible
- hide file-by-file details behind disclosure

### 6. Dual-channel approval

Approval should remain in the conversation, but also surface at the point of interaction.

New behavior:

- keep approval card in the turn where it belongs
- add a lightweight blocking banner near the composer:
  - `Permission required: run git status --short`
- clicking the banner should scroll to and focus the approval card

## Proposed Data Model

The current flat `IAgentTimelineItem[]` is not sufficient for the target reading model.

Introduce a grouped view model above timeline items:

```ts
export interface IAgentConversationTurn {
	readonly id: string;
	readonly userMessage?: IAgentTimelineItem;
	readonly assistantMessage?: IAgentTimelineItem;
	readonly attachments: readonly IAgentTurnAttachment[];
	readonly statusMeta?: readonly string[];
	readonly hasPendingApproval: boolean;
}

export interface IAgentTurnAttachment {
	readonly id: string;
	readonly kind: 'reasoning' | 'command' | 'tool' | 'patch' | 'approval' | 'debug';
	readonly summary: string;
	readonly expandedByDefault: boolean;
	readonly item: IAgentTimelineItem;
}
```

### Responsibilities

- `agentSessionService.ts`
  - continues to convert OpenCode parts into timeline items
  - adds grouping from timeline items into conversation turns
  - computes attachment summaries and default disclosure state

- `agentTimelineRenderer.ts`
  - stops rendering the flat item stream directly
  - renders `IAgentConversationTurn[]`

This preserves the existing item-generation pipeline while creating a better presentation model above it.

## Renderer Refactor Plan

Replace the current top-level item routing with turn rendering.

Suggested renderer split:

- `renderConversationTurn(...)`
- `renderTurnMessages(...)`
- `renderTurnAttachments(...)`
- `renderApprovalDecisionCard(...)`
- `renderPatchSummaryAttachment(...)`
- `renderReasoningAttachment(...)`
- `renderCommandAttachment(...)`
- `renderToolAttachment(...)`
- `renderTurnFooterMeta(...)`

### Rendering rules

- approval stays visually distinct while pending
- patch is visible but compact
- reasoning, command, and tool become attachment rows with disclosure
- debug and status information move into footer or hidden details

## Shared Surface Strategy

`Agent Mode` main UI and compact sidebar chat should share the same renderer behavior and default disclosure rules.

Required outcome:

- same default collapsed state for reasoning
- same command and tool summary behavior
- same patch summary behavior
- same approval language and action placement

Files that should remain aligned:

- `src/vs/workbench/contrib/agentMode/browser/agentModeEditorSurface.contribution.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeCompactChatViewPane.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`

## Composer and Global Status Improvements

The composer should become the stable interaction center, not another status dashboard.

### Changes

- reduce layout shifts while the agent is running
- keep the bottom bar stable
- surface only a small number of state changes near the composer:
  - sending
  - running
  - waiting for approval
  - stopped

### Approval banner

Add a lightweight composer-adjacent banner for pending approvals:

- appears only when an approval is blocking progress
- references the blocking action in plain language
- focuses the matching approval card when activated

## Session List and Session Naming

To get closer to Codex and OSS chat quality, the session list should look like a work history, not a log of generically named runs.

Planned improvements:

- generate stable short titles earlier
- improve preview text so sessions remain scannable
- avoid excessive fallback titles such as `New session`

This is a follow-up phase, not the first implementation step.

## Scroll and Streaming Behavior

The current conversation experience should also improve in how it behaves, not just what it renders.

### Required behavior

- while streaming and the user is at the bottom, gently follow new content
- if the user scrolls upward, stop auto-follow
- showing a new attachment should not cause disruptive jumps
- pending approval near the composer should not yank the user away from their current reading position

## Expansion State Memory

Collapsed and expanded states should be remembered where practical.

Persist per item or per attachment:

- reasoning expanded/collapsed
- command output expanded/collapsed
- raw details expanded/collapsed

This should make the UI feel calmer and more respectful of user habits.

## Wording Changes

The UI should reduce implementation terms in visible text.

Prefer:

- `Checked workspace status`
- `Waiting for permission`
- `Prepared edits`
- `Edited 3 files`

Avoid prominent wording such as:

- `Step finished`
- `Process`
- `Tool lifecycle`
- `Execution summary`

These can still exist internally and in debug data, but not as the default language of the conversation.

## Phased Implementation Plan

### Phase 1: Reduce noise in the current flat model

Objective: improve the experience quickly before deeper structural work.

Changes:

- hide or demote `step-finish`
- collapse reasoning by default once no longer live
- collapse successful command and tool items into summary-first cards
- auto-expand failures and stderr
- keep approval prominent while pending

Primary files:

- `src/vs/workbench/contrib/agentMode/browser/agentSessionService.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`
- `src/vs/workbench/contrib/agentMode/browser/media/agentModeEditorSurface.css`

### Phase 2: Patch and approval improvements

Objective: make user decisions and user-visible outcomes clearer.

Changes:

- make patch cards summary-first
- add composer-adjacent approval banner
- reduce default verbosity of approval details while preserving access to raw details

Primary files:

- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeEditorSurface.contribution.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeCompactChatViewPane.ts`
- `src/vs/workbench/contrib/agentMode/browser/media/agentModeEditorSurface.css`

### Phase 3: Introduce turn grouping

Objective: move from event-first rendering to turn-first rendering.

Changes:

- introduce `IAgentConversationTurn`
- group flat items into turns
- update shared renderer to render turns and attachments
- move debug/status data into turn footer

Primary files:

- `src/vs/workbench/contrib/agentMode/browser/agentSessionService.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`

### Phase 4: Interaction polish

Objective: make the conversation feel stable and high quality.

Changes:

- persist expansion state
- refine scroll behavior
- stabilize composer state changes
- improve session naming and previews
- improve keyboard flow between composer, attachments, and approvals

Primary files:

- `src/vs/workbench/contrib/agentMode/browser/agentModeEditorSurface.contribution.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentModeCompactChatViewPane.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentSessionService.ts`
- `src/vs/workbench/contrib/agentMode/browser/agentTimelineRenderer.ts`

## Validation Plan

### UX validation

- default first screen shows the conversation, not an execution log
- successful runs no longer bury the assistant response under process cards
- approval is impossible to miss
- patch remains visible but quiet
- failures remain easy to inspect
- compact chat and agent mode behave consistently

### Implementation validation

- renderer still supports both `Editor Mode` compact chat and `Agent Mode`
- approval actions still function correctly
- command and patch actions still function correctly
- no loss of access to raw execution details
- collapsed state does not break live updates

### Visual validation

- verify in Electron with real sessions
- verify with the approval fixture session
- verify both success and failure cases

## Non-Goals

- Do not remove inspectability from the product.
- Do not hide approval behind multiple clicks.
- Do not fork two separate rendering models for compact chat and main agent mode.
- Do not treat OSS chat internals as the source of truth for `Agent Mode`.

## Risks

### 1. Grouping logic may mis-associate items

Turn grouping must avoid incorrectly binding commands, tools, patches, or approvals to the wrong assistant turn.

Mitigation:

- group primarily by source message identity
- keep process-group identifiers where available
- add targeted tests for interleaved or partial results

### 2. Too much collapsing may hide useful progress

If everything becomes too quiet, the user may lose confidence that the agent is actually working.

Mitigation:

- keep live execution visible while active
- show clear summary rows
- keep failures auto-expanded

### 3. Compact chat may become too dense

The compact sidebar has less space than the main surface, so attachment presentation must stay especially lean.

Mitigation:

- use the same model with tighter styling
- avoid separate behavior forks

## Recommended First Slice

The highest-value initial slice is:

1. stop showing `step-finish` as a normal top-level card
2. collapse reasoning once it is no longer live
3. collapse successful command and tool items into summary-first attachments
4. keep pending approval prominent
5. keep patch visible but summary-first

This yields a much calmer conversation view without requiring the full turn-grouping refactor on day one.

## Summary

The main design change is not a cosmetic refresh. It is a shift in information architecture:

- from event-first to turn-first
- from system visibility to decision visibility
- from always-expanded execution cards to summary-first attachments

That is the path most likely to produce a conversation experience that feels closer to OSS chat and Codex while preserving the richer agent-specific behaviors that `Agent Mode` needs.

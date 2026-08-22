# Codex Manage — V4 ChatGPT Mac workspace

- Figma file: `Codex Manage - ChatGPT Mac Style`
- Figma bridge file key: `unsaved-mslgdt3q-qpwbutxv`
- Scope: independent V4 boards and components only.
- Source code, API, backend, and V1 content were not modified.

## V4 roots

- `V4 / 01 Entry` — `49:1626` — `1440×960`
- `V4 / 02 Workspace` — `49:1627` — `1440×960`
- `V4 / 03 Interruption States` — `49:1636` — `1440×3100`
- `V4 / 04 Settings` — `50:1681` — `1440×960`
- `V4 / 05 Mobile` — `49:1628` — `1440×960`

The V4 roots are placed in a separate area beginning at x=12000. The interruption root contains three derived conversation states:

- `V4 / 03 Waiting Approval` — `50:1764`
- `V4 / 03 Failed Turn` — `50:1806`
- `V4 / 03 Model Picker` — `50:1848`

## Product structure represented

V4 is a single conversation workspace rather than a collection of route-like feature pages:

- persistent left session list;
- one central conversation timeline;
- historical turns above appended live output;
- command output and recorded file changes inline in the timeline;
- approval inside the paused turn;
- failure actions inside the failed turn;
- model selection as a compact Composer-adjacent popover;
- Composer as the primary interaction edge;
- mobile Conversation, Drawer, and Approval sheet variants derived from the same interaction model.

## State and contract boundaries

The boards use the supported runtime vocabulary:

- `running`
- `waiting_approval`
- `failed`
- explicit retry creates a new attempt and preserves the failed attempt;
- approval actions: `Allow once`, `Allow for this session`, `Deny`, `Cancel`;
- permission modes: `Ask before actions` / `Full access for this session`;
- model modes: `Follow session` / `Override`;
- model selection is explicit and catalog-driven;
- no automatic fallback, automatic replay, project-level approval persistence, or model switching during an active/waiting turn is represented.

Model labels in the picker are UI specimen content; production choices remain sourced from the app-server model catalog.

## V4 visual language

- dark macOS-style canvas: `#1C1C1E`;
- quiet sidebar: `#262628`;
- low-density surfaces: `#28282A` / `#2A2A2C`;
- thin borders: `#3A3A3C` / `#49494D`;
- primary text: `#F5F5F7`;
- secondary text: `#D1D1D6`;
- muted text: `#8E8E93`;
- running: `#30D158`;
- approval: `#FF9F0A`;
- failed: `#FF453A`.

## Visual validation exports

- `v4-final-entry.png` — local entry shell;
- `v4-final-workspace.png` — running desktop conversation workspace;
- `v4-final-waiting-approval-complete.png` — inline approval state with all four approval actions;
- `v4-final-failed-turn.png` — failed turn with Retry / Change model / Dismiss;
- `v4-final-model-picker-verified-2.png` — compact model picker with mode control, catalog option, and Apply;
- `v4-final-settings.png` — healthy local runtime and recovery card;
- `v4-final-mobile-complete.png` — Conversation, Drawer, and Approval sheet variants with the Composer approval hint;
- `v4-final-waiting-approval.png` and `v4-final-mobile.png` — pre-completion comparison exports.

Earlier stage exports remain available for comparison:

- `v4-stage-entry.png`
- `v4-stage-workspace.png`
- `v4-stage-settings.png`
- `v4-stage-mobile.png`

## Final microcopy completion

The two previously blocked microcopy items were added and visually verified:

- Desktop Waiting Approval now includes the separate `Deny     Cancel` footer at the bottom of the inline approval card;
- Mobile Approval Sheet Composer now includes `Approval pending · resolve the request above to continue`.

No black-only, empty, overlapping, or clipped primary board was accepted during visual inspection. One accidental top-level duplicate V4 workspace and residual V2 Native Mac settings/text nodes were removed before the final preservation check.

## Preservation check

Final top-level inventory contains exactly:

- V1 roots: `3:2`, `8:2`, `9:2`, `12:2`, `14:2`, `15:2`, `18:2`;
- V4 roots: `49:1626`, `49:1627`, `49:1628`, `49:1636`, `50:1681`.

The final document tree contains no nodes named V2, V3, or Native Settings, and no extra top-level V4 duplicate remains. No git commit was created.

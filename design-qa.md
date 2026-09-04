# 文献学习视图 · Design QA

## Latest Style Polish Pass

**Comparison Target**

- Accepted concept: Codex generated-image artifact `exec-83117c59-8747-440f-9a03-543a048f2595.png`（方案 3）
- Before screenshot: Codex visualization artifact `01-style-audit-before-results.png`
- Final implementation screenshot: Codex visualization artifact `05-style-polish-final-v4.png`
- Full comparison input: Codex visualization artifact `style-polish-comparison-final-v4.png`
- Focused branch comparison input: Codex visualization artifact `style-polish-focus-comparison-final-v4.png`
- Native CSS viewport: Obsidian Desktop 1.13.7, `1707 × 1019`, device pixel ratio `1.5`; implementation screenshot `2561 × 1529`
- Source pixels: `1536 × 1024`
- State: dark theme, Bailey paper loaded, mainline at “核心结果”, one answered question, one follow-up, two answer-evidence nodes, verified paper figure visible
- Capture method: native Obsidian Desktop through the official Obsidian CLI. Browser/IAB was not used because this is an Obsidian `ItemView`, not a browser route.

**Audit Findings And Fix History**

1. Initial audit (`01-style-audit-before-results.png`)
   - [P2] The alternating route used large angles and read as a rough zigzag rather than a deliberate learning path.
   - [P2] Completed cards carried full green outlines, making every stage compete with the active module.
   - [P2] Question, answer, and follow-up cards had nearly equal visual weight while their copy was prematurely truncated to one line.
   - [P2] A long orange right-angle connector visually separated the selected module from its mind-map branch.
2. First polish (`02-style-polish-draft-v1.png`)
   - Route movement was reduced, neutral card surfaces replaced the green boxes, and the active answer became the largest branch card.
   - Remaining [P2]: inherited button white-space still collapsed branch copy to one line; inspector actions fell partly below the visible edge.
3. Structural polish (`03-style-polish-draft-v2.png`, `04-style-polish-final-v3.png`)
   - Added explicit multiline wrapping, semantic green-complete/purple-current route segments, short circle-to-card connectors, calmer shadows, and persistent inspector actions.
4. Final refinement (`05-style-polish-final-v4.png`)
   - Added an answer evidence-count badge and evidence summaries, so the lower evidence branch has meaningful density instead of oversized empty cards.
   - Final inspection found no actionable P0/P1/P2 issue.

**Required Fidelity Surfaces**

- Fonts and typography: the final map uses Obsidian interface tokens with stronger labels, quieter supporting text, explicit multiline wrapping, and bounded clamps. Question, answer, follow-up, and evidence copy remain readable at the tested viewport.
- Spacing and layout rhythm: the vertical spine stays in a narrow left lane; the question/answer/follow-up chain uses `164 / 270 / 172 px` columns; answer evidence hangs directly below the answer. The tree ends at `x = 1334`, before the inspector begins at `x = 1366.5`.
- Colors and tokens: completed progress is green, the current stage is purple, questions are amber, answers lavender, and evidence cyan. Neutral cards no longer turn every completed stage into a competing status block.
- Image quality: the right inspector continues to render the real extracted paper figure at its native aspect ratio; no placeholder or reconstructed scientific asset is used.
- Copy and content: the final graph uses real paper/module text. It adds a `2 条证据` badge and concise evidence summaries that are absent from the mock but necessary for an auditable reading tool.

**Interaction And Accessibility Checks**

- Follow-up selection changed the persisted selected node to `qa-follow`.
- Question selection restored the root branch; evidence selection exposed a visible selected state.
- Sticky inspector actions remained fully inside the inspector viewport (`bottom ≤ inspector bottom`).
- Buttons retain semantic button elements, focus-visible treatment, and text labels. Screenshot review cannot establish full WCAG conformance; keyboard order and screen-reader announcements remain implementation-level test concerns.
- Obsidian captured no runtime errors after the interactions.

**Residual P3 Differences**

- The implementation uses a restrained near-vertical progress path rather than the concept's continuous bezier curve; this is intentional for predictable native layout.
- The real state contains two verified answer sources instead of the concept's three illustrative figures.
- The inspector is denser than the concept because it contains a real figure, full answer, sources, follow-up editor, and working actions.

## Earlier Structural QA

- Accepted concept path: Codex generated-image artifact `exec-83117c59-8747-440f-9a03-543a048f2595.png`（方案 3）
- Implementation screenshot: Codex visualization artifact `learning-session-vertical-v8.png`
- Side-by-side comparison input: Codex visualization artifact `learning-session-option3-comparison-v8.png`
- State: dark theme, one real MinerU paper loaded, mainline advanced to “核心结果”, one answered root question, one follow-up, two answer-evidence nodes, and the verified source figure visible in the inspector
- Native CSS viewport: Obsidian Desktop 1.13.7, `1707 × 1019`, device pixel ratio `1.5`; screenshot `2561 × 1529`
- Source pixels: `1536 × 1024`; implementation pixels: `2561 × 1529`
- Rendering method: native Obsidian Desktop through the official Obsidian CLI. Browser/IAB was not used because the feature is an Obsidian `ItemView`, not a browser route.

**Outcome**

- No actionable P0/P1/P2 differences remain.
- The chosen composition is implemented: a long vertical learning spine, a selected mainline module that expands rightward, and a mixed mind-map branch containing `你的问题 → AI 回答 → 继续追问` plus answer evidence.
- The core interaction path works with realistic data: create/select a question, hand it to knowledge-base conversation, receive the completion callback, persist the answer and sources, then add a follow-up from the answer inspector.

**Required Fidelity Surfaces**

- Fonts and typography: Obsidian interface tokens preserve the concept's hierarchy across paper title, route nodes, question/answer labels, evidence captions, and inspector prose. Dense canvas summaries are intentionally compact; full text remains readable in the inspector.
- Spacing and layout rhythm: the route occupies the left lane, the cognitive branch opens to the right, and the inspector remains fixed. At the tested viewport the branch tree ends at `x = 1296`, leaving about `30 px` before the inspector at `x = 1325.6`; no question, answer, follow-up, or evidence node is clipped by the inspector.
- Colors and visual tokens: purple mainline, orange user questions, violet AI answers, cyan evidence, dark surfaces, and completed-green states match the selected concept's semantic palette.
- Image quality and asset fidelity: the inspector renders the verified paper figure at its real aspect ratio with `object-fit: contain`; no placeholder, CSS drawing, or reconstructed scientific figure is used.
- Copy and content: mock scientific copy is replaced with the real Bailey paper title, real module context, a realistic PDAC subtype question, a paper-grounded answer, and source labels. The implementation additionally exposes `回答证据` and module guidance because those are required for auditable reading rather than decorative mock content.

**Comparison History**

1. Pre-fix vertical build (`learning-session-vertical-v3.png`)
   - P2: the rightward tree was aligned too low, leaving excessive empty space above it.
   - P2: the follow-up node reached the inspector boundary and appeared visually clipped.
2. Material fixes
   - Anchored the mind-map top position to the selected module with `--learning-map-top` and connected it back to the active route node with a bounded L-shaped branch segment.
   - Reduced the tree grid to `160 / 250 / 170 px` columns with `24 px` gaps so the complete interaction chain fits before the inspector.
   - Kept the full seven-module spine visible while moving the question/answer tree into the central reading zone.
3. Post-fix evidence (`learning-session-vertical-v8.png`, `learning-session-option3-comparison-v8.png`)
   - Mind map: `x = 636`, `y = 397.43`, width `660`; branch tree right edge `1296`.
   - Inspector: `x = 1325.6`, width `381.73`; only the inspector itself scrolls for real evidence density.
   - Full spine: `x = 382`, `y = 255.43`, height `648`; all seven modules remain visible.
   - The selected concept, final native screenshot, and the combined comparison input were each inspected at original detail.
   - Obsidian reported no runtime errors.

**Intentional Remaining Deviations**

- [P3] The route is built from angled CSS segments rather than a single smooth bezier curve. It preserves direction and hierarchy while remaining stable under Obsidian theme/layout changes.
- [P3] The implementation keeps Obsidian's real file explorer and the paper's actual extracted figure instead of reproducing the concept's decorative shell and chart.
- [P3] The real inspector is vertically scrollable because it contains a figure preview, full rendered answer, answer sources, and a follow-up composer; the concept shows a shorter illustrative inspector.

**Implementation Checklist**

- [x] Seven-stage vertical learning spine with mixed straight and angled routing
- [x] Selected module expands into a rightward mind-map branch
- [x] Persisted root questions and nested follow-ups
- [x] Stored, Markdown-rendered AI answers
- [x] Answer-level vault/web source nodes and inspector cards
- [x] Verified source-figure preview
- [x] Completion callback from knowledge-base conversation into the learning session
- [x] Mainline progress, selection, and return-to-reader controls
- [x] Native Obsidian viewport, overflow, and runtime-error inspection
- [x] Side-by-side concept/implementation comparison

final result: passed

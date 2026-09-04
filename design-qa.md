# 文献学习视图 · Design QA

**Comparison Target**

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

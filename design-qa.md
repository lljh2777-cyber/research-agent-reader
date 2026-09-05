# 文献学习视图 · Design QA

**Comparison Target**

- Source visual truth path: Codex generated-image artifact `exec-b88c66b6-9a2b-4a40-9a82-11aa47fb1d9b.png`
- Implementation screenshot path: Codex visualization artifact `learning-session-final-v4.png`
- Full comparison path: Codex visualization artifact `learning-session-comparison-final.png`
- Focused map comparison path: Codex visualization artifact `learning-session-comparison-map-final.png`
- State: dark theme, one MinerU paper loaded, mainline advanced to “核心结果”, four realistic question branches (three above, one below), first claim-bearing figure visible in the inspector
- Viewport: Obsidian Desktop 1.13.7; CSS viewport `1707 × 1019`, device pixel ratio `1.5`; screenshot `2561 × 1529`
- Source pixels: `1536 × 1024`; implementation pixels: `2561 × 1529`
- Density normalization: the full comparison used `contain` into equal `1536 × 1024` boxes. The focused comparison used content crops normalized into equal `1000 × 700` boxes.
- Rendering method: native Obsidian Desktop through its official CLI. Browser/IAB was not used because this is an Obsidian `ItemView`, not a browser-rendered web route.

**Findings**

- No actionable P0/P1/P2 differences remain in the implemented first slice.
- [P3] Branch and evidence topology is intentionally simpler than the concept.
  Location: learning-map canvas.
  Evidence: the concept shows curved multi-hop connectors and several evidence leaves per question; the implementation uses compact vertical question branches and one primary evidence node per module.
  Impact: the present topology remains readable and functional, but later nested answers will need a richer edge/layout model.
  Follow-up: introduce explicit answer/evidence child nodes only when their data model and navigation behavior are implemented.
- [P3] The implementation keeps Obsidian's native file explorer instead of duplicating the concept's custom left navigation.
  Location: application shell.
  Evidence: the source has a bespoke icon rail; the implementation embeds the learning canvas in the existing Obsidian shell.
  Impact: visual framing differs while platform consistency and vault navigation improve.
  Follow-up: none for this slice.

**Required Fidelity Surfaces**

- Fonts and typography: uses Obsidian interface and monospace tokens; title, kicker, node label, evidence caption, and secondary copy retain the concept's hierarchy. Truncation is constrained to dense node/evidence labels, while inspector prose wraps normally.
- Spacing and layout rhythm: preserves the long horizontal mainline, reserved upper/lower branch lanes, external evidence row, and fixed inspector. The selected node is centered within the scrollable map; controls remain visible at the tested desktop viewport and with the Obsidian right sidebar both open and closed.
- Colors and visual tokens: purple mainline, orange user questions, cyan evidence, dark surfaces, subtle borders, and completed-green states map to semantic tokens and remain legible in the active theme.
- Image quality and asset fidelity: the inspector renders the verified paper figure blob at native aspect ratio with `object-fit: contain`; no placeholder or reconstructed asset is used.
- Copy and content: replaces mock labels with the actual paper title, real section matches, real figure captions, source path, module-specific guidance, and user-entered questions. Chinese UI copy is concise and consistent with the plugin.

**Comparison History**

1. Initial comparison (`learning-session-comparison-v1.png`)
   - P1: selecting a later module could leave it at the right edge because the map preferred the current node during auto-scroll.
   - P2: the results inspector exposed figure references but not the source figure preview shown by the concept.
   - State mismatch: the fresh session had no questions, so branch density could not be judged against the populated concept.
2. Fixes made
   - Selected question/mainline nodes now take priority over the current node, and the map applies an explicit delayed horizontal scroll after render.
   - The results inspector now renders the first available verified figure asset and caption; blob URLs are cached and revoked with the view lifecycle.
   - The interaction state was populated only through the visible question composer, including alternating upper/lower placement, then advanced through five mainline steps.
3. Post-fix evidence (`learning-session-final-v4.png`, `learning-session-comparison-final.png`, `learning-session-comparison-map-final.png`)
   - Selected “核心结果” is centered at horizontal scroll `391.33 / 403`.
   - Progress reads `主线 6 / 7`; five nodes are complete.
   - Four branches render as `3` upper and `1` lower.
   - The verified figure reports natural width `665` pixels and is visibly rendered in the inspector.
   - Obsidian reports no runtime errors.

**Implementation Checklist**

- [x] Long horizontal mainline with ordered learning modules
- [x] Upper/lower user-question branches with persisted view state
- [x] External evidence nodes and right-side evidence inspector
- [x] Verified source figure preview and caption
- [x] Mainline progress and selected-node centering
- [x] Handoff to the existing knowledge-base conversation with paper/module context
- [x] Return path to the existing paper reader
- [x] Desktop responsive behavior with the Obsidian side panel open and closed
- [x] Runtime error inspection and full automated verification

**Follow-up Polish**

- Add collapsible nested answer/evidence children once answers are stored in the learning-session model.
- Add direct section/page navigation rather than opening the reader at its last position.

final result: passed

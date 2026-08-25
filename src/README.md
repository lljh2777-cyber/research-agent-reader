# Agent Dashboard Source Layout

`main.js` is generated. Make implementation changes under `src/`, then run
`pnpm build` or `npm run build`.

Current module ownership:

```text
src/main.ts                  Strict, minimal plugin entry point
src/plugin.ts                Strict composition root and Obsidian lifecycle shell
src/actions.ts               Dashboard action registry and action-level model defaults
src/config.ts                Stable view IDs, limits, model options, provider definitions
src/annotations/             Reading-view selection, annotation Markdown, popover, and archive handoff
src/modals/                  Action input, task result, practice-note, and image-picker dialogs
src/providers/adapters.ts    Direct API and Codex CLI provider implementations
src/providers/http-transport.ts
                             Bounded HTTP/SSE/NDJSON transport and error mapping
src/providers/profile.ts     Direct API profile defaults, normalization, capability checks
src/providers/shared.ts      Provider URL, payload, model-list, and error helpers
src/query/direct-query-service.ts
                             Direct API retrieval cascade, prompt, streaming, and result orchestration
src/query/normalization.ts   Persisted query attachment, source, path, and citation contracts
src/mineru/                 MinerU package normalization, validated loading, visual-repair contracts,
                            Markdown anchors, and PDF.js rendering
src/reader/                 Generic Markdown/Clipping figure-caption parsing and reader source loading
src/runtime/settings.ts      Executable discovery and persisted setting defaults
src/runtime/lifecycle-state.ts
                             Active process, provider, and query-run state
src/runtime/process-execution.ts
                             Typed Python/Codex child-process execution and cleanup
src/runtime/persistence.ts   Version-tolerant state decoding and serialized saves
src/services/dashboard-data.ts
                             Incremental vault scan and Dashboard metric/gap derivation
src/settings/settings-tab.ts Obsidian settings UI
src/types/contracts.ts       Shared PluginHost, task, query-session, and provider contracts
src/views/                   Dashboard, query, code-practice, and dual-pane document reader ItemViews
```

All source modules, including `src/plugin.ts`, use strict TypeScript. The plugin
class is the Obsidian composition root; provider transport, Direct API query
orchestration, runtime process handles, and save queues are owned by focused
services.

Reading-view annotations are stored as ordinary Markdown under
`wiki/annotations/`. Source text links to a stable annotation block ID, while
the plugin intercepts normal, Ctrl/Cmd, and Shift clicks for the popover,
archived knowledge targets, and the underlying annotation document.

Validated MinerU packages can be opened in a dedicated main-area reader. Its
left pane renders `article.md`; the right pane switches between the original
PDF and a figure/caption rail. Reader activation is serialized and reuses one
main-area leaf; stale duplicate reader leaves are detached before the selected
article is loaded. A compact identity row shows the vault-relative `article.md`
path and the complete article title. Figure-rail thumbnails use a fixed preview
viewport so wide, tall, and reconstructed assets remain inside their buttons.
Vault-relative folders configured under “文献阅读器” are intercepted when an
ordinary Markdown file opens. A standalone Markdown or HTML image followed by
one adjacent paragraph becomes a figure anchor: the left pane suppresses the
image and caption, while the right pane keeps the original remote or Vault-local
asset and displays the caption with a deterministic `Fig. n` label. Existing
labels in alt text, captions, or asset URLs win; unlabeled figures receive the
next unused display number. This adaptation never rewrites the Clipping source
file and does not weaken validated MinerU package checks. “打开原始 Markdown”
uses a one-shot bypass so users can still edit a configured source directly.
The PDF pane uses a continuous, lazily rendered
page stream: scrolling updates the retained page-number control, while page
selection, zoom, layout boxes, and figure anchors remain synchronized without
modifying the generated article. Follow-reading is mode-specific: the PDF mode
tracks page anchors derived from verified Markdown block ranges and synchronizes
only the current page. Rendered blocks receive one monotonic runtime page chain:
surviving inline markers from exact Markdown ranges are authoritative, with
normalized-text matching used only as a compatibility fallback. Figure-only PDF
pages do not claim nearby visible text after their images move to the visual rail.
Each rendered Markdown
block inherits the nearest preceding verified MinerU page boundary. Automatic PDF
following has one authority: the page owned by the first visible Markdown line.
Scroll capture only schedules that viewport-top calculation; it does not run a
competing interpolation or timer. When PDF following is disabled, clicking a
non-interactive Markdown text block explicitly opens that block's page on the right.
PDF page alignment is calculated in the scroll container's coordinate
system, keeping every selected page top below the retained toolbar. The figure/caption mode independently tracks visual
anchors and selects the corresponding reconstructed image. Legacy reader state
is migrated to both switches without changing the source package.
Page changes are derived from each mapped block's viewport position, rather than
assuming a theme-specific Obsidian scroll wrapper. A capture-phase document scroll
listener also sees themes that hide the actual scrolling layer inside their Markdown
renderer, while requestAnimationFrame coalesces duplicate scroll notifications.
When `_extraction/visual-repair.json` identifies a high-confidence fragmented
figure, the reader displays either the enclosing MinerU asset or a PDF crop;
the original assets remain the safe fallback. A PDF.js loading failure is also
isolated to the reference pane: Markdown and packaged image assets remain
readable, and the compatibility notice records the degraded mode. The same derived contract can
link an explicit “see next page” placeholder to a uniquely matching formal
figure caption at the top of the immediately following page. Formal anchors
support `Fig.`/`Figure`, `Extended Data`, `Supplementary`, and `Supporting`
prefixes, integer or decimal identifiers, and either an explicit separator or
direct title text. A candidate whose title begins with a descriptive reference
verb such as `shows`, `illustrates`, or `provides`, or whose title is too short,
is treated as body prose. Matching stops at ordinary prose, titles, visuals, or
a different figure key. Incomplete MinerU
caption extraction is surfaced as partial instead of being reconstructed from
unrelated body prose. A short top-of-page title is ignored as a running header
only when another page contains an explicit `header`/`page_header` twin with
identical text and near-identical coordinates; this lets old validated packages
recover a missing cross-page link without treating ordinary headings as noise.
The rendered Markdown hides such a reclassified header only when exactly one
matching standalone ATX heading is bounded by two source-ordered visual anchors.
Each anchor must resolve to a Markdown image occurrence or a unique standalone
HTML table range; duplicates or missing bounds preserve every occurrence.

Caption arrays remain atomic in the derived viewer index. The reader classifies
formal captions, next-page placeholders, strict panel labels, and candidate
continuations separately. Display suppression binds every same-page MinerU
caption atom to its exact Markdown image occurrence and removes the complete
ordered run only when one unique split matches standalone lines immediately
before and/or after that image, allowing at most two intervening blank lines.
A uniquely adjacent standalone formal caption such as `Extended Data Fig. 1 |`
can also bind to a same-page visual. The reader first chooses the nearest formal
caption after each visual in MinerU reading order, then verifies spatial
adjacency and unique ownership. Nearby crop components that share that same
next-caption boundary may be joined even when panel labels are absent; components
across different caption intervals remain separate. A non-terminal first column is suppressed
only together with one unique, spatially aligned lowercase/panel continuation
that closes the caption, so a split caption cannot leave an orphaned second
column. When that caption is the sole anchor for a
panel-labelled, narrowly separated horizontal component, the reader joins the
validated PDF crops into one full-width figure before rendering. Two components
with independent captions or equally plausible ownership remain separate. This
covers a second MinerU failure mode as well: if an auto-reconstructed crop contains
at least 97% of a smaller auto crop, is at least 1.35 times its area, remains
adjacent in source order, and both groups expose exactly one compatible formal
figure key, the smaller p/q/r-style duplicate is folded into the enclosing crop.
Its members, Markdown occurrences, and caption anchors move to the enclosing
visual so the full figure keeps the specific same-page or cross-page caption.
Partial overlap, missing figure identity, or conflicting keys fail closed. This
covers panel labels, figure-internal headings, formal
captions, and split caption continuations without global text replacement. A
panel-style continuation from the same caption array may follow a formally
terminated first sentence; an unterminated caption may still use one uniquely
bounded cross-fragment continuation. Any non-blank gap, reorder, duplicate-side match, or
body-prose collision fails closed. Cross-page caption text is suppressed only
through validated, exact Markdown source ranges bounded by monotonically mapped
image occurrences. A table-shaped figure with no Markdown image occurrence may
use its unique standalone HTML `<table>` range instead; the table and its
uniquely adjacent formal caption are replaced atomically after internal images
have still contributed to occurrence numbering. Duplicate or edited tables,
captions, or intervening prose preserve the complete Markdown block.
The full target page must validate, and the caption must
also bind to either a contiguous target-page block chain or the source image's
verified placeholder occurrence; a matching string elsewhere in the article
is never sufficient. The generated `article.md` and MinerU JSON
remain unchanged.

For a stricter cross-column failure mode, the reader can recover text from the
packaged PDF text layer without rewriting MinerU output. Recovery is attempted
only when an explicit next-page placeholder resolves to a formal caption,
exactly one empty MinerU text block occupies the aligned companion
column, and the PDF region continues the anchor's panel sequence (for example,
`j` followed by `k`, `l`). If MinerU appended that recovered text to the end of
an ordinary Markdown paragraph, only the uniquely matched suffix is projected
out; the paragraph prefix remains visible. The same bounded recovery also covers
same-page two-column captions whose formal left column is attached to the final
figure asset while the right column is empty in MinerU and has been merged into
the preceding PDF page's body block. That variant requires one incomplete formal
caption, one uniquely adjacent empty column, and a PDF continuation whose panel
sequence follows the formal anchor; Markdown matching is limited to the caption
page and its immediately preceding page. `Fig. 2k`/table references, missing
panel continuity, multiple matches, or unavailable PDF text all fail closed.
For captions already split across members of one repaired visual group, an
unterminated formal part may also absorb one later terminal part when its panel
markers continue strictly in sequence (for example, `a`, `b` followed by `c`,
`d`, `e`). This structural path covers continuations that begin with an
uppercase acronym such as `MGC-positive` without treating arbitrary uppercase
body prose as a caption.

New intake packages also contain `_extraction/visual-candidates.json`. This
bounded, hash-bound contract exposes only deterministic `review`, `partial`, or
`ambiguous` candidates for an optional AI adjudicator. Model output is limited
to an existing candidate ID plus `accept`, `reject`, or `abstain`; coordinates,
paths, and source prose are rejected. Candidate generation and validation do
not call an external model, and AI review remains an explicit opt-in layer.

Build constraints:

- esbuild bundles all source modules into the CommonJS `main.js` expected by Obsidian.
- `obsidian` and `electron` stay external and are supplied by the desktop app.
- Production builds keep UTF-8 display text and do not emit a source map.
- `npm run verify` performs type checking, rebuilds `main.js`, and runs the
  dashboard regression suite.

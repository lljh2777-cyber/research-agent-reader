# Security policy

## Supported versions

Security fixes are applied to the latest published beta release and the `main`
branch. Older beta releases are not maintained after a newer release is
published.

## Reporting a vulnerability

Do not disclose a vulnerability in a public issue before the maintainer has had
an opportunity to assess it. Use GitHub private vulnerability reporting. If
private reporting is unavailable, open a minimal issue requesting a private
contact channel without including exploit details.

## Trust boundaries

M4 adds a model-independent PDF source save. The explicit confirmation button is
enabled only after an authorized PDF raster has decoded in the displayed modal.
Its separate v2 receipt binds the request, acquisition snapshot, PDF hash,
source identity and displayed evidence, including PNG/pixel hashes and render
parameters. The existing v1 Crossref-bound receipt validator remains unchanged.
New acquired intake uses deterministic catalog identity; models only draft prose.

PDF source publication is create-only under a fixed Vault root. A private,
device-bound plan precedes writes; an ownership transaction precedes the PDF;
the immutable manifest is the final commit marker. Recovery accepts only exact
owned files, rejects links, unknown paths and modified content, and never deletes
or overwrites source files. Incomplete or unknown `_source` packages cannot fall
back to ordinary Markdown or MinerU. PDF reading verifies the committed package.
Index registration has a separate retry with content comparison before applying
changes. Concurrent edits stop that attempt. PDF, image, metadata and catalog
reads have explicit size/count budgets. These contracts detect integrity and
ownership mistakes; they do not authenticate files against a hostile process
with the same local user's filesystem privileges.

Source-only saving does not invoke a model or upload a document. It does not
write scientific conclusions, Wiki notes, CSV or BibTeX. Confirmed page evidence
and acquisition provenance remain in the local source package; the Unpaywall
contact email remains outside these records. See the [M4 implementation notes](docs/fulltext-acquisition-m4.md).

Research Agent Reader is a desktop plugin and inherits the filesystem and network
permissions of Obsidian. It can launch only explicitly supported local programs,
using argument arrays rather than shell command strings. Optional workflow
actions may modify vault files and therefore use bounded paths, task history,
validation, and rollback contracts.

The plugin does not install or update external executables. Users must install
optional CLI backends themselves. Direct API keys and an optional MinerU API
token are selected through Obsidian SecretStorage and are not stored in plugin
`data.json`; only their secret IDs are persisted. A selected MinerU token is
passed to the launched CLI as `MINERU_TOKEN`. MinerU CLI-managed authentication
and an existing environment variable remain supported alternatives.

Completed task output can include model/tool traces, command output, and Vault
excerpts selected for that run. Full output is stored locally beside the plugin
under `task-output/dashboard-runs/`; `data.json` keeps only a bounded snapshot
and the registered sidecar path. Clearing completed task history removes those
registered sidecars. The plugin does not infer deletion permission merely from
an unreferenced file, so compatibility outputs from older beta versions may
require explicit manual review.

## Light agent (Direct API tool loop)

The paper-intake light agent lets a user-configured LLM drive a bounded tool
loop inside the plugin. Its boundaries are enforced in code, not by prompt:

- Tools are allowlisted per workflow phase; phases run in a fixed order
  (identity/dedup → extraction → note commit) controlled by the plugin.
- Vault identity reads and listings are restricted to `wiki/sources`, `papers`, and `Clippings`;
  traversal (`..`) and out-of-scope paths are rejected.
- Network access is limited to domain-bound metadata lookups (Crossref); the
  plugin constructs the URLs, so model-controlled text can only fill query
  parameters.
- The MinerU helper receives the immutable private snapshot derived from the
  exact PDF selected and authorized by the user (remote-upload confirmation
  still applies); it never receives a model-selected path.
- PDF filenames, metadata, and text-layer extraction are discovery hints only.
  Before a bibliographic identity can authorize extraction or a Wiki write,
  the user must visually confirm a final PDF.js raster from the immutable
  authorized snapshot against the plugin-bound Crossref record. The receipt
  is bound to the task ID, snapshot SHA-256, raster SHA-256, render parameters,
  and Crossref record hash; it cannot be replayed for another task or PDF.
- Wiki writes are performed by the plugin from validated model-supplied
  fields into `wiki/sources/<citekey>.md`, create-only; existing notes are
  never overwritten.
- MinerU and model text are treated as untrusted active-Markdown input. The
  original MinerU Markdown bytes are retained only as
  `_extraction/article.raw.txt`; the rendered `article.md` is a deterministic
  passive derivative. Fenced/indented code, raw HTML, embeds, reference-style
  or external images, plugin directives, and unbound media are neutralized or
  rejected before Obsidian's global Markdown processor chain. Model-authored Source Notes use
  the same boundary with an even stricter no-image profile.
- Tool output is size-capped and the run has step/wall-clock budgets;
  cancellation aborts in-flight requests and subprocesses.
- Tool results and web content are untrusted input and may contain prompt
  injection; the plugin treats them as data, and only the user's modal input
  and the plugin's own state can change what tools are allowed to do.

## Identifier-based fulltext acquisition

The acquisition service is independent of the light agent. It constructs exact
Europe PMC/Crossref metadata queries and selects PDFs from scoped PMC version
manifests. M3 optionally falls back to Unpaywall's explicit PDF locations. Its
API receives the DOI and a user-configured contact email. The email is stored
in local settings; acquisition journals retain location origins and digests,
not full PDF URLs or email-bearing API URLs.

Metadata and PMC requests allow HTTPS to four fixed provider hosts. Unpaywall
PDF locations may use other public HTTPS hosts. Every connection pins a
validated public DNS answer and verifies the connected peer. Metadata and PMC
redirects remain on the same origin; OA PDF redirects may cross origins only
after the same URL and public-address checks. Dynamic URLs reject literal IPs,
local hostnames, credentials, fragments, non-default ports and recognized
credential/signature query fields. Requests use no ambient proxy, credentials,
cookies, Referer or model-controlled URLs.

Metadata is capped at 2 MiB and PDFs at 64 MiB, with bounded concurrency,
timeouts, retries and streaming backpressure. One attempt sequence has a
128 MiB received-PDF budget including failed candidates, and five minutes of
active time; waiting for source selection pauses that timer. The discovery
stage also has a 20-second deadline. PMC manifests or Unpaywall records are
rechecked before download. PMC additionally requires the manifest PDF MD5;
both paths validate SHA-256, format, page count and first-page identity clues.
A missing identity match remains explicitly unconfirmed. This status does not
authorize MinerU, Wiki writing or scientific conclusions.

The passive preview uses local PDF.js canvases with evaluation disabled and no
annotation/action layer. Completed artifacts are bound to immutable snapshots
and rehashed before reuse or preview. Partial files remain in plugin-local
storage and are never silently promoted, overwritten or automatically removed.

The acquired intake adapter revalidates the source path, snapshot ID, byte length
and SHA-256 before invoking intake. Its authorized copy must match those bytes.
M4 uses the separate v2 visual confirmation for new acquired intake; legacy local
PDF intake retains its existing v1 receipt requirements. Each continuation
selects a model and resets remote-upload consent.
Acquisition and intake have separate completion states and persisted links.
Intake runs carrying an acquisition reference are protected from automatic
history eviction. Their authorization copies and MinerU staging directories
are retained on success, failure or cancellation; this policy is scoped to the
new acquisition path, rather than a rewrite of all legacy cleanup behavior.

## Environmental trust assumption

Research Agent Reader defends against untrusted PDFs, remote MinerU output,
model responses, logical path traversal, symbolic links, junctions, special
files, and ordinary TOCTOU changes observable through file identity and real
path checks.

The plugin does not claim to resist a malicious local process running under the
same operating-system account with equivalent filesystem permissions. Such a
process can move or replace a validated directory inode while it is in use and
can also directly modify the Vault, plugin installation, configuration,
private temporary files, or Obsidian process state. Cross-platform JavaScript
path APIs cannot provide a complete mandatory-integrity boundary against that
attacker.

Accordingly, the Vault root, plugin installation directory, and plugin-owned
temporary directory are assumed not to be actively rewritten by an equally
privileged malicious local process during an operation. Observable identity
changes still fail closed.

When reporting a vulnerability, include the plugin version, Obsidian version,
operating system, affected feature, minimal reproduction, and whether an
optional external backend was involved. Remove credentials, private note
content, and personal filesystem paths from logs.

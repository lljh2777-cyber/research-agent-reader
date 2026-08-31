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
- Vault reads and listings are restricted to `wiki/sources` and `papers`;
  traversal (`..`) and out-of-scope paths are rejected.
- Network access is limited to domain-bound metadata lookups (Crossref); the
  plugin constructs the URLs, so model-controlled text can only fill query
  parameters.
- The MinerU helper always receives the exact PDF path the user confirmed in
  the modal (remote-upload confirmation still applies); the model cannot
  select or substitute files.
- Wiki writes are performed by the plugin from validated model-supplied
  fields into `wiki/sources/<citekey>.md`, create-only; existing notes are
  never overwritten.
- Tool output is size-capped and the run has step/wall-clock budgets;
  cancellation aborts in-flight requests and subprocesses.
- Tool results and web content are untrusted input and may contain prompt
  injection; the plugin treats them as data, and only the user's modal input
  and the plugin's own state can change what tools are allowed to do.

When reporting a vulnerability, include the plugin version, Obsidian version,
operating system, affected feature, minimal reproduction, and whether an
optional external backend was involved. Remove credentials, private note
content, and personal filesystem paths from logs.

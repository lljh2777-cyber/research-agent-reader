# Contributing

## Development setup

1. Install Node.js 20 or later and pnpm.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm verify` before opening a pull request.

Keep `main.js` out of commits. It is generated for local testing and attached
to GitHub Releases by the release workflow.

## Change boundaries

- Keep the reader usable without optional agent CLIs or the Research Vault Toolkit.
- Do not add telemetry, automatic dependency installation, or automatic updates.
- Treat configured external paths and model endpoints as untrusted input.
- Keep command IDs stable after public release.
- Add or update tests for reader parsing, provider boundaries, process invocation,
  settings normalization, and persistence changes.
- Do not commit API keys, plugin `data.json`, private papers, converted documents,
  or user-specific filesystem paths.

## Pull requests

Describe user-visible behavior, privacy or permission changes, test coverage, and
manual Obsidian validation. UI changes should include screenshots when practical.

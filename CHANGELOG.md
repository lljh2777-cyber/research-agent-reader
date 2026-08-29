# Changelog

All notable changes to this project will be documented in this file.

## [0.29.0] - Unreleased

### Changed

- Extracted the plugin into a standalone repository layout.
- Raised the minimum Obsidian version to 1.11.4 for SecretStorage compatibility.
- Removed the default annotation hotkey so users can choose their own shortcut.
- Removed user-specific Python and R executable defaults.
- Made the regression suite runnable from the plugin repository.
- Added community-release documentation, privacy disclosures, CI, and release automation.
- Made optional toolkit discovery require real toolkit markers instead of assuming every Vault is a project workspace.
- Added cross-platform CLI candidate discovery and platform-neutral public UI examples.
- Added a public-release audit and disposable clean-Vault smoke-test fixture.
- Clarified in settings and runtime errors that the reader, annotations, and built-in health check do not need external tools.
- Added a strict release guard for the already-occupied provisional plugin ID and display name.
- Renamed the public plugin identity to `Research Agent Reader` with ID `research-agent-reader` before publication.

### Fixed

- Direct API image attachments and vault evidence packets now read through the active Obsidian Vault API instead of deriving a `knowledge-base` folder from the toolkit root, so they work in any Vault layout.
- Added an in-plugin lexical retrieval fallback so Direct API vault queries work without the optional toolkit; toolkit retrieval stays primary when configured, and failures fall back transparently with a trace reason.
- Renamed the persisted `projectRoot` setting to `toolkitRoot` with automatic migration of existing `data.json` values.

### Notes

- Advanced Research Vault workflows still require a separately installed toolkit.

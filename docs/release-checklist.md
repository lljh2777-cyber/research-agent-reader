# Public release checklist

This checklist separates automated repository checks from the manual Obsidian checks that require a real desktop session.

## Version delivery and publication

The maintainer has authorized publishing future validated versions alongside their commits and pushes; no additional confirmation is required unless the maintainer pauses publication. Documentation-only changes without a version change do not republish an existing version.

1. Keep `package.json`, `manifest.json`, and `versions.json` consistent. Update `CHANGELOG.md`, `docs/releases/<version>.md`, README download links, and the current-version references at the top of the roadmap and closeout record. Release notes must retain trial status, known issues, skipped checks, and review gaps.
2. Complete relevant validation, commit and push the intended changes, then push an annotated tag matching the manifest version exactly, without a `v` prefix. Do not move an existing published tag.
3. Confirm the Windows, macOS, and Linux CI for the tagged commit succeeds. The tag-triggered release workflow rebuilds, runs `verify:public`, checks the version, attests the artifacts, and creates a draft. Keep the draft unpublished if required checks fail.
4. Inspect the draft with `gh release view <version>`. Confirm its only install assets are `main.js`, `manifest.json`, and `styles.css`, check the uploaded manifest, and confirm the artifact-attestation step succeeded. Use the workflow-built files.
5. Publish the draft using the version's saved release notes and a title retaining the current trial status. For a normal version advance, mark it latest. Verify the public release URL, tag, draft status, and three assets before reporting completion.

## Automated

- Run `pnpm verify:public` on Windows, macOS, and Linux through CI.
- Confirm TypeScript, the minified production build, tests, release metadata, privacy disclosures, and the clean-Vault fixture all pass.
- Confirm `main.js`, `manifest.json`, and `styles.css` are attached individually to a GitHub release whose tag exactly matches `manifest.json` without a `v` prefix.
- Confirm no `data.json`, credentials, private documents, test Vault, or local absolute paths are committed or attached.
- Confirm the README privacy section still discloses plugin-local full task-output sidecars, their possible Vault/model trace content, and the supported cleanup behavior.

## Clean-Vault desktop QA

Run `pnpm test-vault:prepare`, open the reported folder as a separate disposable Vault, and follow its generated QA note.

By default the Vault is generated under `%TEMP%`, where system cleanup tools
(Storage Sense, cleaner utilities) may purge files at any time — if the plugin
folder or QA note disappears, regenerate it. For a QA Vault that survives
cleanup runs, pass a path outside Temp:

```powershell
pnpm test-vault:prepare --output "E:\path\to\test-vault"
```

Record the following before release:

- Obsidian application and installer versions.
- Operating system and display scaling.
- Plugin enable, disable, reinstall, and settings persistence results.
- Clippings figure/caption extraction and inferred figure numbering.
- Plain Markdown reader opening from every configured directory.
- Built-in health check behavior without Python or a toolkit.
- Missing-toolkit messages for advanced actions.
- Console errors after loading, opening the reader, changing settings, and disabling the plugin.

Do not test development builds in a primary research Vault.

## Screenshots

Capture polished screenshots only from the disposable Vault, with private file names, provider endpoints, credentials, and local paths excluded.

Recommended public images:

1. Reader overview at 1200 × 800 showing body text on the left and figure/caption on the right.
2. Web Clipper Markdown with an inferred `Fig. 1` label.
3. Settings page showing manual reading preferences and the core/optional-toolkit boundary.
4. Dashboard health result showing built-in scope and the excluded `papers/` and `Clippings/` roots.

Keep source screenshots in a future `screenshots/` directory only after they have been reviewed for privacy and licensing.

## Community-directory metadata requiring maintainer confirmation

- Author display name and author URL.
- MIT license ownership year/name.
- Repository owner and URL.
- Whether to accept donations and therefore add `fundingUrl`.

The confirmed public identity is `Research Agent Reader` with the permanent ID `research-agent-reader`. This replaced the unavailable provisional ID `agent-dashboard` before the initial GitHub release. Re-check uniqueness immediately before Community-directory submission because the directory can change.

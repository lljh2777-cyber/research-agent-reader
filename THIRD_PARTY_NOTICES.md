# Third-Party Notices

Research Agent Reader is licensed under the MIT License. See [LICENSE](LICENSE).

The plugin interoperates with the projects and services listed below. Unless
explicitly stated otherwise, their source code and binaries are not included in
Research Agent Reader releases. Each project remains subject to its own license,
terms, and privacy policy.

## Host-provided components

- **Obsidian API** — Research Agent Reader uses the Obsidian plugin API. The
  `obsidian` package used for type checking is MIT-licensed. The Obsidian desktop
  application supplies the API at runtime and is not distributed with this
  plugin.
- **PDF.js** — PDF rendering is requested through Obsidian's `loadPdfJs()` API.
  PDF.js is licensed under the Apache License 2.0 and is supplied by the Obsidian
  runtime; Research Agent Reader does not bundle a separate PDF.js distribution.
- **Lucide icons** — Icons requested through Obsidian's `setIcon()` API are
  supplied by the Obsidian runtime. Research Agent Reader does not bundle the
  Lucide icon library or its marketing assets.

## Interoperable document formats and external tools

- **Obsidian Web Clipper** — Research Agent Reader can read Markdown documents
  created by Web Clipper. It does not include Web Clipper code, browser-extension
  assets, icons, or marketing materials. Web Clipper source code is MIT-licensed.
- **MinerU and mineru-open-api** — Research Agent Reader can launch a separately
  installed `mineru-open-api` command and read compatible Markdown, JSON, image,
  and PDF artifacts. No MinerU implementation, model, CLI binary, or service is
  included. Users and operators are responsible for the applicable MinerU
  licenses, service terms, attribution requirements, and document-upload policy.
- **Codex CLI** — Optional integration launches a separately installed Codex CLI.
  No Codex source code or binary is included. The open-source Codex CLI repository
  is licensed under the Apache License 2.0; use of accounts and hosted services is
  also subject to the applicable OpenAI terms.
- **Claude Code** — Optional integration launches a separately installed Claude
  Code executable. Claude Code is not distributed under this plugin's MIT License;
  its use is subject to the applicable Anthropic commercial or consumer terms.
- **OpenCode** — Optional integration launches a separately installed OpenCode
  executable. No OpenCode source code or binary is included. OpenCode source code
  is MIT-licensed; hosted providers and models may have separate terms.
- **CC Switch** — Research Agent Reader may recognize configuration managed by a
  separately installed CC Switch application. No CC Switch source code or binary
  is included. CC Switch source code is MIT-licensed.

Research Agent Reader can also connect to user-configured model endpoints and
local runtimes, including OpenAI-compatible APIs, OpenRouter, Ollama, and LM
Studio. These services and applications are not distributed with the plugin and
remain governed by their respective terms.

## Development-only dependencies

The source repository uses development tools and type packages that are not
bundled into the plugin release, including esbuild (MIT), TypeScript
(Apache-2.0), `@types/node` (MIT), and the Obsidian API type package (MIT).
Transitive development packages remain under the licenses declared by their
respective maintainers.

## Names and trademarks

All third-party names, product names, project names, logos, and trademarks are
the property of their respective owners. Their use here identifies compatible
software and services and does not imply affiliation, sponsorship, endorsement,
or official support. Research Agent Reader is an independent community project.


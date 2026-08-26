# Security policy

## Supported versions

Security fixes are applied to the latest published release. Until the first
public release, the `main` branch is the only supported development line.

## Reporting a vulnerability

Do not disclose a vulnerability in a public issue before the maintainer has had
an opportunity to assess it. Contact the maintainer through GitHub private
vulnerability reporting after the public repository is created. If private
reporting is unavailable, open a minimal issue requesting a private contact
channel without including exploit details.

## Trust boundaries

Research Agent Reader is a desktop plugin and inherits the filesystem and network
permissions of Obsidian. It can launch only explicitly supported local programs,
using argument arrays rather than shell command strings. Optional workflow
actions may modify vault files and therefore use bounded paths, task history,
validation, and rollback contracts.

The plugin does not install or update external executables. Users must install
and authenticate optional CLI backends themselves. Direct API keys are selected
through Obsidian SecretStorage and are not stored in plugin `data.json`.

When reporting a vulnerability, include the plugin version, Obsidian version,
operating system, affected feature, minimal reproduction, and whether an
optional external backend was involved. Remove credentials, private note
content, and personal filesystem paths from logs.

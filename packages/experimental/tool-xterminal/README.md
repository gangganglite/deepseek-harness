---
description: "Find saved XTerminal server endpoints from a local Harness profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tool-xterminal

English | [中文](README.zh.md)

## Summary

Find servers saved in XTerminal by name or host. Harness can remember one read-only catalog per profile. Queries return names, hosts and ports. Approved remote operations use password or private-key authentication from the local catalog.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Install the local package archive with `dsh plugin --profile <name> add file:/absolute/path/to/the-archive.tgz`, or select the archive in the Desktop plugin manager. The profile loads [the bundle patch](cordis.patch.yml) automatically. For source development, pass `cordis.source.patch.yml` to `dsh --patch`.

On macOS the plugin checks XTerminal's standard application-data location. A Host operator can set `allowedRoots` to absolute paths of additional trusted local directories. If discovery fails, the model can submit a validated candidate once. Use directories whose contents are controlled by the local operator. On macOS, connections reuse the SHA-256 fingerprint XTerminal has trusted for the exact host and port. Set `hostKeys` with trusted OpenSSH SHA-256 fingerprints indexed by `host:port` to override those entries or configure additional hosts. The profile must expose approvals and background jobs. Set at least two parallel tool slots to use independent targets concurrently.

`xterminal_connect` defaults to `mode: "plugin"`. Use `mode: "harness"` when the task requires Harness to initiate the connection. Harness uses a single-use reference inside its local process to authenticate with the target's saved password or private key. Either mode enables `xterminal_run` for the selected target in the current task. Repeated calls in the same mode reuse the connection. A different mode can connect to the same target once the existing connection or attempt ends.

<a id="model-experience"></a>
## Model Experience

### Tool schemas and results

#### What the model sees

The [XTerminal tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-xterminal) cover endpoint lookup, first-time catalog configuration, connection and command execution. Use the exact saved name, host and port to select a target. The default command timeout is 120 seconds after approval. Long results return a preview of at most 3000 characters, an output file path and a job ID. Check the job state for completion or failure. A command that the SSH server refuses to start returns a tool error.

#### Token effect

Four fixed tool schemas are sent while visible.

#### KV Cache effect

The tool schemas are stable across queries and path configuration changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Hosts missing from the trust file and profile configuration require a trusted fingerprint before the plugin can connect. Authentication requires the saved password or private key to be readable by the local process.
- Closed output files are retained for 30 days by default. Set `outputRetentionDays` to change the period.
- An existing saved path persists across restarts. If it becomes invalid, repair the profile's local configuration.

<a id="dev-note"></a>
### Dev Note

None.

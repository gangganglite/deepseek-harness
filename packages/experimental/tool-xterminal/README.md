---
description: "Find saved XTerminal server endpoints from a local Harness profile."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-xterminal

English | [中文](README.zh.md)

## Summary

Find servers saved in XTerminal by name or host. Harness can remember one read-only catalog per profile. Queries return names, hosts and ports. Approved remote operations use password or private-key authentication from the local catalog.

## Use this package

Opt in by launching a local profile with the package's `cordis.source.patch.yml` from a source checkout. On macOS the plugin checks XTerminal's standard application-data location. A Host operator can set `allowedRoots` to absolute paths of additional trusted local directories. If discovery fails, the model can submit a validated candidate once. Use directories whose contents are controlled by the local operator. To connect, configure `hostKeys` with trusted OpenSSH SHA-256 fingerprints indexed by `host:port`. The profile must expose approvals and background jobs. Set at least two parallel tool slots to use independent targets concurrently.

## Model Experience

`xterminal_search_servers` finds and pages through endpoint records. `xterminal_set_database_path` initializes the catalog location when discovery cannot resolve it. `xterminal_connect` and `xterminal_run` identify their target by the exact name, host and port. Long command results return a preview of at most 3000 characters, an output path and a job ID while the file grows. Check the job status before treating the saved output as complete. A command that the SSH server refuses to start returns a tool error. After an early preview, check the job for failures. The default command timeout is 120 seconds after approval. These tools add schemas to the model request prefix.

#### KV Cache effect

The tool schemas are stable across queries and path configuration changes.

## Known Limitations and Deferred Work

- Host key trust comes from profile configuration. Authentication requires the saved password or private key to be readable by the local process.
- Closed output files are retained for 30 days by default. Set `outputRetentionDays` to change the period.
- An existing saved path persists across restarts. If it becomes invalid, repair the profile's local configuration.

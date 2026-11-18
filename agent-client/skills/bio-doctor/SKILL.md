---
name: bio-doctor
description: Check whether Bioagent's local WSL or future laboratory-server capability profiles are actually available. Use before claiming that a local dependency, R package, Bio CLI, or heavy workflow environment can be executed.
---

# Bioagent Environment Doctor

This Skill invokes the independently packaged CLI. Before use, verify the
command from the Agent Shell:

```bash
bio-doctor --describe --format json
bio-doctor check --format json
```

Use a focused profile when a task has known requirements:

```bash
bio-doctor check --profile bioagent-r-core --format json
bio-doctor check --profile bioagent-local-cli --format json
bio-doctor check --profile bioagent-ngs --format json
```

Treat the JSON result as authoritative for this run. `available` means all
profile requirements were found. `partial` means the result lists missing local
dependencies; do not claim the profile can execute. `server_required` means the
profile belongs on the laboratory Linux server and has not been remotely probed.

`bio-doctor` is read-only. It does not install software, download data, modify
configuration, or submit remote work. Report missing requirements and request
installation or a server execution setup rather than attempting to repair the
environment implicitly.

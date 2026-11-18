# bio-doctor

`bio-doctor` is a machine-first, read-only CLI for checking whether a declared
Bioagent capability profile is usable in the current environment. It never
installs software, edits configuration, downloads data, or connects to a
laboratory server.

The command reports facts rather than inferring capability from installed Skill
documentation. A local profile may be `available` or `partial`; a profile
reserved for the lab server reports `server_required` until a separate remote
execution adapter is implemented.

## Run locally

```bash
# 从仓库根目录执行
cd clitool/biodoctor
npm test
npm link

bio-doctor --describe --format json
bio-doctor profiles --format json
bio-doctor check --profile bioagent-r-core --format json
bio-doctor check --format json
```

For deployment use `npm install -g /absolute/path/to/biodoctor`, then restart
the Agent backend if it was started before the Node global bin directory was on
its PATH. `BIOAGENT_ENV_BIN` can point at a project-managed environment bin
directory; when running from this repository the command also discovers the
local `.bioenv/bin` directory.

## Profiles

| Profile | Location | Purpose |
| --- | --- | --- |
| `bioagent-r-core` | WSL | Rscript plus the direct R dependencies for small bulk RNA-seq work. |
| `bioagent-local-cli` | WSL | Installed Bioagent discovery and lightweight-analysis commands. |
| `bioagent-ngs` | Lab server | Heavy NGS execution requirements; this CLI does not make SSH connections. |

All successful commands print a single JSON document to stdout. Missing
software is an expected diagnostic fact and still exits 0; only malformed
arguments or a doctor implementation failure return a nonzero status.

See the shared [CLI development and integration boundary](../docs/clitool-development-boundary.md).

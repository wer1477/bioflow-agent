---
name: bio-report
description: Assemble a reproducible Markdown (and optional PDF) analysis report from tool manifests, result tables, figures and methods notes. Use after an analysis or pipeline run when the user needs a shareable report that records commands, parameters, software versions, tables, figures and sha256 provenance.
---

# Bio Report CLI

`bio-report` turns artifacts an analysis already produced into one report. It
does not run analysis, download data, or invent methods text: it only reads
what exists and records it faithfully.

Verify `command -v bio-report` before use, then discover the installed contract:

```bash
bio-report --describe --format json
bio-report build --help
```

`--describe` is the source of truth for options; the section below is the
workflow, not a parameter table.

## When to use

Use it after a run has produced manifests, result tables or figures and the
user wants a report, supplementary methods section, run record, or provenance
trail. Do not use it to perform the analysis itself, and do not use it to
polish prose into a publication draft.

## Workflow

1. **Check the environment once per session.**

   ```bash
   bio-report check
   ```

   Read `ok` (interpreter works) and `pdf_ready` (matplotlib available). If
   `pdf_ready` is false, build Markdown only and pass the `hint` to the user;
   never retry `--pdf` blindly.

2. **Collect the real paths.** Gather `--manifest` files, `--results-dir`
   directories, `--figures-dir` directories and the `--methods` Markdown that
   already exist in the workspace. Do not invent manifests to fill gaps.

3. **Preview before writing.**

   ```bash
   bio-report build --manifest run/star.json --results-dir results \
     --figures-dir figures --methods methods.md \
     --output out/report.md --pdf out/report.pdf --dry-run
   ```

   Confirm `inputs`, `outputs` and `actions` match the intended run. A dry run
   reads nothing and writes nothing.

4. **Build for real.** Drop `--dry-run`. Then read the JSON `outputs` paths to
   report back; do not re-read the whole Markdown unless the user asks.

5. **Re-run after new artifacts.** `build` is deterministic and idempotent:
   rerunning it with the same inputs overwrites the same files. It never
   appends and never mutates inputs.

## Reading the output

- `ok: true` and `outputs.markdown` — the report is complete.
- `ok: false` with `outputs.markdown` present — the Markdown exists but the
  PDF failed; stderr carries `error[pdf-unavailable]` or `error[pdf-failed]`
  plus a `hint`. Report the partial success explicitly instead of claiming
  failure of the whole run.
- `warnings` — manifests usually warn about a missing version or an
  unavailable sha256. Surface them when provenance matters; they are not fatal.
- `counts` — `manifests`, `tables` and `figures` as consumed. Zero counts for a
  category mean that input was not supplied or that directory was empty; check
  the paths rather than trusting an empty section.
- Exit code `2` with an empty stdout and a JSON error on stderr means a usage
  or path problem: fix the flag (an unknown option, a missing value, a
  non-existent path) and retry. The error `hint` names the help command.

## Risks and limits

- **Overwrite.** `--output` and `--pdf` are overwritten without confirmation.
  Never point them at an existing user document; prefer a fresh output
  directory.
- **No secrets filtering.** Manifest parameters, commands and file paths are
  copied into the report verbatim. Before sharing, check that they contain no
  credentials, private paths or unpublished sample identifiers.
- **Hashes are heavy.** sha256 is computed for figures and for manifest-listed
  files up to 64 MiB; larger files must carry their digest in the manifest.
  Do not re-run repeatedly on huge inputs without need.
- **Tables are truncated.** Each table shows the first 20 rows and 12 columns
  plus full row/column counts. Never answer a question about a tail row from
  the report alone.
- **PDF is text-only.** matplotlib renders the report as fixed-width text
  pages; embedded figures are not composited into the PDF. For a figure-rich
  document, deliver the Markdown plus the figure files.
- **Relative manifest paths** resolve against the manifest's own directory.
  Keep manifests next to the files they reference, or use absolute paths.
- **Methods text is copied, not rewritten.** Headings are only shifted to nest
  under the Methods section. Do not paste unpublished or embargoed text into a
  report that will be shared.

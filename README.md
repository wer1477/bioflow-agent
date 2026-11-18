# Bioflow Agent

**A local-first, team-based bioinformatics agent with a trained decision layer.**

Bioflow runs a small research team — PI, Searcher, Researcher, Writer, and Reviewer — on top of a bioinformatics runtime. Instead of asking the main LLM to make every small choice, it delegates five routine coordination decisions to a locally served 4B decision model:

| Decision | Question | Fallback |
|---|---|---|
| `tool_select` | Which capability should be loaded next? | browse the catalog |
| `kb_select` | Which knowledge entries are relevant? | index/catalog |
| `context_retention` | Which context groups should be kept? | rule-based prior |
| `role_select` | Which role should answer this message? | PI |
| `relay_select` | May this role-to-role relay proceed? | escalate to PI |

Every decision is logged with its confidence, latency, and model version. Any failure falls back to the original path; a session never blocks on the decision layer.

## Why this design

Bioinformatics work is a long sequence of small, consequential choices: the right tool, the right reference build, the right knowledge, the right owner for a message. General-purpose agents make these choices implicitly inside the main LLM. Bioflow separates them:

- **Bounded decisions → a small, trained model.** The 4B `biod-mt-v2` layer answers typed multiple-choice questions in one forward pass (76–538 ms p50 on a single GPU).
- **Open reasoning → the main LLM.** The main model plans, writes code, interprets results, and handles anything the decision layer is unsure about.
- **A fixed team → explicit handoffs.** Five roles share a workspace but not a transcript; handoffs are runtime-generated cards, and role-to-role relays pass through a gate.
- **Audit by default.** Decisions, tool calls, artifacts, and run manifests are recorded so an analysis can be inspected and re-run.

## Architecture

```text
User
 │
 ▼
PI ── decompose / dispatch / arbitrate / accept
 ├─ Searcher   literature, evidence, hypotheses
 ├─ Researcher design, execution, statistics, interpretation
 ├─ Writer     narrative, figures, citations, submission
 └─ Reviewer   novelty, methods, statistics, consistency

Shared workspace · merged timeline · no shared transcript

Main LLM ──HTTP──► biod sidecar (4B, 7 heads)
                     tool / kb / context / role / relay
                     + S2 / R1 / W1 / V1 audit points
```

## What is in this repository

- `agent-client/backend` — the agent runtime, REST/SSE API, team orchestration, decision-layer integration.
- `agent-client/web` — the web UI.
- `agent-client/skills`, `knowledgebase`, `toollibrary` — on-demand capability and knowledge catalogs.
- `clitool/` — bioinformatics CLI tools used by the agent.
- `services/biod2-4b/` — the decision-layer service unit (weights are downloaded separately).
- `docs/` — architecture, deployment, development, and decision-layer integration notes.

## Quick start

```bash
# 1) Python/R environment
micromamba env create --prefix "$PWD/.bioenv" --file environment.yml
source scripts/activate-bioenv.sh
scripts/setup-cli-tools.sh --skip-homer-data

# 2) Node dependencies
cd agent-client && npm run install:all && cd ..

# 3) Configure an LLM endpoint
cp agent-client/.env.example agent-client/backend/.env
# edit agent-client/backend/.env

# 4) Run
./bioflow --port 3000
```

Open `http://localhost:3000`. The API health check is `GET /api/health`.

For the decision layer, see `services/biod2-4b/README.md` and `docs/biod-integration.md`. The 4B weights are released on Hugging Face at `wer1477/biod-mt-v2-4b`; download them into `services/biod2-4b/weights/` with `services/biod2-4b/bin/download-weights.sh`, then start the sidecar with `services/biod2-4b/bin/start.sh`.

## Evaluation

The system is evaluated on public plant bioinformatics benchmarks, including PhytoBench-Analysis and BixBench, with ablations for the team and the decision layer. Benchmark adapters, prompts, and scores will be released in a companion repository (`plant-benchmark`) together with the paper.

## Citation

If you use Bioflow in your research, please cite the paper (in preparation) and this repository. A `CITATION.cff` is provided.

## License

Apache-2.0. Third-party skills and knowledge entries retain their original licenses; see `NOTICE`.

## Security

Bioflow executes local commands and Python/R analyses. Run it only in a trusted workspace. To report a vulnerability, see `SECURITY.md`.

---

中文说明见 [README.zh.md](README.zh.md)。

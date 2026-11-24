# Bioflow Agent

**A local-first, team-based bioinformatics agent with a trained decision layer.**

Bioflow runs a small research team — PI, Searcher, Researcher, Writer and Reviewer — on top of a
bioinformatics runtime. The main LLM plans, writes and executes code and interprets results; a small
locally served decision model (`biod-mt-v2`) answers three typed decisions so that the installed
capability and knowledge catalogs can grow without the main prompt growing with them.

| Decision | Question | Fallback |
|---|---|---|
| capability selection (`tool_select`) | Which capability should be loaded next? | browse the catalog |
| knowledge selection (`kb_select`) | Which knowledge entries are relevant? | index / catalog |
| context retention (`context_retention`) | Which cold-zone context groups should be kept? | rule-based baseline |

Role routing and relay gating are separate team-layer calls to the same sidecar; they are not part of
the three evaluated decisions described in the accompanying manuscript. Every sidecar decision is
logged with its confidence, latency and model version, and every failure mode falls back to the
original path — a session never blocks on the decision layer.

## Why this design

Bioinformatics work is a long sequence of small, consequential choices: the right tool, the right
reference build, the right knowledge, the right owner for a message. General-purpose agents make
these choices implicitly inside the main LLM. Bioflow separates them:

- **Bounded decisions → a small, trained model.** The sidecar answers typed multiple-choice questions
  in one forward pass and returns a bounded label or score.
- **Open reasoning → the main LLM.** The main model plans, writes code, interprets results and
  handles anything the decision layer is unsure about.
- **A fixed team → explicit handoffs.** Five roles share a workspace but not a transcript; handoffs
  are runtime-generated cards.
- **Audit by default.** Decisions, tool calls, artifacts and run manifests are recorded so an
  analysis can be inspected and re-run.

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

Main LLM ──HTTP──► biod sidecar (4B)
                     capability / knowledge / context decisions
                     (role routing and relay gating are team-layer calls)
```

## What is in this repository

- `agent-client/backend` — the agent runtime, REST API (NDJSON run stream), team orchestration and
  the decision-layer HTTP client.
- `agent-client/web` — the web UI; it consumes `/api` only.
- `agent-client/skills`, `knowledgebase`, `toollibrary` — on-demand capability and knowledge catalogs.
- `clitool/` — bioinformatics CLI tools used by the agent.
- `docs/` — architecture, deployment, development and decision-layer integration notes.

The decision model itself (training code, serving code and weights) lives in the companion repository
[Biod](https://github.com/wer1477/bioflow-biod).

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

## Decision-layer weights

The evaluated sidecar checkpoint is released at
[huggingface.co/wer1477/biod-mt-v2-4b](https://huggingface.co/wer1477/biod-mt-v2-4b): a frozen
Qwen3.5-4B-Base text tower with LoRA adapters and five routing heads. Download it with
`scripts/download-weights.sh` from the Biod repository, then point the backend at the Biod checkout
and the checkpoint:

```bash
# agent-client/backend/.env
BIOFLOW_BIOD_PYTHON=/path/to/Biod/.venv/bin/python
BIOFLOW_BIOD_REPO=/path/to/Biod
BIOFLOW_BIOD_CKPT=/path/to/biod-mt-v2-4b
```

The backend starts the sidecar on demand and falls back to browsing when it is unavailable. See
`docs/biod-integration.md` and the Biod repository for the serving contract.

## Evaluation

This repository contains the runtime and the decision-layer integration. The controlled evaluation in
the accompanying manuscript — verified-asset reuse, native tool selection, knowledge selection,
cold-zone retention, and a public plant-workflow case — used frozen harnesses, prompts, configuration
fingerprints and result tables that are provided with the review package rather than in this
repository. No benchmark score is claimed here.

## Citation

If you use this software, please cite the paper and this repository. See `CITATION.cff`.

## License

Apache-2.0. The base model is governed by the Qwen model license; see `NOTICE`.

## Security

Please do not open a public issue for a suspected vulnerability. See `SECURITY.md`.

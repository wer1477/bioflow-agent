# Bioflow Backend Config

`bioflow` validates this directory on startup and reads these files directly at runtime. They are the configuration source of truth; no database sync occurs.

Use `BIOFLOW_CONFIG_DIR` to point to another config directory.

Files:

- `llm.json`: LLM providers and their models (see [LLM providers and models](#llm-providers-and-models)).
- `llm_presets.json`: hand-maintained overlay for mainstream provider presets (OpenAI-compatible base URLs, curated model order, featured ranking). Optional; see the catalog paragraph below.
- `agents.json`: the fixed five-role research team, each role's prompt file reference and its CoreTool, Tool Library (skills + MCP), and knowledge-entry bindings, plus the team-level routing policy.
- CoreTools are configured per agent through `coreToolIds`. The runtime loads only the configured ids; a legacy record without the field keeps every registered CoreTool, and an explicit `[]` disables them all. The two capability families are the exception: `toollibrary` / `knowledgebase` are always resident, and binding them only hands capability selection to biod — leaving them out degrades the same call to a browse result the model chooses from (and biod failures fall back to that same path). The shipped five-role config leaves `toollibrary` unbound and sets `biod.json` `tool_select.mode` to `off`, so tool selection runs in llm mode; `knowledgebase` keeps its biod decision point.
- `mcp.json`: MCP server definitions. A server with `"internal": true` backs a built-in runtime tool (currently the `web_search` providers `tavily` / `exa`): it stays connected, but its tools and resources are hidden from the tool library.
- `biod.json` configures the five routing decisions and the optional local decision sidecar. Existing configurations with a legacy `framework` block can still be read. The current tools expose capability selection and catalog browsing. See `docs/biod-integration.md`.
- `prompts/*.md`: prompt bodies referenced by `agents.json`.

Runtime history is not stored here. Conversations, messages, run records, tool events, approvals,
and artifacts are stored under `../../workspace/conversations` as local session snapshots and patch logs.
Bioflow permits exactly one backend process to use that workspace at a time; it is not a shared multi-instance store.

## LLM providers and models

`llm.json` is one document holding providers, and models nested inside them. A provider owns
the endpoint and the credential; a model owns the limits and the thinking levels.

```json
{
  "schemaVersion": 2,
  "defaultProviderId": "dgx",
  "providers": [
    {
      "id": "dgx",
      "presetId": "custom",
      "name": "DGX sglang",
      "baseUrl": "https://your-llm-endpoint/v1",
      "apiKey": "${BIOFLOW_LLM_API_KEY_DGX}",
      "thinkingFormat": "openai-effort",
      "defaultModelId": "RadixArk/Qwen3.8-Flash-Next-NVFP4",
      "models": [
        {
          "id": "RadixArk/Qwen3.8-Flash-Next-NVFP4",
          "label": "Qwen3.8 Flash Next",
          "contextWindowTokens": 1000000,
          "reasoningEfforts": { "medium": "medium", "high": "high", "max": "xhigh" },
          "defaultThinkingLevel": "max",
          "capabilities": { "tools": true, "images": false },
          "metadataSource": "probe"
        }
      ]
    }
  ]
}
```

- `headers` is an optional map of static request headers the endpoint requires. Some
  OpenAI-compatible gateways need one on every call: OpenCode's Zen/Go gateway answers
  `400 MissingSessionID` without `x-opencode-session` (its value is a stable client-session
  identifier, not a credential; OpenCode accepts any UUID and uses it for routing). Values
  accept `${ENV_VAR}` references like `apiKey`; a header name that looks secret
  (`authorization`, `*-token`, `*-key`, ...) must use one. Header names are validated as HTTP
  tokens and values may not contain CR/LF. The Web provider editor does not expose this
  field; it is set here, and a Web save preserves it because absent `headers` means "keep the
  current map". Runtime, probe and verify requests all send it.
- `protocol` declares the wire protocol. `openai-completions` (the default when the field is
  absent) posts to `{baseUrl}/chat/completions` with a bearer token; `anthropic-messages` posts to
  `{baseUrl}/messages` (or `{baseUrl}/v1/messages` when the base URL has no `/v1`) with `x-api-key`
  and `anthropic-version`; `openai-responses` posts to `{baseUrl}/responses`. The protocol is the
  **provider's** property, never inferred from the model name, and the runtime still speaks one
  OpenAI-shaped message model — adapters translate at the transport boundary. Unknown values are
  rejected on write and ignored on read, so an old `llm.json` keeps working unchanged.
- `thinkingFormat` decides how a thinking level reaches the endpoint. `openai-effort` sends
  `reasoning_effort: <value>`, `anthropic-budget` sends
  `thinking: {"type": "enabled", "budget_tokens": <value>}` (values must therefore be numbers),
  and `none` sends nothing. Under `anthropic-messages` the budget is native (the protocol requires
  `max_tokens > budget_tokens`, so `max_tokens` is raised to `budget + 1` when needed, and a budget
  below the protocol minimum of 1024 is not sent at all).
- `reasoningEfforts` maps a level **name** to the value that goes on the wire. They differ: the
  DGX sglang endpoint accepts `xhigh`/`medium`/`low` and answers 400 for `high`/`max`, while the
  catalog records `low`/`high`/`max` for that model family. Rename a level here; never type an
  endpoint's spelling into a role.
- `cacheReport` declares how the endpoint reports prefix-cache hits, because an absent counter is
  ambiguous otherwise. `none` (the default) means it never reports, so a missing counter is
  *unknown*. `hits-only` means it emits the field only on a hit — SGLang behaves this way even
  with `--enable-cache-report`, so a missing counter is a *miss*; declaring `none` here would hide
  every miss and display a 100% hit rate. `full` means it always reports, including an explicit
  zero (OpenAI, DeepSeek). Set it to match the endpoint, not to make a number look better; the
  stats API always returns the reporting coverage alongside the percentage.
- `cacheMode` declares whether the endpoint caches prefixes by itself (`auto`, the default: SGLang,
  OpenAI, DeepSeek) or only caches what the request marks (`explicit`: Anthropic Messages and
  Anthropic-compatible gateways such as DashScope). With `explicit` the client attaches
  `cache_control: {type: "ephemeral"}` to three places — the system message, the last tool
  declaration, and the last content block of the last message — because without a marker those
  endpoints cache nothing at all. Tools serialize ahead of every message, which is why the last
  tool gets its own breakpoint. Leave it `auto` for anything that does not document block-level
  cache markers; the field changes the wire body.
- `capabilities` is an assertion about the endpoint, not a probe result. A missing field means
  unknown, and unknown is not "supported".
- `metadataSource` records where a row came from (`catalog`, `probe`, `manual`). Importing from
  the catalog or from an endpoint never overwrites a `manual` row or a field the operator edited.
- A model without `contextWindowTokens` can be saved but cannot run: the runtime reports it
  explicitly rather than assuming a window.
- `agents.json` binds `llmProviderId`, plus optional `llmModelId` and `llmThinkingLevel`. A
  missing model means "this provider's default model"; a missing level means "the model's default
  level". A binding that names something absent is an error (HTTP 400), never a silent fallback.

The shipped catalog (`llm_catalog.json`) is generated, not hand-edited:
`npm --prefix backend run` is not needed — run `node scripts/generate-llm-catalog.mjs` in
`backend/` to refresh it from models.dev, then commit the result. The server never fetches it at
runtime, so a deployment without network still configures providers.

`llm_presets.json` is a hand-maintained overlay on top of that catalog. models.dev records SDK
packages rather than this deployment's OpenAI-compatible transport, so several mainstream providers
have no `api` there and a few publish native (non-Chat-Completions) endpoints. It is a **delta**: an
entry carries only what the catalog cannot know.

- `name` / `api`: display name and the OpenAI-compatible base URL (OpenAI, Anthropic, Google
  Gemini, Groq, Mistral, xAI, Together AI, Cerebras, and MiniMax, whose catalog entry points at an
  Anthropic-format endpoint). The overlay ships three groups: mainstream providers (domestic and
  international), subscription plans, and local/gateway options.
- `thinkingFormat`: the wire encoding this deployment sends (`openai-effort`, `anthropic-budget`,
  `none`); Anthropic's preset uses `none` because the compatibility layer has no native thinking
  budget — use a gateway (for example OpenRouter) if you need those controls.
- `modelIds`: a curated order, so the editor offers the current chat/tool models instead of
  embeddings, TTS and image models. `[]` means "endpoint-only" (Ollama, LM Studio): the editor
  probes the endpoint. A non-empty list whose ids have all rotated out of the catalog falls back to
  the catalog's full list, so stale curation never shows an empty provider.
- `protocol`: the wire protocol the preset speaks, when it is not Chat Completions. Only the
  `anthropic` preset declares it (`anthropic-messages`); everything else is OpenAI-compatible.
- `featured` / `priority`: the ranking that puts mainstream providers first in the create dialog.
  Non-featured presets carry a `priority` too, so curated gateways rank above the hundreds of
  aggregators that the raw catalog sorts by model count.

The shipped overlay has 29 entries. Six of them are **subscription plans** whose catalog id is the
plan endpoint rather than the vendor's main API — `zhipuai-coding-plan`, `kimi-code-plan-cn`,
`alibaba-token-plan-cn`, `xiaomi-token-plan-cn`, `minimax-cn`, `moonshotai-cn`. `minimax-cn` also
overrides `api` to `https://api.minimaxi.com/v1`, because the catalog records MiniMax's
Anthropic-format path and this deployment speaks OpenAI Chat Completions.

The catalog says what a provider *offers*; it does not say what this network can *reach*.

```bash
npm --prefix backend run probe:presets          # or: node scripts/probe-presets.mjs
node scripts/probe-presets.mjs --only coding --strict
```

The script asks every preset's `/models` endpoint without credentials and classifies the answer:
`needs-key` (401/403 — the path exists), `open` (2xx), `path-missing` (404 — wrong transport path),
`unreachable` (DNS/TCP/TLS never completed). Run it before shipping a preset change: from the lab
deployment network, `api.openai.com`, `generativelanguage.googleapis.com`, `api.mistral.ai`,
`api.x.ai`, `api.together.xyz` and `router.huggingface.co` do not connect, so those presets are only
usable behind a network-level proxy; everything domestic, plus OpenRouter, Groq, Cerebras, Fireworks,
Baseten, NVIDIA and MiniMax, answers within a second. The tool needs network and is never part of
`npm run test`.

Credentials and environment-variable names are not part of the overlay; they stay with the catalog.
The file is optional and loaded tolerantly — a missing or malformed overlay degrades to the raw
catalog and never stops the server. `test/llm_presets.test.ts` validates the shipped file against
`llm_catalog.json`, so a stale entry fails `npm run test` instead of surfacing as a shorter list.
Regenerating `llm_catalog.json` never removes these values.

The shipped `llm.json` stays minimal: it ships the `dgx` system provider and nothing else from this
preset list, so the settings page does not list extra, key-less providers. Mainstream providers are
available from `llm_presets.json` when creating a provider; the user supplies the API key there and
the key is written to the local environment file as usual. Anthropic's preset keeps
`thinkingFormat: "none"` while speaking `anthropic-messages`: the native endpoint makes the
`cache_control` breakpoints real, but a per-model token budget is the operator's choice, so the
editor's "generate a budget ladder" button stays the way to opt in.

## The team

`agents.json` describes exactly one team. `schemaVersion: 2` carries a top-level `team` block and an
`agents` array whose entries are the five fixed roles:

```json
{
  "schemaVersion": 2,
  "team": {
    "leadRoleId": "pi",
    "roles": ["pi", "searcher", "researcher", "writer", "reviewer"],
    "router": { "engine": "always-pi", "fallbackRoleId": "pi" },
    "limits": { "maxConcurrentDispatches": 3 }
  },
  "agents": [
    {
      "id": "pi",
      "name": "PI",
      "label": "PI",
      "description": "研究目标、任务分配、决策与成果验收",
      "orchestratorDescription": "需要拆解目标、分派任务、仲裁分歧或验收成果时使用",
      "promptFile": "prompts/pi.md"
    }
  ]
}
```

| Role | Label | Owns |
| --- | --- | --- |
| `pi` | PI | research goals, task assignment, decisions, outcome acceptance |
| `searcher` | Searcher | literature search, evidence synthesis, question framing, hypotheses |
| `researcher` | Researcher | study and experiment design, execution, statistics, result interpretation |
| `writer` | Writer | paper structure and narrative, figures, writing, references, submissions |
| `reviewer` | Reviewer | novelty, hypothesis soundness, methodology, data and statistics, consistency |

- The role set is fixed. `PUT /api/config/manage/agents/:id` edits one role; roles cannot be added or
  deleted from the settings surface.
- `label` is the short name shown in the team switcher and on message badges.
  `orchestratorDescription` tells the lead when to hand work to that role.
- `team.router.engine` is `always-pi` today. `rules+llm` and `biod` are reserved so a later release can
  switch routing engines without a schema change; `team.router.fallbackRoleId` is where undecidable
  turns go.
- `team.limits.maxConcurrentDispatches` caps how many delegations may run at the same time. It never
  caps the total amount of work.
- `PUT /api/config/manage/team` writes `team.leadRoleId`, `team.router` and `team.limits`.

### Upgrading a single-agent deployment

`ensureTeamRoles()` runs on every start and is idempotent:

1. a legacy `main` record becomes `pi` and keeps every capability binding; `prompts/main.md` is copied
   to `prompts/pi.md` when the latter is missing;
2. missing roles are created from built-in defaults and inherit the lead's bindings, so a migrated
   deployment is usable immediately;
3. records that are not team roles are dropped;
4. the file is only rewritten when something actually changed.

## Agent prompts

Each role's prompt lives in a Markdown file and is referenced from `agents.json`:

```json
{
  "id": "pi",
  "promptFile": "prompts/pi.md"
}
```

## Agent bindings

`agents.json` carries four independent selection lists:

| Field | Unit | Source of truth |
| --- | --- | --- |
| `coreToolIds` | CoreTool id from the runtime registry (`shell`, `file`, `search`, `toollibrary`, `knowledgebase`, ...) | `CORE_TOOL_REGISTRY` in `backend/src/agent/core_tools_runtime.ts` |
| `skillIds` | Skill id (`skills/<id>`) | `agent-client/skills/` |
| `mcpServerIds` | MCP server id | `mcp.json` |
| `knowledgeEntryIds` | Knowledge-base entry id (`<domain>/<entry>`) | `agent-client/knowledgebase/<domain>/<entry>/` |

- A legacy record without `coreToolIds` / `knowledgeEntryIds` gets the pre-2026-11 behavior (every registered CoreTool / every knowledge entry). A record that still carries the previous `knowledgeDomainIds` binding is expanded to the entries those domains contain when the config is read. Saving from the Agent settings page writes the explicit lists, so an empty array is respected from then on.
- `toollibrary` and `knowledgebase` in `coreToolIds` mean "delegate capability selection to biod", not "make the tool available": both tools are injected for every role either way (`residentCoreToolIds`). Unbound → `toollibrary` / `knowledgebase` `select` returns the browse result with `biod={status:"off",reason:"not_configured"}` and the model chooses.
- `enabled` is not a role field: all five roles are always active, and there is no per-role off switch.
- Tool Library and Knowledge Base are display layers. The settings API projects them by domain for the Agent page; the page never writes `toollibrary/` or `knowledgebase/`.

### Role capability matrix

The roles share one capability pool but bind different subsets of it. The lead keeps everything
because it has to judge and fill gaps; each specialist binds what its duties in `prompts/*.md`
actually need. `coreToolIds` is the same for every role — including `team_message`, which every role needs because a role has to be able to deliver to the lead and ask a peer for information. What differs is the *actions*: the lead gets `delegate` / `append` / `relay`, a role gets `deliver` / `relay`.

| Role | `mcpServerIds` | `skillIds` | `knowledgeEntryIds` |
| --- | --- | --- | --- |
| `pi` | all 8 | all 45 | all 38 |
| `searcher` | `tavily`, `exa`, `tooluniverse`, `biomcp`, `biocontext` | `science-search`, `curated-bio-datasets`, `bioservices`, `gget`, `lit-review`, `hypothesis-design`, `experiment-design`, `evidence-appraisal` | 3 original general-science entries + 8 bioinformatics overviews + 4 new method entries (15) |
| `researcher` | `tavily`, `exa`, `context7`, `tooluniverse`, `biomcp`, `chatspatial`, `seqera`, `biocontext` | every analysis skill (35) + `experiment-design`, `evidence-appraisal` | all 38 |
| `writer` | `tavily`, `exa`, `context7`, `biomcp`, `biocontext` | `science-search` + the three clinical document skills + `scientific-writing`, `evidence-appraisal`, `peer-review` | all 6 general-science method entries + 4 existing entries |
| `reviewer` | `tavily`, `exa`, `tooluniverse`, `biomcp`, `biocontext` | `science-search`, `bio-workflow`, `lit-review`, `hypothesis-design`, `experiment-design`, `scientific-writing`, `peer-review`, `evidence-appraisal` | 4 general-science entries + 8 bioinformatics overviews + all 6 method entries |

- `tavily` / `exa` stay bound to every role. `web_search` is dispatched against the agent's own
  connected MCP servers, so dropping them turns the CoreTool into `NO_WEB_SEARCH_PROVIDER` even
  though `web_search` is still in `coreToolIds`. `backend/test/agent_capability_bindings.test.ts`
  guards this invariant.
- `context7` (library documentation) belongs to the roles that write code. `tooluniverse` and
  `biomcp` cover cross-database evidence discovery and biomedical evidence checks; `biocontext`
  adds the hosted OLS/HPA/PRIDE/PanglaoDB/ClinicalTrials.gov/FDA/grants/Europe PMC layer without a
  local install. These read-only evidence servers are shared by every role that has to verify a claim.
- The `bio-*` CLI skills and the tool-analysis skills are execution capabilities, so they
  stay with the researcher; `science-search` is shared by every role that must verify a reference or
  a claim; the clinical document skills (`clinical-reports`, `treatment-plans`,
  `clinical-decision-support`) belong to the writer; `bio-workflow` and `skill-creator` stay with the
  roles that review reproducibility and manage capability.
- The research-method skills follow the same ownership split: `lit-review` for the searcher/reviewer,
  `hypothesis-design` for the searcher/reviewer, `experiment-design` for the researcher/searcher/
  reviewer, `scientific-writing` for the writer/reviewer, `peer-review` for the reviewer/writer, and
  `evidence-appraisal` for every role that has to verify a claim.
- Knowledge entries follow the same split: the researcher binds all 38 because it runs every
  analysis; the searcher / reviewer / writer bind the interpretive and method subset their output
  depends on (experimental design, statistics, file formats, workflow overviews, ACMG/clinical
  interpretation, search/synthesis, evidence quality, causal inference, writing, and peer review).

## Skills

Skills are configured and stored by folders under `../skills`, not by a single JSON file. Each skill
folder must contain `SKILL.md`, with optional files under `resources/`.

Example:

```text
skills/
  curated-bio-datasets/
    SKILL.md
    resources/
```

Agent skill bindings in `agents.json` may use a skill id, an 8-character id prefix, or the skill
`name` from `SKILL.md`.

Environment variables in string values use `${NAME}` interpolation. For example:

```json
{
  "apiKey": "${BIOFLOW_LLM_API_KEY}"
}
```

Credential fields (`apiKey`, secret-bearing MCP `env` entries, and authorization headers) are stored as environment variable references. Web/CLI configuration may receive a literal value, then writes it to the local environment file and replaces it with a reference before saving JSON. Bioflow never exposes secret-bearing config files through its HTTP file browser.

The bundled configuration requires these variables before its default LLM and MCP servers can be used:

```text
BIOFLOW_LLM_API_KEY_DGX
BIOFLOW_TAVILY_API_KEY          # tavily（streamableHttp，url 里的 tavilyApiKey）
BIOFLOW_MCP_EXA_X_API_KEY       # exa（streamableHttp，header x-api-key）
BIOFLOW_MCP_CONTEXT7_API_KEY    # context7（streamableHttp，header CONTEXT7_API_KEY）
```

The optional `opencode-go-2` provider additionally needs
`BIOFLOW_LLM_API_KEY_OPENCODE_GO_2`; its `x-opencode-session` header is already recorded in
the provider's `headers` map and needs no environment variable.

Copy `../../.env.example` to `../.env` and set the values, or export them in the shell before startup. The default LLM entry currently uses the `dgx` provider:

```dotenv
BIOFLOW_LLM_API_KEY_DGX="..."
BIOFLOW_TAVILY_API_KEY="..."
BIOFLOW_MCP_EXA_X_API_KEY="..."
BIOFLOW_MCP_CONTEXT7_API_KEY="..."
```

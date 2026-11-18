# Scientific Search and External Data

## Context7 (Code Library Documentation)

- Context7 Resolve Library ID（mcp：context7_resolve-library-id）：Resolve a package or product name to a Context7 library ID; call this before querying library docs unless the user already provided an ID in /org/project form.
- Context7 Query Docs（mcp：context7_query-docs）：Retrieve up-to-date documentation and code examples by library ID; resolve the library ID first and never guess one.

## Skills

- science-search（skill：science-search）：Search, retrieve, and download biomedical literature, clinical variant, chemistry, protein-structure, and omics records through the Science Connectors CLI. Use for PubMed, Europe PMC, bioRxiv, OpenAlex, Semantic Scholar, Crossref, arXiv, UniProt, ClinVar, Open Targets, ChEMBL, AlphaFold DB, GEO, CELLxGENE, and the other sources reported by the runtime registry.
- lit-review（skill：lit-review）：Run a reproducible literature review from question framing and search logs to screening counts, evidence tables, synthesis, and gap lists. Use for related-work surveys, research-landscape questions, and novelty checks; includes PRISMA-style counting and citation verification.
- curated-bio-datasets（skill：curated-bio-datasets）：Guide to accessing curated biological datasets for computational biology. COSMIC cancer data, GTEx expression, GWAS catalog, GeneBass exome variants, BioGRID interactions, MSigDB gene sets, DisGeNET disease-gene associations, and GO ontology. For specific database APIs use individual database skills (cosmic-database, gwas-database, etc.).
- bioservices（skill：bioservices）：Unified Python interface to 40+ bioinformatics services. Use when querying multiple databases (UniProt, KEGG, ChEMBL, Reactome) in a single workflow with consistent API. Best for cross-database analysis, ID mapping across services. For quick single-database lookups use gget; for sequence/file manipulation use biopython.

## BioMCP (Biomedical Evidence, Read-Only)

- BioMCP Cross-Entity Search（mcp：biomcp_search）：Read-only search across gene, variant, literature, clinical trial, drug, disease, pathway, protein, and adverse-event entities; federated literature search (PubTator3/Europe PMC/PubMed). A good first hop for clinical and translational questions.
- BioMCP Detail Card（mcp：biomcp_get）：Fetch entity details by section, e.g. gene BRAF pathways hpa, variant "BRAF V600E" clinvar, trial NCT…; use it to obtain structured evidence cards.
- BioMCP Variant Articles Shortlist（mcp：biomcp_variant_articles）：Fetch a bounded shortlist of articles for 1–10 variants in one call; shares a 60s upstream budget and may return partial results.
- BioMCP Read-Only Command Escape Hatch（mcp：biomcp_biomcp）：Pass-through for read-only CLI commands (discover, skill list/render, single-page citation/reference traversal); prefer the typed tools.

## ToolUniverse (Long-Tail Research Tool Gateway)

- ToolUniverse List Tools（mcp：tooluniverse_list_tools）：List the tool names available in the gateway by category; locate tools with grep_tools/get_tool_info before calling execute_tool.
- ToolUniverse Grep Tools（mcp：tooluniverse_grep_tools）：Search the name/description of 2,700+ tools by keyword or regex; suitable for finding a tool before executing it.
- ToolUniverse Tool Info（mcp：tooluniverse_get_tool_info）：Read a single tool's full definition, parameter schema, and provenance; always check before executing.
- ToolUniverse Execute Tool（mcp：tooluniverse_execute_tool）：Execute a gateway tool by name and return its result; use it for long-tail queries not covered by science-search or existing CLIs.
- ToolUniverse Find Tools（mcp：tooluniverse_find_tools）：Retrieve the best-matching tools from a natural-language intent description (may trigger an extra LLM call/latency); use it when the tool name is unclear.

## BioContext (Literature, Ontologies, and Open Targets, Read-Only)

- BioContext Europe PMC Articles（mcp：biocontext_get_europepmc_articles）：Search Europe PMC by query, title, abstract, or author; returns article metadata. Use for literature discovery and for checking whether a citation exists.
- BioContext Europe PMC Full Text（mcp：biocontext_get_europepmc_fulltext）：Fetch full-text XML for a PMC ID; use after identifying an open-access article to verify what the text actually says.
- BioContext bioRxiv Details（mcp：biocontext_get_biorxiv_preprint_details）：Read title, authors, abstract, version, license, and publication status for a bioRxiv/medRxiv DOI; use to distinguish a preprint from a peer-reviewed paper.
- BioContext Recent Preprints（mcp：biocontext_get_recent_biorxiv_preprints）：List recent bioRxiv/medRxiv preprints by date range or count; use for current-awareness scans, never as settled evidence.
- BioContext Grants.gov（mcp：biocontext_search_grants_gov）：Search grants.gov opportunities by keyword, agency, or criteria; useful for funding-landscape and feasibility questions.
- BioContext Ontology List（mcp：biocontext_get_available_ontologies）：List OLS ontologies and metadata; call first when you need the exact ontology id before term search.
- BioContext Ontology Search（mcp：biocontext_search_ontology_terms）：Search terms across OLS ontologies; use to normalize cell types, diseases, chemicals, and phenotypes.
- BioContext Ontology Term（mcp：biocontext_get_term_details）：Read an ontology term's definition, synonyms, and hierarchical relationships; use to disambiguate a term before citing it.
- BioContext Ontology Children（mcp：biocontext_get_term_hierarchical_children）：List child terms of an ontology term; use to expand a controlled-vocabulary query or to check classification.
- BioContext GO Terms by Gene（mcp：biocontext_get_go_terms_by_gene）：Find Gene Ontology terms linked to a gene; use for functional annotation and enrichment interpretation.
- BioContext Cell Ontology（mcp：biocontext_get_cell_ontology_terms）：Search Cell Ontology terms for a cell type; use to standardize cell annotations across datasets.
- BioContext ChEBI Terms（mcp：biocontext_get_chebi_terms_by_chemical）：Search ChEBI ontology terms for a chemical or drug; use to map a compound to a stable ontology identifier.
- BioContext Disease IDs（mcp：biocontext_get_efo_id_by_disease_name）：Resolve a disease name to EFO/Mondo/HP identifiers; call before Open Targets or other disease-indexed queries.
- BioContext Open Targets Schema（mcp：biocontext_get_open_targets_graphql_schema）：Retrieve the Open Targets GraphQL schema; use before writing a custom target-disease query.
- BioContext Open Targets Examples（mcp：biocontext_get_open_targets_query_examples）：Retrieve example Open Targets GraphQL queries; use as templates instead of guessing field names.
- BioContext Open Targets Query（mcp：biocontext_query_open_targets_graphql）：Execute a GraphQL query against Open Targets; use for target-disease association, evidence, and tractability questions.

# Clinical and Medical Applications

## Skills

- cancer-genomics-analysis（skill：cancer-genomics-analysis）：Computational cancer genomics workflows. Somatic mutation detection and annotation, structural variation characterization, copy number analysis, tumor purity/ploidy estimation, NMF metagene extraction, and DNA damage response network analysis. For cancer mutation databases use cosmic-database; for variant clinical significance use clinvar-database.
- clinical-decision-support（skill：clinical-decision-support）：Generate professional clinical decision support (CDS) documents for pharmaceutical and clinical research settings, including patient cohort analyses (biomarker-stratified with outcomes) and treatment recommendation reports (evidence-based guidelines with decision algorithms). Supports GRADE evidence grading, statistical analysis (hazard ratios, survival curves, waterfall plots), biomarker integration, and regulatory compliance. Outputs publication-ready LaTeX/PDF format optimized for drug development, clinical research, and evidence synthesis.
- clinical-reports（skill：clinical-reports）：Write comprehensive clinical reports including case reports (CARE guidelines), diagnostic reports (radiology/pathology/lab), clinical trial reports (ICH-E3, SAE, CSR), and patient documentation (SOAP, H&P, discharge summaries). Full support with templates, regulatory compliance (HIPAA, FDA, ICH-GCP), and validation tools.
- treatment-plans（skill：treatment-plans）：Generate concise (3-4 page), focused medical treatment plans in LaTeX/PDF format for all clinical specialties. Supports general medical treatment, rehabilitation therapy, mental health care, chronic disease management, perioperative care, and pain management. Includes SMART goal frameworks, evidence-based interventions with minimal text citations, regulatory compliance (HIPAA), and professional formatting. Prioritizes brevity and clinical actionability.
- pharmgx-reporter（skill：pharmgx-reporter）：Generate pharmacogenomics (PGx) reports from 23andMe/AncestryDNA raw genotypes: star-allele and diplotype calls, CPIC-level drug recommendations, and JSON/HTML/Markdown output; for research and education use, not clinical diagnosis.

## BioMCP (Clinical and Translational Evidence, Read-Only)

- BioMCP ClinGen CAR Normalization（mcp：biomcp_variant_normalize_car）：Perform a bounded ClinGen Allele Registry normalization lookup for supported RefSeq HGVS; returns source facts without inferring equivalence.
- BioMCP ClinGen ERepo Assertions（mcp：biomcp_variant_erepo）：Read expert-curated variant assertions from the ClinGen Evidence Repository, preserving versioned source facts.
- BioMCP ClinGen CSpec Listing（mcp：biomcp_gene_cspec）：List gene-related CSpec resource IRIs and paginated content; used to verify the sources of ACMG/AMP rules.

## BioContext (Clinical Trials and FDA Drugs, Read-Only)

- BioContext Trial Search（mcp：biocontext_search_studies）：Advanced ClinicalTrials.gov search with multi-field filters; use when the trial question is broader than a single condition or intervention.
- BioContext Trials by Condition（mcp：biocontext_get_studies_by_condition）：Search trials by condition with status/type/phase breakdowns; use for evidence-landscape and recruitment questions.
- BioContext Trials by Intervention（mcp：biocontext_get_studies_by_intervention）：Search trials by intervention with condition and phase filters; use to find prior/ongoing studies of a drug or device.
- BioContext Recruiting Trials（mcp：biocontext_get_recruiting_studies_by_location）：Find recruiting trials by geographic location; use for patient-access and feasibility questions.
- BioContext Trial Details（mcp：biocontext_get_study_details）：Read a trial's design, eligibility, outcomes, locations, contacts, and metadata by NCT ID; use before citing a trial.
- BioContext FDA Drug Search（mcp：biocontext_search_drugs_fda）：Search FDA Drugs@FDA for approved products by multiple criteria; use for approval and label questions.
- BioContext Drug by Application（mcp：biocontext_get_drug_by_application_number）：Read an FDA-approved drug by NDA/ANDA/BLA application number; use when the application number is known.
- BioContext Drug Label（mcp：biocontext_get_drug_label_info）：Read FDA labeling information: ingredients, dosage forms, routes, and administration; use for label-level facts.
- BioContext Drugs by Class（mcp：biocontext_search_drugs_by_therapeutic_class）：Search drugs by therapeutic or pharmacologic class; call get_available_pharmacologic_classes first for exact terms.
- BioContext Pharmacologic Classes（mcp：biocontext_get_available_pharmacologic_classes）：List available FDA pharmacologic classes; use to choose an exact class term before searching.
- BioContext Generic Equivalents（mcp：biocontext_get_generic_equivalents）：Find generic equivalents for a brand-name drug via ANDA entries; use for substitution and formulation questions.
- BioContext Drug Statistics（mcp：biocontext_get_drug_statistics）：Read aggregate FDA drug statistics such as top sponsors, dosage forms, routes, and marketing status; use for landscape summaries.
- BioContext Drug Counts（mcp：biocontext_count_drugs_by_field）：Count unique values in a field across FDA-approved drugs; use for descriptive analyses, not causal claims.

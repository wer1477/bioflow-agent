# Omics and Single-Cell Analysis

## Skills

- scanpy（skill：scanpy）：Standard single-cell RNA-seq analysis pipeline. Use for QC, normalization, dimensionality reduction (PCA/UMAP/t-SNE), clustering, differential expression, and visualization. Best for exploratory scRNA-seq analysis with established workflows. For deep learning models use scvi-tools; for data format questions use anndata.
- bio-sc（skill：bio-sc）：Standard single-cell pipeline behind one CLI: QC, normalization, HVG, PCA, Leiden, UMAP, Wilcoxon marker DE, optional pseudobulk DE with pydeseq2, and a reproducible manifest.
- pydeseq2（skill：pydeseq2）：Differential gene expression analysis (Python DESeq2). Identify DE genes from bulk RNA-seq counts, Wald tests, FDR correction, volcano/MA plots, for RNA-seq analysis.
- bio-bulk（skill：bio-bulk）：Bulk RNA-seq differential expression behind one CLI: genes x samples counts + sample sheet -> DESeq2-compatible table, normalized counts, volcano/MA/PCA, and a reproducible manifest.
- deeptools（skill：deeptools）：NGS analysis toolkit. BAM to bigWig conversion, QC (correlation, PCA, fingerprints), heatmaps/profiles (TSS, peaks), for ChIP-seq, RNA-seq, ATAC-seq visualization.
- etetoolkit（skill：etetoolkit）：Phylogenetic tree toolkit (ETE). Tree manipulation (Newick/NHX), evolutionary event detection, orthology/paralogy, NCBI taxonomy, visualization (PDF/SVG), for phylogenomics.
- gget（skill：gget）：Fast CLI/Python queries to 20+ bioinformatics databases. Use for quick lookups: gene info, BLAST searches, AlphaFold structures, enrichment analysis. Best for interactive exploration, simple queries. For batch processing or advanced BLAST use biopython; for multi-database Python workflows use bioservices.
- flow-cytometry-analysis（skill：flow-cytometry-analysis）：Complete flow cytometry analysis pipeline. FCS file handling, compensation, manual/automated gating, immunophenotyping, CFSE proliferation analysis, cell cycle analysis (Dean-Jett-Fox), and apoptosis assays. Extends flowio with analytical workflows. For raw FCS parsing only use flowio.
- microbial-dynamics（skill：microbial-dynamics）：Microbial population dynamics modeling and analysis. Bacterial growth curve fitting (logistic, Gompertz, Baranyi), Lotka-Volterra community dynamics, Gillespie stochastic simulation, biofilm quantification, CFU enumeration, and genome annotation. For metabolic modeling use cobrapy; for sequence analysis use biopython.

## BioContext (Markers, Proteomics, Interactions, and Protein Annotation, Read-Only)

- BioContext PanglaoDB Markers（mcp：biocontext_get_panglaodb_marker_genes）：Retrieve marker genes from PanglaoDB with species/organ/cell-type filters; use for cell-type annotation evidence, not as ground truth.
- BioContext PanglaoDB Options（mcp：biocontext_get_panglaodb_options）：List available PanglaoDB organs and cell types; call before a filtered marker query.
- BioContext PRIDE Search（mcp：biocontext_search_pride_projects）：Search PRIDE mass-spectrometry proteomics projects by keyword and filters; use for proteomics dataset discovery.
- BioContext PRIDE Project（mcp：biocontext_get_pride_project）：Read a PRIDE project's metadata and experimental details; use before reusing a dataset.
- BioContext PRIDE Proteins（mcp：biocontext_search_pride_proteins）：Search proteins identified in a PRIDE project; use to check whether a protein was observed in a proteomics dataset.
- BioContext STRING ID（mcp：biocontext_get_string_id）：Map gene names, synonyms, or UniProt IDs to STRING IDs; call before STRING interaction queries.
- BioContext STRING Interactions（mcp：biocontext_get_string_interactions）：Retrieve protein-protein interactions above a score threshold; always pass the species; report the score and evidence channels.
- BioContext STRING Similarity（mcp：biocontext_get_string_similarity_scores）：Retrieve STRING homology similarity scores; use for sequence-similarity context, not as physical interaction evidence.
- BioContext STRING Network Image（mcp：biocontext_get_string_network_image）：Generate a STRING network image for a protein list; use for visualization, not as a quantitative result.
- BioContext Reactome（mcp：biocontext_get_reactome_info_by_identifier）：Query Reactome pathway information by identifier; use to map a gene/protein to pathways.
- BioContext InterPro Entry（mcp：biocontext_get_interpro_entry）：Read an InterPro family/domain/functional-site entry; use for domain annotation and provenance.
- BioContext InterPro Search（mcp：biocontext_search_interpro_entries）：Search InterPro entries by name, type, database, GO term, or species; use to find a domain family.
- BioContext Protein Domains（mcp：biocontext_get_protein_domains）：Read a protein's InterPro domain architecture and functional sites; use for domain-level interpretation.
- BioContext UniProt by Symbol（mcp：biocontext_get_uniprot_id_by_protein_symbol）：Resolve a gene symbol or protein name to a UniProt accession (prefers reviewed entries); use before protein-level queries.
- BioContext UniProt Protein（mcp：biocontext_get_uniprot_protein_info）：Read UniProt protein information, sequence, function, keywords, and references; use for protein-level evidence.
- BioContext AlphaFold（mcp：biocontext_get_alphafold_info_by_protein_symbol）：Resolve a protein symbol to a UniProt ID, then read AlphaFold structure predictions; use for structure availability, not experimental structure proof.
- BioContext Ensembl ID（mcp：biocontext_get_ensembl_id_from_gene_symbol）：Resolve a gene symbol to an Ensembl gene ID for a species; use before Ensembl/GEO/CELLxGENE queries.
- BioContext Human Protein Atlas（mcp：biocontext_get_human_protein_atlas_info）：Read HPA expression, localization, and pathology data by gene symbol or Ensembl ID; use as tissue-expression evidence with the HPA version in mind.

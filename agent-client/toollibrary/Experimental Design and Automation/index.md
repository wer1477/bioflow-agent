# Experimental Design and Automation

## Skills

- molecular-cloning（skill：molecular-cloning）：Molecular cloning simulation and design. PCR amplicon prediction, restriction enzyme digestion, Golden Gate and Gibson assembly simulation, primer design, CRISPR sgRNA design, and plasmid annotation. For protein-level sequence analysis use biopython or esm; for database lookups use gene-database or ensembl-database.
- synthetic-biology（skill：synthetic-biology）：Synthetic biology design and simulation tools. Codon optimization, gene circuit ODE modeling with growth feedback, SBML model creation, bifurcation analysis, barcode sequencing fitness analysis, and therapeutic genome engineering. For metabolic modeling use cobrapy; for sequence tools use biopython.
- immunology-assays（skill：immunology-assays）：Computational analysis of immunology experimental data. ATAC-seq differential accessibility, immune cell tracking from microscopy, ELISA data processing with 4-parameter logistic fitting, immunohistochemistry quantification, antibody titer analysis, and cell cycle phase duration estimation. For flow cytometry use flow-cytometry-analysis; for scRNA-seq use scanpy.
- pharmacology-wetlab（skill：pharmacology-wetlab）：Computational analysis of pharmacology wet-lab experiments. Western blot densitometry, xenograft tumor growth inhibition, pharmaceutical stability modeling (Arrhenius), radiolabeled antibody biodistribution, MIRD dosimetry, and adverse event grading. For drug databases use chembl-database or fda-database; for molecular docking use diffdock.
- glycobiology（skill：glycobiology）：Glycosylation site prediction and glycobiology analysis. N-glycosylation motif finding, O-glycosylation hotspot prediction, glycan structure resources. Lightweight, pure Python. For protein function queries use uniprot-database; for structure analysis use alphafold-database.
- opentrons-integration（skill：opentrons-integration）：Official Opentrons Protocol API for OT-2 and Flex robots. Use when writing protocols specifically for Opentrons hardware with full access to Protocol API v2 features. Best for production Opentrons protocols, official API compatibility. For multi-vendor automation or broader equipment control use pylabrobot.

## BioContext (Antibody Registry, Read-Only)

- BioContext Antibody Search（mcp：biocontext_get_antibody_list）：Search the Antibody Registry by target/vendor metadata; use to check catalog number, clonality, and validated applications before ordering.
- BioContext Antibody Details（mcp：biocontext_get_antibody_information）：Read an antibody record by ID: catalog number, vendor, clonality, epitope, and applications; use to document reagent provenance.

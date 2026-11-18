const sourceRoot = 'Bioagent/compute_bioflow/bioflow_scripts_bioflow平台的脚本';

function step(id, name, script, needs, produces, tools, resources) {
  return { id, name, source_script: `${sourceRoot}/${script}`, needs, produces, tools, resources };
}

export const templates = [
  {
    id: 'rnaseq-standard', domain: 'rna-seq', version: '1.0.0',
    description: 'Paired-end RNA-seq: HISAT2 mapping, bedtools counting, edgeR, integration, GO and KEGG enrichment.',
    parameters: [
      ['raw_reads', 'directory', true], ['sample_sheet', 'file', true], ['reference_index', 'file', true], ['gene_bed', 'file', true],
      ['annotation_file', 'file', true], ['go_annotation_file', 'file', true], ['kegg_annotation_file', 'file', true], ['groups', 'string', true], ['contrasts', 'string', true], ['threads', 'integer', false, 4],
    ],
    steps: [
      step('map', 'HISAT2 mapping and BAM filtering', 'RNA-seq_biofow_scripts/01_hisat2_mapping_batch.sh', ['raw_reads', 'sample_sheet', 'reference_index'], ['bam_dir'], ['hisat2', 'samtools'], { cpu_cores: 4, memory_mb: 16000 }),
      step('count', 'bedtools multicov read counting', 'RNA-seq_biofow_scripts/02_bedtools_multicov.sh', ['bam_dir', 'gene_bed'], ['reads_dir', 'reads_count_manifest'], ['bedtools'], { cpu_cores: 4, memory_mb: 8000 }),
      step('differential_expression', 'edgeR differential expression', 'RNA-seq_biofow_scripts/03_edger_wrapper.sh', ['reads_dir', 'sample_sheet', 'groups', 'contrasts'], ['norm_gene_cpm', 'comp_dir', 'de_result'], ['R', 'edgeR', 'limma'], { cpu_cores: 2, memory_mb: 8000 }),
      step('integrate', 'Differential-expression result integration', 'RNA-seq_biofow_scripts/04_integrate_wrapper.sh', ['comp_dir', 'norm_gene_cpm', 'annotation_file'], ['combind_comp', 'combind_comp2', 'comp_de_stat', 'select_cpm'], ['R'], { cpu_cores: 2, memory_mb: 8000 }),
      step('go_enrichment', 'GO enrichment', 'RNA-seq_biofow_scripts/05_go_enrichment_wrapper.sh', ['combind_comp', 'norm_gene_cpm', 'go_annotation_file'], ['go_result_dir', 'go_result_manifest'], ['R'], { cpu_cores: 2, memory_mb: 8000 }),
      step('kegg_enrichment', 'KEGG enrichment', 'RNA-seq_biofow_scripts/06_kegg_enrichment_wrapper.sh', ['combind_comp', 'norm_gene_cpm', 'kegg_annotation_file'], ['kegg_result_dir', 'kegg_result_manifest'], ['R'], { cpu_cores: 2, memory_mb: 8000 }),
    ],
  },
  {
    id: 'cuttag-standard', domain: 'cuttag', version: '1.0.0',
    description: 'CUT&Tag: reference index, fastp QC, Bowtie2 alignment, duplicate handling, signal tracks, peak calling and annotation.',
    parameters: [['raw_reads', 'directory', true], ['reference_fasta', 'file', true], ['annotation_file', 'file', true], ['threads', 'integer', false, 4]],
    steps: [
      step('reference_index', 'Bowtie2 reference index', 'cuttag_bioflow_scripts/00_cuttag_ref_index.sh', ['reference_fasta'], ['genome_index'], ['bowtie2-build'], { cpu_cores: 4, memory_mb: 16000 }),
      step('qc', 'fastp read quality control', 'cuttag_bioflow_scripts/01_cuttag_fastp.sh', ['raw_reads'], ['clean_reads'], ['fastp'], { cpu_cores: 4, memory_mb: 8000 }),
      step('align', 'Bowtie2 alignment', 'cuttag_bioflow_scripts/02_cuttag_align.sh', ['clean_reads', 'genome_index'], ['aligned_bam'], ['bowtie2', 'samtools'], { cpu_cores: 8, memory_mb: 32000 }),
      step('deduplicate', 'Sort and remove duplicates', 'cuttag_bioflow_scripts/03_cuttag_rmdup_sort.sh', ['aligned_bam'], ['dedup_bam'], ['samtools', 'picard'], { cpu_cores: 4, memory_mb: 16000 }),
      step('signal', 'Signal track generation', 'cuttag_bioflow_scripts/04_cuttag_signal.sh', ['dedup_bam'], ['signal_tracks'], ['deepTools'], { cpu_cores: 4, memory_mb: 16000 }),
      step('peak_calling', 'MACS peak calling', 'cuttag_bioflow_scripts/05_cuttag_callpeak.sh', ['dedup_bam'], ['peaks'], ['macs2'], { cpu_cores: 4, memory_mb: 16000 }),
      step('peak_annotation', 'Peak annotation', 'cuttag_bioflow_scripts/06_cuttag_peak_anno_wrapper.sh', ['peaks', 'annotation_file'], ['annotated_peaks'], ['R'], { cpu_cores: 2, memory_mb: 8000 }),
    ],
  },
  {
    id: 'dnaseq-gatk-cpu', domain: 'dna-seq', version: '1.0.0',
    description: 'DNA-seq CPU/GATK: reference preparation, FASTQ-to-BAM, gVCF, joint genotyping, filtering and merged SNP/INDEL VCF.',
    parameters: [['raw_reads', 'directory', true], ['reference_fasta', 'file', true], ['chromosomes_file', 'file', true], ['threads', 'integer', false, 4]],
    steps: [
      step('reference_index', 'Reference preparation', 'DNA-seq_bioflow_scripts/CPU/分步骤/00_cpu_ref_index.sh', ['reference_fasta'], ['reference_bundle'], ['bwa', 'samtools', 'gatk'], { cpu_cores: 4, memory_mb: 16000 }),
      step('bam', 'FASTQ to sorted BAM', 'DNA-seq_bioflow_scripts/CPU/分步骤/01_cpu_bam.sh', ['raw_reads', 'reference_bundle'], ['bam_dir'], ['bwa', 'samtools'], { cpu_cores: 8, memory_mb: 32000 }),
      step('gvcf', 'Per-sample GATK HaplotypeCaller', 'DNA-seq_bioflow_scripts/CPU/分步骤/02_cpu_gvcf.sh', ['bam_dir', 'reference_bundle'], ['gvcf_dir'], ['gatk'], { cpu_cores: 4, memory_mb: 32000 }),
      step('joint_genotype', 'GenomicsDBImport and joint genotyping', 'DNA-seq_bioflow_scripts/CPU/分步骤/03_cpu_dbimport_joint.sh', ['gvcf_dir', 'reference_bundle', 'chromosomes_file'], ['raw_vcf_dir'], ['gatk'], { cpu_cores: 4, memory_mb: 64000 }),
      step('filter', 'SNP and INDEL selection/filtering', 'DNA-seq_bioflow_scripts/CPU/分步骤/04_cpu_select_filter.sh', ['raw_vcf_dir', 'reference_bundle'], ['filter_snp_dir', 'filter_indel_dir'], ['gatk'], { cpu_cores: 4, memory_mb: 32000 }),
      step('merge', 'Merge filtered VCF outputs', 'DNA-seq_bioflow_scripts/CPU/分步骤/05_cpu_merge.sh', ['filter_snp_dir', 'filter_indel_dir', 'chromosomes_file'], ['merge_snp_vcf', 'merge_indel_vcf'], ['bcftools'], { cpu_cores: 2, memory_mb: 8000 }),
    ],
  },
].map((template) => ({ ...template, parameters: template.parameters.map(([name, type, required, defaultValue]) => ({ name, type, required, ...(defaultValue === undefined ? {} : { default: defaultValue }) })) }));

export function getTemplate(id) { return templates.find((template) => template.id === id); }

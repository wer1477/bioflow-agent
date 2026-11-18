export const SOURCES = {
  'cpg-island': {
    evidence_type: 'cpg_island',
    description: 'UCSC CpG Island table. GRCh38 has a built-in official UCSC download URL.',
    required_prepare: ['assembly', 'version', 'data-dir'],
    optional_prepare: ['url', 'checksum-sha256'],
    default_urls: {
      GRCh38: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cpgIslandExt.txt.gz',
    },
  },
  chromhmm: {
    evidence_type: 'chromatin_state',
    description: 'Roadmap or compatible ChromHMM BED segmentation. Supply one explicit release URL and epigenome id.',
    required_prepare: ['assembly', 'version', 'data-dir', 'url', 'epigenome'],
    optional_prepare: ['checksum-sha256', 'biosample'],
  },
  'encode-peak': {
    evidence_type: 'chromatin_peak',
    description: 'One explicit ENCODE narrowPeak/BED file. Supply the file accession, biosample, and assay.',
    required_prepare: ['assembly', 'version', 'data-dir', 'url', 'biosample', 'assay'],
    optional_prepare: ['checksum-sha256'],
  },
  'remap-tf-binding': {
    evidence_type: 'tf_binding',
    description: 'One explicit ReMap or compatible TF ChIP-seq BED release.',
    required_prepare: ['assembly', 'version', 'data-dir', 'url'],
    optional_prepare: ['checksum-sha256', 'biosample', 'assay'],
  },
};

export const SOURCE_IDS = Object.keys(SOURCES);

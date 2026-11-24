/**
 * Query-side bilingual expansion for the lexical capability shortlist.
 *
 * The curated catalogs are mostly English while users may ask in Chinese. A Chinese
 * sentence shares no characters with an English description, so TF-IDF over the raw
 * query is guaranteed to be zero and the safe fallback would browse on almost every
 * Chinese request. This table maps domain-neutral concepts to their English terms.
 *
 * It is intentionally a small, explicit **domain-concept** glossary, not a translation
 * model:
 * - only substrings present in the query are expanded;
 * - English terms are added to the query vector, never to the catalog;
 * - generic words that carry no domain signal (for example 分析/analysis) are not
 *   mapped, because they would retrieve everything and are filtered on both sides;
 * - no asset id, gold answer, or task-specific phrase appears here.
 *
 * Uncovered vocabulary still produces `no_lexical_signal` and the caller's browse
 * fallback. That boundary is reported, not hidden.
 */
export const CROSS_LINGUAL_TERMS: ReadonlyArray<readonly [string, string]> = [
  ['核对', 'validate check verify'],
  ['校验', 'validate check'],
  ['验证', 'validate verification'],
  ['样本', 'sample'],
  ['编号', 'identifier id'],
  ['标识', 'identifier id'],
  ['矩阵', 'matrix'],
  ['表头', 'header'],
  ['一致', 'consistency consistent'],
  ['缺失', 'missing'],
  ['重复', 'duplicate'],
  ['计数', 'count'],
  ['差异表达', 'differential expression'],
  ['表达', 'expression'],
  ['流程', 'workflow'],
  ['工作流', 'workflow'],
  ['单细胞', 'single-cell'],
  ['空间转录组', 'spatial transcriptomics'],
  ['聚类', 'clustering'],
  ['序列', 'sequence'],
  ['比对', 'alignment'],
  ['变异', 'variant'],
  ['注释', 'annotation'],
  ['富集', 'enrichment'],
  ['质控', 'quality control qc'],
  ['质量控制', 'quality control qc'],
  ['批次', 'batch'],
  ['处理', 'treatment'],
  ['对照', 'control'],
  ['干旱', 'drought'],
  ['水稻', 'rice'],
  ['拟南芥', 'arabidopsis'],
  ['基因', 'gene'],
  ['蛋白', 'protein'],
  ['结构', 'structure'],
  ['系统发育', 'phylogenetic'],
  ['进化树', 'phylogenetic tree'],
  ['绘图', 'visualization plot'],
  ['可视化', 'visualization'],
  ['统计', 'statistical'],
  ['实验设计', 'experimental design'],
  ['样本量', 'sample size'],
  ['功效', 'power'],
  ['多重检验', 'multiple testing'],
  ['检索', 'search'],
  ['文献', 'literature'],
  ['文件格式', 'file format'],
  ['临床', 'clinical'],
  ['药物', 'drug'],
  ['影像', 'imaging'],
];

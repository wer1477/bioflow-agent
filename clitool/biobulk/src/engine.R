#!/usr/bin/env Rscript
# bio-bulk engine (R DESeq2 fallback). The Node CLI owns argument parsing and the
# JSON envelope; this script receives positional arguments and prints one JSON line.

suppressPackageStartupMessages({
  library(DESeq2)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 6) {
  cat(toJSON(list(ok = FALSE, error = list(code = "invalid-input", message = "expected 6 arguments", hint = "run 'bio-bulk --help'")), auto_unbox = TRUE), "\n")
  quit(status = 2)
}

counts_path <- args[[1]]
samples_path <- args[[2]]
output <- args[[3]]
design <- args[[4]]
contrast <- args[[5]]
min_count <- as.integer(args[[6]])

fail <- function(code, message, hint = "run 'bio-bulk --help'") {
  cat(toJSON(list(ok = FALSE, error = list(code = code, message = message, hint = hint)), auto_unbox = TRUE), "\n")
  quit(status = 1)
}

sha256 <- function(path) {
  if (!file.exists(path)) return(NA_character_)
  unname(tools::md5sum(path))
}

tryCatch({
  dir.create(output, showWarnings = FALSE, recursive = TRUE)
  separator <- if (grepl("\\.csv$", counts_path, ignore.case = TRUE)) "," else "\t"
  counts <- read.table(counts_path, header = TRUE, sep = separator, row.names = 1, check.names = FALSE)
  samples <- read.csv(samples_path, stringsAsFactors = FALSE)
  if (!"sample" %in% colnames(samples)) fail("invalid-input", "samples sheet requires a 'sample' column")
  if (anyDuplicated(samples$sample)) fail("invalid-input", "samples sheet contains duplicate sample ids")
  rownames(samples) <- samples$sample
  missing <- setdiff(samples$sample, colnames(counts))
  if (length(missing) > 0) fail("invalid-input", paste("count matrix is missing samples:", paste(missing, collapse = ", ")))
  counts <- counts[, samples$sample, drop = FALSE]
  counts <- round(as.matrix(counts))
  terms <- trimws(strsplit(sub("^~", "", design), "\\+")[[1]])
  for (term in unique(c(terms, trimws(strsplit(contrast, ":", fixed = TRUE)[[1]][1])))) {
    if (!term %in% colnames(samples)) fail("invalid-input", paste("samples sheet is missing column", term))
  }
  dds <- DESeqDataSetFromMatrix(countData = counts, colData = DataFrame(samples), design = as.formula(design))
  keep <- rowSums(counts(dds)) >= min_count
  dds <- dds[keep, ]
  if (nrow(dds) < 2) fail("analysis-failed", paste("only", nrow(dds), "genes passed --min-count"))
  dds <- DESeq(dds, quiet = TRUE)
  parts <- trimws(strsplit(contrast, ":", fixed = TRUE)[[1]])
  res <- results(dds, contrast = c(parts[[1]], parts[[2]], parts[[3]]))
  frame <- as.data.frame(res)
  frame$gene <- rownames(frame)
  frame <- frame[, c("gene", "baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj")]
  write.csv(frame, file.path(output, "de_results.csv"), row.names = FALSE)

  normalized <- counts(dds, normalized = TRUE)
  write.table(normalized, file.path(output, "normalized_counts.tsv"), sep = "\t", quote = FALSE, col.names = NA)

  plot_volcano <- function(path, device) {
    device(path)
    plot(frame$log2FoldChange, -log10(frame$padj), pch = 20, cex = 0.5, col = "#3b6ea5",
         xlab = "log2 fold change", ylab = "-log10 adjusted p-value",
         main = paste(parts[[1]], ":", parts[[2]], "vs", parts[[3]]))
    abline(h = -log10(0.05), lty = 2, col = "grey60")
    dev.off()
  }
  plot_ma <- function(path, device) {
    device(path)
    plot(log10(frame$baseMean + 1), frame$log2FoldChange, pch = 20, cex = 0.5, col = "#8a5a44",
         xlab = "log10 mean normalized count", ylab = "log2 fold change", main = "MA plot")
    dev.off()
  }
  plot_volcano(file.path(output, "volcano.png"), png)
  plot_volcano(file.path(output, "volcano.pdf"), pdf)
  plot_ma(file.path(output, "ma.png"), png)
  plot_ma(file.path(output, "ma.pdf"), pdf)
  png(file.path(output, "pca.png"))
  pca <- prcomp(t(log2(normalized + 1)))
  plot(pca$x[, 1], pca$x[, 2], pch = 19, col = factor(samples[[parts[[1]]]]),
       xlab = "PC1", ylab = "PC2", main = "Sample PCA")
  dev.off()

  outputs <- list.files(output, full.names = TRUE)
  manifest <- list(
    schema_version = 1,
    tool = list(name = "bio-bulk", version = "0.1.0"),
    parameters = list(design = design, contrast = contrast, engine = "deseq2-r", min_count = min_count),
    input = list(
      counts = list(path = normalizePath(counts_path), sha256 = sha256(counts_path)),
      samples = list(path = normalizePath(samples_path), sha256 = sha256(samples_path))
    ),
    outputs = setNames(lapply(outputs, function(path) list(path = path, bytes = file.info(path)$size, sha256 = sha256(path))), basename(outputs)),
    environment = list(R = R.version.string, DESeq2 = as.character(packageVersion("DESeq2"))),
    warnings = character(0)
  )
  write_json(manifest, file.path(output, "manifest.json"), auto_unbox = TRUE, pretty = TRUE)

  result <- list(
    ok = TRUE,
    outputs = setNames(as.list(outputs), basename(outputs)),
    summary = list(
      genes_tested = nrow(frame),
      significant_padj_0_05 = sum(frame$padj < 0.05, na.rm = TRUE),
      samples = ncol(counts)
    ),
    warnings = list()
  )
  cat(toJSON(result, auto_unbox = TRUE), "\n")
}, error = function(error) {
  fail("analysis-failed", conditionMessage(error), "run 'bio-bulk check --format json'")
})

#!/usr/bin/env python3
"""bio-bulk engine: pydeseq2 with DESeq2 result columns and a reproducible manifest."""

import argparse
import hashlib
import json
import os
import platform
import sys
import time

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version(module):
    return str(getattr(module, "__version__", "unknown"))


def fail(code, message, hint=None):
    print(json.dumps({"ok": False, "error": {"code": code, "message": message, "hint": hint or "run 'bio-bulk --help'"}}), flush=True)
    raise SystemExit(1)


def read_counts(path):
    import pandas as pd

    separator = "," if path.lower().endswith(".csv") else "\t"
    frame = pd.read_csv(path, sep=separator, index_col=0)
    if frame.shape[0] == 0 or frame.shape[1] == 0:
        fail("invalid-input", f"count matrix '{path}' is empty")
    try:
        frame = frame.apply(lambda column: column.astype(float))
    except Exception as error:  # noqa: BLE001
        fail("invalid-input", f"count matrix must be numeric: {error}")
    if (frame < 0).any().any():
        fail("invalid-input", "count matrix contains negative values")
    frame.index = frame.index.astype(str)
    frame.columns = frame.columns.astype(str)
    return frame


def run(config):
    import numpy as np
    import pandas as pd
    import pydeseq2
    from pydeseq2.dds import DeseqDataSet
    from pydeseq2.ds import DeseqStats
    from sklearn.decomposition import PCA

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    output = config["output"]
    os.makedirs(output, exist_ok=True)
    warnings = []
    counts = read_counts(config["counts"])
    samples = pd.read_csv(config["samples"], dtype=str)
    if "sample" not in samples.columns:
        fail("invalid-input", "samples sheet requires a 'sample' column")
    samples["sample"] = samples["sample"].astype(str)
    if samples["sample"].duplicated().any():
        fail("invalid-input", "samples sheet contains duplicate sample ids")
    samples = samples.set_index("sample")
    missing = [sample for sample in samples.index if sample not in counts.columns]
    if missing:
        fail("invalid-input", f"count matrix is missing samples: {', '.join(missing)}")
    extra = [column for column in counts.columns if column not in samples.index]
    if extra:
        warnings.append(f"count matrix has columns not in the sample sheet: {', '.join(extra)}")
    counts = counts[samples.index]
    for term in [config["variable"], *[part for part in config["design"].lstrip("~").split("+")]]:
        term = term.strip()
        if term and term not in samples.columns:
            fail("invalid-input", f"samples sheet is missing '{term}' required by the design/contrast")
    if samples[config["variable"]].nunique() < 2:
        fail("invalid-input", f"contrast variable '{config['variable']}' has fewer than 2 levels")

    keep = counts.sum(axis=1) >= int(config["min_count"])
    counts = counts.loc[keep]
    if counts.shape[0] < 2:
        fail("analysis-failed", f"only {counts.shape[0]} genes passed --min-count {config['min_count']}")
    if samples.shape[0] < 3:
        warnings.append("fewer than 3 samples; DESeq2 dispersion estimates will be unstable")

    design_terms = [term.strip() for term in config["design"].lstrip("~").split("+") if term.strip()]
    metadata = samples[design_terms].astype(str).copy()
    dds = DeseqDataSet(
        counts=counts.T.astype(int),
        metadata=metadata,
        design=config["design"],
        refit_cooks=True,
        n_cpus=1,
        quiet=True,
    )
    dds.deseq2()
    stats = DeseqStats(dds, contrast=[config["variable"], config["target"], config["reference"]], n_cpus=1, quiet=True)
    stats.summary()
    results = stats.results_df.copy()
    results.index.name = "gene"
    results = results.reset_index()
    columns = ["gene", "baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj"]
    for column in columns:
        if column not in results.columns:
            results[column] = np.nan
    results = results[columns]
    results.to_csv(os.path.join(output, "de_results.csv"), index=False)

    normalized = None
    try:
        normed = dds.layers["normed_counts"]
        normalized = pd.DataFrame(normed, index=metadata.index, columns=[str(gene) for gene in counts.index]).T
        normalized.index.name = "gene"
        normalized.to_csv(os.path.join(output, "normalized_counts.tsv"), sep="\t")
    except Exception as error:  # noqa: BLE001 - normalized counts are a convenience, not the DE result
        warnings.append(f"normalized counts unavailable: {type(error).__name__}: {error}")

    write_plots(results, normalized, metadata, config, output)

    outputs = ["de_results.csv", "volcano.png", "volcano.pdf", "ma.png", "ma.pdf", "pca.png"]
    if normalized is not None:
        outputs.append("normalized_counts.tsv")
    manifest = {
        "schema_version": 1,
        "tool": {"name": "bio-bulk", "version": "0.1.0"},
        "started_at": started,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "parameters": {
            "design": config["design"],
            "contrast": f"{config['variable']}:{config['target']}:{config['reference']}",
            "engine": "pydeseq2",
            "min_count": int(config["min_count"]),
        },
        "input": {
            "counts": {"path": os.path.abspath(config["counts"]), "sha256": sha256(config["counts"])},
            "samples": {"path": os.path.abspath(config["samples"]), "sha256": sha256(config["samples"])},
        },
        "outputs": {
            name: {"path": os.path.join(output, name), "bytes": os.path.getsize(os.path.join(output, name)), "sha256": sha256(os.path.join(output, name))}
            for name in outputs
        },
        "environment": {"python": platform.python_version(), "pydeseq2": version(pydeseq2), "pandas": version(pd), "numpy": version(np)},
        "warnings": warnings,
    }
    with open(os.path.join(output, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    significant = int((results["padj"] < 0.05).sum()) if "padj" in results else 0
    return {
        "ok": True,
        "outputs": {name: os.path.join(output, name) for name in [*outputs, "manifest.json"]},
        "summary": {
            "genes_tested": int(results.shape[0]),
            "significant_padj_0_05": significant,
            "samples": int(samples.shape[0]),
            "groups": {str(level): int((samples[config["variable"]] == level).sum()) for level in sorted(samples[config["variable"]].unique())},
        },
        "warnings": warnings,
    }


def write_plots(results, normalized, metadata, config, output):
    import numpy as np
    import pandas as pd
    from sklearn.decomposition import PCA

    condition = metadata[config["variable"]].astype(str)
    levels = sorted(condition.unique())
    colors = plt.get_cmap("tab10").colors
    color_map = {level: colors[index % len(colors)] for index, level in enumerate(levels)}

    frame = results.dropna(subset=["pvalue", "padj"]).copy()
    frame["neg_log10_padj"] = -np.log10(frame["padj"].clip(lower=1e-300))
    fig, ax = plt.subplots(figsize=(6, 5))
    ax.scatter(frame["log2FoldChange"], frame["neg_log10_padj"], s=8, alpha=0.6, color="#3b6ea5", linewidths=0)
    ax.axhline(-np.log10(0.05), color="#999999", linewidth=0.8, linestyle="--")
    ax.set_xlabel("log2 fold change")
    ax.set_ylabel("-log10 adjusted p-value")
    ax.set_title(f"{config['variable']}: {config['target']} vs {config['reference']}")
    fig.tight_layout()
    fig.savefig(os.path.join(output, "volcano.png"), dpi=150)
    fig.savefig(os.path.join(output, "volcano.pdf"))
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(6, 5))
    ax.scatter(frame["baseMean"].clip(lower=0.1), frame["log2FoldChange"], s=8, alpha=0.6, color="#8a5a44", linewidths=0)
    ax.set_xscale("log")
    ax.set_xlabel("mean normalized count")
    ax.set_ylabel("log2 fold change")
    ax.set_title("MA plot")
    fig.tight_layout()
    fig.savefig(os.path.join(output, "ma.png"), dpi=150)
    fig.savefig(os.path.join(output, "ma.pdf"))
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(5, 4))
    if normalized is not None and normalized.shape[0] >= 2:
        matrix = np.log2(normalized.T.to_numpy() + 1)
        coordinates = PCA(n_components=2, random_state=0).fit_transform(matrix)
        for level in levels:
            mask = (condition == level).to_numpy()
            ax.scatter(coordinates[mask, 0], coordinates[mask, 1], s=24, color=color_map[level], label=level)
        ax.set_xlabel("PC1")
        ax.set_ylabel("PC2")
        ax.legend(frameon=False, fontsize=8)
    else:
        ax.text(0.5, 0.5, "normalized counts unavailable", ha="center", va="center")
    ax.set_title("Sample PCA")
    fig.tight_layout()
    fig.savefig(os.path.join(output, "pca.png"), dpi=150)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as handle:
        config = json.load(handle)
    try:
        result = run(config)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        fail("analysis-failed", f"{type(error).__name__}: {error}")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

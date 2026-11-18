#!/usr/bin/env python3
"""bio-sc engine: a small, reproducible Scanpy pipeline behind the Node CLI contract.

The Node wrapper owns argument parsing, exit codes, and the JSON envelope. This
script receives a JSON config file and writes the analysis outputs plus a manifest.
"""

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
    print(json.dumps({"ok": False, "error": {"code": code, "message": message, "hint": hint or "run 'bio-sc --help'"}}), flush=True)
    raise SystemExit(1)


def load_input(path):
    import scanpy as sc

    if os.path.isdir(path):
        candidates = [
            path,
            os.path.join(path, "filtered_feature_bc_matrix"),
            os.path.join(path, "filtered_gene_bc_matrices"),
        ]
        for candidate in candidates:
            if os.path.exists(os.path.join(candidate, "matrix.mtx")) or os.path.exists(os.path.join(candidate, "matrix.mtx.gz")):
                return sc.read_10x_mtx(candidate, var_names="gene_symbols", cache=False)
        fail("invalid-input", f"no 10x matrix (matrix.mtx[.gz]) found under {path}")
    lowered = path.lower()
    if lowered.endswith((".h5ad", ".h5")):
        return sc.read_h5ad(path) if lowered.endswith(".h5ad") else sc.read_10x_h5(path)
    fail("invalid-input", f"unsupported input '{path}': pass an .h5ad file, a 10x .h5 file, or a 10x matrix directory")


def run(config):
    import anndata
    import numpy as np
    import pandas as pd
    import scanpy as sc

    sc.settings.verbosity = 0
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    input_path = config["input"]
    output = config["output"]
    os.makedirs(output, exist_ok=True)
    warnings = []

    adata = load_input(input_path)
    adata.var_names_make_unique()
    if adata.n_obs < 3:
        fail("invalid-input", f"input has only {adata.n_obs} cells; at least 3 are required")

    # QC metrics are recorded on every cell before filtering, so the report can show
    # what was removed as well as what survived.
    adata.var["mt"] = adata.var_names.str.upper().str.startswith("MT-")
    sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], percent_top=None, log1p=False, inplace=True)
    qc_all = adata.obs[["n_genes_by_counts", "total_counts", "pct_counts_mt"]].copy()

    min_genes = int(config["min_genes"])
    max_pct_mt = float(config["max_pct_mt"])
    before = int(adata.n_obs)
    sc.pp.filter_cells(adata, min_genes=min_genes)
    if bool(adata.var["mt"].any()):
        adata = adata[adata.obs["pct_counts_mt"] < max_pct_mt].copy()
    else:
        warnings.append("no MT- genes found; the mitochondrial filter was skipped")
    sc.pp.filter_genes(adata, min_cells=3)
    if adata.n_obs < 3:
        fail("analysis-failed", f"only {adata.n_obs} cells survived QC; lower --min-genes or raise --max-pct-mt")
    if adata.n_vars < 3:
        fail("analysis-failed", "fewer than 3 genes survived filtering")

    adata.layers["counts"] = adata.X.copy()
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    n_hvg = min(int(config["n_hvg"]), max(1, adata.n_vars - 1))
    sc.pp.highly_variable_genes(adata, n_top_genes=n_hvg)
    adata.var["highly_variable"] = adata.var["highly_variable"].fillna(False).astype(bool)

    n_pcs = min(int(config["n_pcs"]), max(2, min(adata.n_obs - 1, adata.n_vars - 1)))
    pca_genes = "highly_variable"
    try:
        sc.pp.pca(adata, n_comps=n_pcs, mask_var="highly_variable")
    except (BufferError, TypeError, ValueError) as error:
        # scanpy 1.12 + anndata 0.13 can trip the readonly-mask DLPack bug; disabling the
        # mask is the documented workaround. Record it instead of silently changing scope.
        warnings.append(f"PCA mask fallback to all genes: {type(error).__name__}: {error}")
        pca_genes = "all_genes"
        sc.pp.pca(adata, n_comps=n_pcs, mask_var=None)

    sc.pp.neighbors(adata, n_neighbors=10, n_pcs=n_pcs)
    try:
        sc.tl.leiden(
            adata,
            resolution=float(config["resolution"]),
            key_added="leiden",
            flavor="igraph",
            n_iterations=2,
            directed=False,
            random_state=int(config["seed"]),
        )
    except (TypeError, ValueError, ImportError) as error:
        warnings.append(f"Leiden igraph flavor unavailable, used the default: {error}")
        sc.tl.leiden(adata, resolution=float(config["resolution"]), key_added="leiden", random_state=int(config["seed"]))
    sc.tl.umap(adata, random_state=int(config["seed"]))

    clusters = adata.obs[["leiden"]].copy()
    clusters["umap_1"] = adata.obsm["X_umap"][:, 0]
    clusters["umap_2"] = adata.obsm["X_umap"][:, 1]
    clusters.index.name = "cell"
    clusters.to_csv(os.path.join(output, "clusters.csv"))

    sc.tl.rank_genes_groups(adata, "leiden", method="wilcoxon", use_raw=False)
    ranking = adata.uns["rank_genes_groups"]
    rows = []
    for group in ranking["names"].dtype.names:
        names = ranking["names"][group]
        scores = ranking["scores"][group]
        logfc = ranking["logfoldchanges"][group]
        pvals = ranking["pvals"][group]
        pvals_adj = ranking["pvals_adj"][group]
        for index, gene in enumerate(names):
            rows.append(
                {
                    "cluster": group,
                    "gene": str(gene),
                    "score": float(scores[index]),
                    "logfoldchange": float(logfc[index]),
                    "pval": float(pvals[index]),
                    "pval_adj": float(pvals_adj[index]),
                }
            )
    de = pd.DataFrame(rows)
    de.to_csv(os.path.join(output, "de.csv"), index=False)

    pseudobulk = None
    sample_key = config.get("sample_key")
    group_key = config.get("group_key")
    if sample_key and group_key:
        pseudobulk = pseudobulk_de(adata, output, sample_key, group_key, warnings)

    adata.write_h5ad(os.path.join(output, "out.h5ad"))
    qc_all.to_csv(os.path.join(output, "qc_metrics.csv"))
    write_umap(adata, os.path.join(output, "umap.png"), os.path.join(output, "umap.pdf"))

    outputs = ["out.h5ad", "qc_metrics.csv", "clusters.csv", "de.csv", "umap.png", "umap.pdf"]
    if pseudobulk:
        outputs.append("de_pseudobulk.csv")
    manifest = {
        "schema_version": 1,
        "tool": {"name": "bio-sc", "version": "0.1.0"},
        "started_at": started,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "parameters": {key: config[key] for key in config if key not in ("input", "output")},
        "input": {"path": os.path.abspath(input_path), "sha256": sha256(input_path) if os.path.isfile(input_path) else None},
        "outputs": {
            name: {"path": os.path.join(output, name), "bytes": os.path.getsize(os.path.join(output, name)), "sha256": sha256(os.path.join(output, name))}
            for name in outputs
        },
        "environment": {
            "python": platform.python_version(),
            "scanpy": version(sc),
            "anndata": version(anndata),
            "numpy": version(np),
            "pandas": version(pd),
        },
        "pca_genes": pca_genes,
        "warnings": warnings,
    }
    with open(os.path.join(output, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    summary = {
        "cells_before_qc": before,
        "cells_after_qc": int(adata.n_obs),
        "genes_after_filter": int(adata.n_vars),
        "clusters": int(adata.obs["leiden"].nunique()),
        "marker_rows": int(len(de)),
        "pseudobulk": bool(pseudobulk),
    }
    return {
        "ok": True,
        "outputs": {name: os.path.join(output, name) for name in outputs + ["manifest.json"]},
        "summary": summary,
        "warnings": warnings,
    }


def pseudobulk_de(adata, output, sample_key, group_key, warnings):
    """Sample-level pseudobulk DE with pydeseq2; skipped (with a warning) when underpowered."""
    try:
        import pandas as pd
        from pydeseq2.dds import DeseqDataSet
        from pydeseq2.ds import DeseqStats
    except Exception as error:  # noqa: BLE001 - optional dependency
        warnings.append(f"pseudobulk skipped: pydeseq2 unavailable ({error})")
        return False

    obs = adata.obs
    if sample_key not in obs.columns or group_key not in obs.columns:
        warnings.append(f"pseudobulk skipped: obs columns '{sample_key}'/'{group_key}' not found")
        return False
    samples = obs[[sample_key, group_key]].drop_duplicates()
    groups = samples[group_key].astype(str)
    if groups.nunique() != 2:
        warnings.append(f"pseudobulk skipped: '{group_key}' must have exactly 2 levels, found {groups.nunique()}")
        return False
    if groups.value_counts().min() < 2:
        warnings.append(f"pseudobulk skipped: fewer than 2 samples in one '{group_key}' level")
        return False

    counts = pd.DataFrame(
        adata.layers["counts"].toarray() if hasattr(adata.layers["counts"], "toarray") else adata.layers["counts"],
        index=obs_names(obs),
        columns=[str(gene) for gene in adata.var_names],
    )
    counts[sample_key] = obs[sample_key].astype(str).values
    aggregated = counts.groupby(sample_key, sort=True).sum()
    metadata = samples.set_index(sample_key).loc[aggregated.index].copy()
    metadata[group_key] = metadata[group_key].astype(str)
    # Drop genes with no counts in any pseudobulk sample; DESeq2 cannot estimate them.
    aggregated = aggregated.loc[:, aggregated.sum(axis=0) > 0]
    if aggregated.shape[1] < 2:
        warnings.append("pseudobulk skipped: fewer than 2 expressed genes")
        return False

    levels = sorted(metadata[group_key].unique())
    target, reference = levels[1], levels[0]
    try:
        dds = DeseqDataSet(counts=aggregated.astype(int), metadata=metadata, design=f"~{group_key}", refit_cooks=True, n_cpus=1)
        dds.deseq2()
        stats = DeseqStats(dds, contrast=[group_key, target, reference], n_cpus=1)
        stats.summary()
        result = stats.results_df.copy()
    except Exception as error:  # noqa: BLE001 - keep the main pipeline usable
        warnings.append(f"pseudobulk skipped: pydeseq2 failed ({type(error).__name__}: {error})")
        return False
    result.index.name = "gene"
    result.to_csv(os.path.join(output, "de_pseudobulk.csv"))
    return True


def obs_names(obs):
    return list(obs.index)


def write_umap(adata, png_path, pdf_path):
    clusters = adata.obs["leiden"].astype(str)
    labels = list(dict.fromkeys(clusters.tolist()))
    colors = plt.get_cmap("tab20").colors
    fig, ax = plt.subplots(figsize=(6, 5))
    coordinates = adata.obsm["X_umap"]
    for index, label in enumerate(labels):
        mask = (clusters == label).to_numpy()
        ax.scatter(coordinates[mask, 0], coordinates[mask, 1], s=6, color=colors[index % len(colors)], label=label, linewidths=0)
    ax.set_xlabel("UMAP1")
    ax.set_ylabel("UMAP2")
    ax.set_title("Leiden clusters")
    ax.legend(markerscale=3, fontsize=7, frameon=False, loc="best")
    fig.tight_layout()
    fig.savefig(png_path, dpi=150)
    fig.savefig(pdf_path)
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
    except Exception as error:  # noqa: BLE001 - the CLI reports one JSON error, never a traceback
        fail("analysis-failed", f"{type(error).__name__}: {error}")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

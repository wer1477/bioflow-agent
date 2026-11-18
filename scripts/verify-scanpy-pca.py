#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify that scanpy can run the common `normalize -> HVG -> PCA` flow.

Why this exists: with numpy < 2.1 the scanpy/anndata stack cannot export the read-only
HVG view through DLPack, and `sc.pp.pca(adata)` after `highly_variable_genes` fails with
`BufferError: Cannot export readonly array ...`, which reads as a scanpy bug but is an
environment mismatch. `requirements.txt` pins numpy >= 2.1 (currently 2.3.5); this check
turns a silent regression back into a failing command.

Run it with the Bioflow environment:
    .bioenv/bin/python scripts/verify-scanpy-pca.py

Exit codes: 0 the environment runs both the canonical and the documented fallback path;
1 the canonical path is broken; 2 an import failed.
"""
from __future__ import annotations

import sys


def main() -> int:
    try:
        from importlib import metadata
        import numpy as np
        import anndata as ad
        import scanpy as sc
    except Exception as exc:  # noqa: BLE001 - report the import failure, not a traceback
        print(f"IMPORT_FAIL {type(exc).__name__}: {exc}")
        return 2

    # `__version__` is deprecated on anndata/scanpy; read the installed distributions.
    print(
        f"numpy={metadata.version('numpy')} anndata={metadata.version('anndata')} "
        f"scanpy={metadata.version('scanpy')}"
    )
    rng = np.random.default_rng(0)
    matrix = rng.poisson(2.0, (300, 600)).astype("float32")

    def prepare() -> ad.AnnData:
        adata = ad.AnnData(X=matrix.copy())
        sc.pp.normalize_total(adata, target_sum=1e4)
        sc.pp.log1p(adata)
        sc.pp.highly_variable_genes(adata, n_top_genes=200)
        return adata

    adata = prepare()
    try:
        sc.pp.pca(adata, n_comps=10)
    except Exception as exc:  # noqa: BLE001 - the failure mode is the point of the check
        print(f"PCA_FAIL {type(exc).__name__}: {exc}")
        print("hint: numpy >= 2.1 is required; check scripts/check-bioenv-pins.py")
        return 1
    print(f"PCA_OK shape={adata.obsm['X_pca'].shape}")

    # The skill documentation falls back to an explicit mask when an older numpy is
    # unavoidable; that path must keep working as well.
    fallback = prepare()
    try:
        sc.pp.pca(fallback, n_comps=10, mask_var=None)
    except Exception as exc:  # noqa: BLE001
        print(f"MASK_VAR_FALLBACK_FAIL {type(exc).__name__}: {exc}")
        return 1
    print(f"MASK_VAR_FALLBACK_OK shape={fallback.obsm['X_pca'].shape}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

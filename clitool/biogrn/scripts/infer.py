#!/usr/bin/env python3
"""Run a validated Arboreto inference request received as one JSON document on stdin."""

import csv
import json
import os
import sys
from importlib.metadata import version


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def load_expression(path):
    with open(path, encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t")
        header = next(reader)
        rows = [[float(value) for value in row] for row in reader if any(value.strip() for value in row)]
    return header, rows


def main():
    request = json.load(sys.stdin)
    try:
        import pandas as pd
        from arboreto.algo import genie3, grnboost2
    except ModuleNotFoundError as error:
        fail(str(error))

    gene_names, rows = load_expression(request["expression_path"])
    expression = pd.DataFrame(rows, columns=gene_names)
    algorithm = grnboost2 if request["method"] == "grnboost2" else genie3
    network = algorithm(expression_data=expression, tf_names=request["tf_names"], seed=request["seed"])
    network = network.sort_values(["importance", "TF", "target"], ascending=[False, True, True], kind="mergesort")
    edge_count = len(network)
    network = network.head(request["max_edges"])

    output_path = request["output_path"]
    manifest_path = request["manifest_path"]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    network.to_csv(output_path, sep="\t", index=False)
    manifest = {
        "schema_version": 1,
        "interpretation": "candidate_regulatory_associations_not_causal_or_direct_binding_evidence",
        "method": request["method"],
        "seed": request["seed"],
        "expression_path": request["expression_path"],
        "tf_count": len(request["tf_names"]),
        "edge_count": edge_count,
        "retained_edge_count": len(network),
        "python": sys.version.split()[0],
        "arboreto": version("arboreto"),
    }
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, sort_keys=True)
        handle.write("\n")
    print(json.dumps({"edge_count": edge_count, "retained_edge_count": len(network), "python": manifest["python"], "arboreto": manifest["arboreto"]}))


if __name__ == "__main__":
    main()

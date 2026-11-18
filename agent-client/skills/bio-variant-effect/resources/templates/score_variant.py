#!/usr/bin/env python3
"""Score one SNV/small indel with the official AlphaGenome client.

Research use only; not a clinical interpretation. Requires the `alphagenome`
package and an API key in ALPHA_GENOME_API_KEY (ALPHAGENOME_API_KEY accepted
as a fallback for this harness). See SKILL.md for the confirmed API surface.

Example:
  python3 score_variant.py --chrom chr22 --pos 36201698 --ref A --alt C \
      --scorers RNA_SEQ SPLICE_SITES ATAC CHIP_HISTONE --out scores.tsv

The script never prints the key. Use --dry-run to validate arguments and show
the request summary without contacting the service.
"""
import argparse
import os
import sys

# Keys confirmed in alphagenome.models.v1.variant_scorers.RECOMMENDED_VARIANT_SCORERS
SCORER_KEYS = (
    "ATAC", "ATAC_ACTIVE", "CAGE", "CAGE_ACTIVE", "CHIP_HISTONE",
    "CHIP_HISTONE_ACTIVE", "CHIP_TF", "CHIP_TF_ACTIVE", "CONTACT_MAPS",
    "DNASE", "DNASE_ACTIVE", "POLYADENYLATION", "PROCAP", "PROCAP_ACTIVE",
    "RNA_SEQ", "RNA_SEQ_ACTIVE", "SPLICE_JUNCTIONS", "SPLICE_SITES",
    "SPLICE_SITE_USAGE",
)
ORGANISMS = ("human", "mouse")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrom", required=True, help="e.g. chr22 (hg38)")
    parser.add_argument("--pos", required=True, type=int, help="1-based VCF position")
    parser.add_argument("--ref", required=True, help="reference allele, e.g. A")
    parser.add_argument("--alt", required=True, help="alternate allele, e.g. C")
    parser.add_argument("--scorers", nargs="+", default=["RNA_SEQ", "SPLICE_SITES",
                                                          "ATAC", "CHIP_HISTONE"],
                        choices=SCORER_KEYS)
    parser.add_argument("--organism", default="human", choices=ORGANISMS)
    parser.add_argument("--out", default="scores.tsv", help="output TSV path")
    parser.add_argument("--dry-run", action="store_true",
                        help="validate args and print the request summary only")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    ref, alt = args.ref.upper(), args.alt.upper()
    if args.pos < 1:
        sys.exit("--pos must be >= 1 (the model uses 1-based variant positions)")
    if not set(ref + alt) <= set("ACGTN") or not ref or not alt:
        sys.exit("--ref/--alt must be non-empty sequences over ACGTN")

    interval_length = 1_048_576  # SEQUENCE_LENGTH_1MB; 16KB/100KB/500KB also valid
    print(f"variant: {args.chrom}:{args.pos} {ref}>{alt}", file=sys.stderr)
    print(f"interval: {interval_length} bp centered on the variant", file=sys.stderr)
    print(f"scorers: {', '.join(args.scorers)}; organism: {args.organism}", file=sys.stderr)

    if args.dry_run:
        return 0

    api_key = os.environ.get("ALPHA_GENOME_API_KEY") or os.environ.get("ALPHAGENOME_API_KEY")
    if not api_key:
        sys.exit("ALPHA_GENOME_API_KEY is not set (ALPHAGENOME_API_KEY also accepted)")

    from alphagenome.data import genome
    from alphagenome.models.v1 import dna_client, variant_scorers

    organism = {"human": dna_client.Organism.HOMO_SAPIENS,
                "mouse": dna_client.Organism.MUS_MUSCULUS}[args.organism]
    model = dna_client.create(api_key=api_key)
    variant = genome.Variant(chromosome=args.chrom, position=args.pos,
                             reference_bases=ref, alternate_bases=alt)
    interval = variant.reference_interval.resize(dna_client.SEQUENCE_LENGTH_1MB)
    scorers = [variant_scorers.RECOMMENDED_VARIANT_SCORERS[key] for key in args.scorers]
    scores = model.score_variant(interval=interval, variant=variant,
                                 variant_scorers=scorers, organism=organism)
    table = variant_scorers.tidy_scores(scores)
    if table is None or table.empty:
        sys.exit("the service returned no scores; check coordinates/build and scorers")
    table.to_csv(args.out, sep="\t", index=False)
    print(f"wrote {len(table)} score rows to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

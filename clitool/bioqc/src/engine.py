#!/usr/bin/env python3
"""bio-qc statistics engine.

The Node CLI sends one JSON request on stdin and expects one JSON document on
stdout. Statistics are implemented here so that FASTQ/CSV QC does not require
third-party Python packages. BAM and h5ad support import pysam/anndata lazily
and fail with an actionable dependency error when they are unavailable.
"""

import csv
import gzip
import hashlib
import itertools
import json
import math
import os
import platform
import sys
import traceback

SCHEMA_VERSION = 1
DEFAULT_LENGTH_DISTRIBUTION_LIMIT = 20
LENGTH_TRACK_LIMIT = 10000
MITO_PREFIX = "MT-"
HIGH_MITO_PCT = 20.0
Q20_TABLE = bytes(1 if (value - 33) >= 20 else 0 for value in range(256))
Q30_TABLE = bytes(1 if (value - 33) >= 30 else 0 for value in range(256))


class EngineError(Exception):
    def __init__(self, code, message, hint):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


def python_info():
    return {
        "executable": sys.executable,
        "version": platform.python_version(),
    }


def ratio(numerator, denominator):
    return round(float(numerator) / float(denominator), 6) if denominator else 0.0


def percentage(numerator, denominator):
    return round(float(numerator) * 100.0 / float(denominator), 6) if denominator else 0.0


def summarize(values, include_total=True):
    numbers = [float(value) for value in values]
    if not numbers:
        summary = {
            "count": 0,
            "min": None,
            "p25": None,
            "median": None,
            "mean": None,
            "p75": None,
            "max": None,
        }
        if include_total:
            summary["total"] = 0.0
        return summary
    numbers.sort()
    total = sum(numbers)

    def quantile(fraction):
        if len(numbers) == 1:
            return numbers[0]
        position = (len(numbers) - 1) * fraction
        lower = int(math.floor(position))
        upper = int(math.ceil(position))
        if lower == upper:
            return numbers[lower]
        return numbers[lower] + (numbers[upper] - numbers[lower]) * (position - lower)

    summary = {
        "count": len(numbers),
        "min": round(numbers[0], 6),
        "p25": round(quantile(0.25), 6),
        "median": round(quantile(0.5), 6),
        "mean": round(total / len(numbers), 6),
        "p75": round(quantile(0.75), 6),
        "max": round(numbers[-1], 6),
    }
    if include_total:
        summary["total"] = round(total, 6)
    return summary


class HashingReader:
    """Read raw bytes and hash exactly the bytes consumed."""

    def __init__(self, handle):
        self.handle = handle
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size=-1):
        data = self.handle.read(size)
        if data:
            self.digest.update(data)
            self.size += len(data)
        return data

    def drain(self):
        while True:
            chunk = self.read(1024 * 1024)
            if not chunk:
                return

    def readable(self):
        return True

    def seekable(self):
        return False


class PrefixReader:
    """Replay a small prefix (the gzip magic bytes) before the hashing reader."""

    def __init__(self, prefix, reader):
        self.prefix = prefix
        self.reader = reader

    def read(self, size=-1):
        if not self.prefix:
            return self.reader.read(size)
        if size is None or size < 0:
            data = self.prefix + self.reader.read(-1)
            self.prefix = b""
            return data
        data = self.prefix[:size]
        self.prefix = self.prefix[size:]
        if len(data) < size:
            data += self.reader.read(size - len(data))
        return data

    def readable(self):
        return True

    def seekable(self):
        return False


class LineReader:
    def __init__(self, reader):
        self.reader = reader
        self.buffer = b""
        self.eof = False

    def readline(self):
        while b"\n" not in self.buffer and not self.eof:
            chunk = self.reader.read(1024 * 1024)
            if chunk:
                self.buffer += chunk
            else:
                self.eof = True
        position = self.buffer.find(b"\n")
        if position < 0:
            line = self.buffer
            self.buffer = b""
            return line
        line = self.buffer[: position + 1]
        self.buffer = self.buffer[position + 1 :]
        return line


def iter_fastq_records(reader, path):
    while True:
        header = reader.readline()
        if not header:
            return
        header = header.rstrip(b"\r\n")
        if not header:
            continue
        if not header.startswith(b"@"):
            preview = header[:40].decode("ascii", "replace")
            raise EngineError(
                "invalid-input",
                f"Malformed FASTQ in {path}: expected a header starting with '@', found {preview!r}.",
                "Confirm this is a FASTQ file (optionally gzip-compressed), not SAM/BAM or a text table.",
            )
        sequence_chunks = []
        line = reader.readline()
        while line and not line.startswith(b"+"):
            sequence_chunks.append(line.rstrip(b"\r\n"))
            line = reader.readline()
        if not line:
            raise EngineError(
                "invalid-input",
                f"Truncated FASTQ in {path}: the record starting with {header[:40]!r} has no '+' separator.",
                "Re-download or repair the FASTQ file, then retry.",
            )
        sequence = b"".join(sequence_chunks)
        quality_chunks = []
        quality_length = 0
        while quality_length < len(sequence) or (not sequence and not quality_chunks):
            quality_line = reader.readline()
            if not quality_line:
                raise EngineError(
                    "invalid-input",
                    f"Truncated FASTQ in {path}: the record starting with {header[:40]!r} has a short quality string.",
                    "Re-download or repair the FASTQ file, then retry.",
                )
            quality_line = quality_line.rstrip(b"\r\n")
            quality_chunks.append(quality_line)
            quality_length += len(quality_line)
        quality = b"".join(quality_chunks)
        if len(quality) != len(sequence):
            raise EngineError(
                "invalid-input",
                f"Malformed FASTQ in {path}: sequence length {len(sequence)} does not match quality length {len(quality)}.",
                "Confirm the file uses four-line FASTQ records with matching sequence and quality lengths.",
            )
        yield sequence, quality


def collect_fastq_metrics(lines, path):
    reads = 0
    bases = 0
    q20_bases = 0
    q30_bases = 0
    gc_bases = 0
    n_bases = 0
    length_sum = 0
    min_length = None
    max_length = 0
    length_counts = {}
    tracking_truncated = False

    for sequence, quality in iter_fastq_records(lines, path):
        length = len(sequence)
        reads += 1
        bases += length
        length_sum += length
        min_length = length if min_length is None else min(min_length, length)
        max_length = max(max_length, length)
        upper = sequence.upper()
        gc_bases += upper.count(b"G") + upper.count(b"C")
        n_bases += upper.count(b"N")
        q20_bases += quality.translate(Q20_TABLE).count(b"\x01")
        q30_bases += quality.translate(Q30_TABLE).count(b"\x01")
        if length not in length_counts and len(length_counts) >= LENGTH_TRACK_LIMIT:
            tracking_truncated = True
        else:
            length_counts[length] = length_counts.get(length, 0) + 1

    if reads == 0:
        raise EngineError(
            "invalid-input",
            f"FASTQ file contains no reads: {path}",
            "Check that --input points to a non-empty FASTQ file.",
        )

    metrics = {
        "reads": reads,
        "bases": bases,
        "q20_bases": q20_bases,
        "q20_ratio": ratio(q20_bases, bases),
        "q30_bases": q30_bases,
        "q30_ratio": ratio(q30_bases, bases),
        "gc_bases": gc_bases,
        "gc_pct": percentage(gc_bases, bases),
        "n_bases": n_bases,
        "n_pct": percentage(n_bases, bases),
        "mean_length": round(length_sum / reads, 3),
        "min_length": min_length if min_length is not None else 0,
        "max_length": max_length,
        "quality_encoding": "phred+33",
        "distinct_length_count": len(length_counts),
        "length_distribution_truncated": tracking_truncated,
    }
    return metrics, length_counts, tracking_truncated


def scan_fastq(path, role):
    raw = None
    hashing = None
    gzip_stream = None
    magic = b""
    try:
        raw = open(path, "rb")
        hashing = HashingReader(raw)
        magic = hashing.read(2)
        stream = PrefixReader(magic, hashing)
        if magic == b"\x1f\x8b":
            gzip_stream = gzip.GzipFile(fileobj=stream, mode="rb")
            stream = gzip_stream
        lines = LineReader(stream)
        metrics, length_counts, tracking_truncated = collect_fastq_metrics(lines, path)
        if gzip_stream is not None:
            gzip_stream.close()
        hashing.drain()
        metrics["sha256"] = hashing.digest.hexdigest()
        metrics["bytes"] = hashing.size
        metrics["compression"] = "gzip" if magic == b"\x1f\x8b" else "plain"
        metrics["role"] = role
        metrics["path"] = path
        return metrics, length_counts, tracking_truncated
    except EngineError:
        raise
    except OSError as exc:
        raise EngineError(
            "invalid-input",
            f"Cannot read FASTQ {path}: {exc}",
            "Check that the file exists, is readable, and is a FASTQ or gzip-compressed FASTQ.",
        )
    finally:
        if gzip_stream is not None:
            try:
                gzip_stream.close()
            except Exception:
                pass
        if raw is not None:
            raw.close()


def length_distribution(length_counts, limit, tracking_truncated):
    ordered = sorted(length_counts)
    entries = [{"length": length, "count": length_counts[length]} for length in ordered[:limit]]
    return entries, bool(tracking_truncated or len(ordered) > limit)


def length_bins(length_counts, min_length, max_length, limit):
    if not length_counts:
        return []
    span = max_length - min_length + 1
    bin_count = min(limit, max(1, span))
    width = max(1, int(math.ceil(float(span) / float(bin_count))))
    entries = []
    start = min_length
    while start <= max_length and len(entries) < limit:
        end = min(max_length, start + width - 1)
        count = sum(value for length, value in length_counts.items() if start <= length <= end)
        entries.append({"start": start, "end": end, "count": count})
        start = end + 1
    return entries


def combine_fastq(files, length_counts_list, truncations, limit):
    total = {
        "reads": 0,
        "bases": 0,
        "q20_bases": 0,
        "q30_bases": 0,
        "gc_bases": 0,
        "n_bases": 0,
    }
    length_counts = {}
    for metrics, counts in zip(files, length_counts_list):
        for key in total:
            total[key] += metrics[key]
        for length, count in counts.items():
            length_counts[length] = length_counts.get(length, 0) + count
    entries, truncated = length_distribution(length_counts, limit, any(truncations))
    combined = {
        "reads": total["reads"],
        "bases": total["bases"],
        "q20_bases": total["q20_bases"],
        "q20_ratio": ratio(total["q20_bases"], total["bases"]),
        "q30_bases": total["q30_bases"],
        "q30_ratio": ratio(total["q30_bases"], total["bases"]),
        "gc_bases": total["gc_bases"],
        "gc_pct": percentage(total["gc_bases"], total["bases"]),
        "n_bases": total["n_bases"],
        "n_pct": percentage(total["n_bases"], total["bases"]),
        "mean_length": round(total["bases"] / total["reads"], 3) if total["reads"] else 0.0,
        "min_length": min(file["min_length"] for file in files),
        "max_length": max(file["max_length"] for file in files),
        "quality_encoding": "phred+33",
        "distinct_length_count": len(length_counts),
        "length_distribution": entries,
        "length_bins": length_bins(length_counts, min(file["min_length"] for file in files), max(file["max_length"] for file in files), limit),
        "length_distribution_truncated": truncated,
        "read_pairs": None,
    }
    if len(files) == 2 and files[0]["reads"] == files[1]["reads"]:
        combined["read_pairs"] = files[0]["reads"]
    return combined


def run_fastq(request):
    inputs = request.get("inputs")
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 2:
        raise EngineError("invalid-input", "fastq engine requests need one or two inputs.", "This is an internal CLI error; run bio-qc check.")
    limit = int(request.get("length_distribution_limit") or DEFAULT_LENGTH_DISTRIBUTION_LIMIT)
    if limit < 1 or limit > 1000:
        limit = DEFAULT_LENGTH_DISTRIBUTION_LIMIT
    files = []
    counts_list = []
    truncations = []
    warnings = []
    for item in inputs:
        path = item.get("path")
        role = item.get("role") or f"read{len(files) + 1}"
        if not isinstance(path, str) or not path:
            raise EngineError("invalid-input", "fastq engine requests need a path for every input.", "This is an internal CLI error; run bio-qc check.")
        metrics, counts, truncated = scan_fastq(path, role)
        entries, distribution_truncated = length_distribution(counts, limit, truncated)
        metrics["length_distribution"] = entries
        metrics["length_bins"] = length_bins(counts, metrics["min_length"], metrics["max_length"], limit)
        metrics["length_distribution_truncated"] = distribution_truncated
        files.append(metrics)
        counts_list.append(counts)
        truncations.append(truncated)
    combined = combine_fastq(files, counts_list, truncations, limit)
    if len(files) == 2 and files[0]["reads"] != files[1]["reads"]:
        warnings.append(
            f"Paired FASTQ read counts differ: {files[0]['reads']} ({files[0]['role']}) vs {files[1]['reads']} ({files[1]['role']}); combined metrics treat reads independently."
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "command": "fastq",
        "python": python_info(),
        "files": files,
        "combined": combined,
        "warnings": warnings,
    }


def coverage_payload(references, lengths, reference_bases, reference_reads, aligned_bases):
    covered_indices = [
        index
        for index in range(len(references))
        if reference_reads[index] > 0 and (lengths[index] or 0) > 0
    ]
    genome_length = sum(length for length in lengths if length and length > 0)
    covered_length = sum(lengths[index] for index in covered_indices)
    entries = []
    for index, name in enumerate(references):
        length = lengths[index] or 0
        bases = reference_bases[index]
        if bases == 0:
            continue
        entries.append(
            {
                "name": str(name),
                "length": int(length),
                "aligned_bases": int(bases),
                "coverage": round(float(bases) / float(length), 6) if length else None,
            }
        )
    entries.sort(key=lambda entry: (-entry["aligned_bases"], entry["name"]))
    return {
        "reference_count": len(references),
        "covered_reference_count": len(covered_indices),
        "aligned_bases": int(aligned_bases),
        "reference_bases": int(genome_length),
        "mean_coverage": round(float(aligned_bases) / float(covered_length), 6) if covered_length else None,
        "genome_coverage": round(float(aligned_bases) / float(genome_length), 6) if genome_length else None,
        "coverage_method": "aligned_query_bases_over_reference_length",
        "top_references": entries[:20],
    }


def run_bam(request):
    try:
        import pysam
    except Exception as exc:
        raise EngineError(
            "dependency-missing",
            f"pysam is not importable from {sys.executable} (Python {platform.python_version()}): {exc}",
            f'Install it with "{sys.executable}" -m pip install pysam, or refresh the repository .bioenv from requirements.txt.',
        )
    path = (request.get("input") or {}).get("path")
    if not isinstance(path, str) or not path:
        raise EngineError("invalid-input", "bam engine requests need an input path.", "This is an internal CLI error; run bio-qc check.")
    if not os.path.isfile(path):
        raise EngineError("invalid-input", f"BAM file does not exist: {path}", "Pass an existing BAM file; CRAM is not supported by this command.")
    try:
        bam = pysam.AlignmentFile(path, "rb")
    except Exception as exc:
        raise EngineError(
            "invalid-input",
            f"Could not open BAM {path}: {exc}",
            "Confirm the file is a BAM alignment file; CRAM is not supported by this command.",
        )

    try:
        references = list(bam.references or [])
        lengths = [int(length or 0) for length in (bam.lengths or [])]
        reference_bases = [0 for _ in references]
        reference_reads = [0 for _ in references]
        total_reads = 0
        mapped_reads = 0
        duplicate_reads = 0
        properly_paired_reads = 0
        secondary_reads = 0
        supplementary_reads = 0
        read_length_sum = 0
        insert_size_sum = 0
        insert_size_pairs = 0
        try:
            for read in bam.fetch(until_eof=True):
                total_reads += 1
                read_length_sum += read.query_length or 0
                if read.is_secondary:
                    secondary_reads += 1
                if read.is_supplementary:
                    supplementary_reads += 1
                if read.is_unmapped:
                    continue
                mapped_reads += 1
                if read.is_duplicate:
                    duplicate_reads += 1
                if read.is_proper_pair:
                    properly_paired_reads += 1
                if read.is_proper_pair and read.template_length and read.template_length > 0:
                    insert_size_sum += read.template_length
                    insert_size_pairs += 1
                reference_id = read.reference_id
                if reference_id is not None and 0 <= reference_id < len(references):
                    reference_bases[reference_id] += read.query_alignment_length or 0
                    reference_reads[reference_id] += 1
        except Exception as exc:
            raise EngineError(
                "analysis-failed",
                f"Could not iterate BAM records in {path}: {exc}",
                "Re-index or re-generate the BAM file, then retry.",
            )
    finally:
        bam.close()

    coverage = coverage_payload(references, lengths, reference_bases, reference_reads, sum(reference_bases))
    metrics = {
        "total_reads": total_reads,
        "mapped_reads": mapped_reads,
        "unmapped_reads": total_reads - mapped_reads,
        "mapped_ratio": ratio(mapped_reads, total_reads),
        "duplicate_reads": duplicate_reads,
        "duplicate_ratio": ratio(duplicate_reads, mapped_reads),
        "properly_paired_reads": properly_paired_reads,
        "properly_paired_ratio": ratio(properly_paired_reads, mapped_reads),
        "secondary_reads": secondary_reads,
        "supplementary_reads": supplementary_reads,
        "average_read_length": round(read_length_sum / total_reads, 3) if total_reads else None,
        "average_insert_size": round(insert_size_sum / insert_size_pairs, 3) if insert_size_pairs else None,
        "insert_size_read_pairs": insert_size_pairs,
        "reference_count": coverage["reference_count"],
        "covered_reference_count": coverage["covered_reference_count"],
        "aligned_bases": coverage["aligned_bases"],
        "reference_bases": coverage["reference_bases"],
        "mean_coverage": coverage["mean_coverage"],
        "genome_coverage": coverage["genome_coverage"],
        "coverage_method": coverage["coverage_method"],
        "top_references": coverage["top_references"],
    }
    warnings = []
    if total_reads == 0:
        warnings.append("BAM contains no alignment records.")
    if not references:
        warnings.append("BAM header has no reference sequences; coverage cannot be estimated.")
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "command": "bam",
        "python": python_info(),
        "pysam": {"version": getattr(pysam, "__version__", None)},
        "metrics": metrics,
        "warnings": warnings,
    }


def matrix_metrics(cells, genes, counts, detected, mito_pct, mito_gene_count, info):
    metrics = {
        "input_type": info["input_type"],
        "cells": int(cells),
        "genes": int(genes),
        "total_counts": round(float(sum(counts)), 6),
        "matrix": {
            "dtype": info.get("dtype"),
            "sparse": bool(info.get("sparse")),
            "count_values_look_raw": bool(info.get("count_values_look_raw")),
        },
        "counts_per_cell": summarize(counts),
        "genes_detected_per_cell": summarize(detected),
        "pct_mito": None,
    }
    if mito_gene_count and mito_pct is not None:
        metrics["pct_mito"] = {
            "prefix": MITO_PREFIX,
            "gene_count": int(mito_gene_count),
            "threshold_pct": HIGH_MITO_PCT,
            "cells_over_threshold": int(sum(1 for value in mito_pct if value > HIGH_MITO_PCT)),
            "per_cell": summarize(mito_pct, include_total=False),
        }
    return metrics


def mito_percentages(counts, mito_counts):
    percentages = []
    for total, mito in zip(counts, mito_counts):
        percentages.append(float(mito) * 100.0 / float(total) if total else 0.0)
    return percentages


def load_h5ad(path):
    try:
        import numpy as np
        import anndata
    except Exception as exc:
        raise EngineError(
            "dependency-missing",
            f"Reading .h5ad requires anndata and numpy, which are not importable from {sys.executable} (Python {platform.python_version()}): {exc}",
            f'Install them with "{sys.executable}" -m pip install anndata h5py, or pass a dense CSV/TSV matrix instead.',
        )
    try:
        adata = anndata.read_h5ad(path)
    except Exception as exc:
        raise EngineError(
            "invalid-input",
            f"Could not read h5ad {path}: {exc}",
            "Confirm the file is an AnnData .h5ad object and was written by a compatible anndata version.",
        )
    if adata.n_obs == 0 or adata.n_vars == 0:
        raise EngineError("invalid-input", f"h5ad matrix has zero cells or genes: {path}", "Provide a non-empty AnnData object.")
    matrix = adata.X
    if matrix is None:
        raise EngineError("invalid-input", f"h5ad object has no X matrix: {path}", "Write the expression matrix to adata.X before running QC.")
    try:
        from scipy import sparse as scipy_sparse
        is_sparse = scipy_sparse.issparse(matrix)
    except Exception:
        is_sparse = hasattr(matrix, "tocsr") and hasattr(matrix, "getnnz")
    if is_sparse:
        csr = matrix.tocsr()
        counts = np.asarray(csr.sum(axis=1)).ravel()
        detected = np.asarray(csr.getnnz(axis=1)).ravel()
        count_like = bool(np.issubdtype(csr.dtype, np.integer))
        dtype = str(csr.dtype)
    else:
        dense = np.asarray(matrix)
        counts = dense.sum(axis=1)
        detected = (dense != 0).sum(axis=1)
        count_like = bool(np.issubdtype(dense.dtype, np.integer))
        dtype = str(dense.dtype)
    genes = [str(name) for name in adata.var_names]
    mito_indices = [index for index, name in enumerate(genes) if name.upper().startswith(MITO_PREFIX)]
    mito_pct = None
    if mito_indices:
        if is_sparse:
            mito_counts = np.asarray(csr[:, mito_indices].sum(axis=1)).ravel()
        else:
            mito_counts = dense[:, mito_indices].sum(axis=1)
        mito_pct = mito_percentages(counts.tolist(), mito_counts.tolist())
    info = {
        "input_type": "h5ad",
        "dtype": dtype,
        "sparse": is_sparse,
        "count_values_look_raw": count_like,
    }
    metrics = matrix_metrics(adata.n_obs, adata.n_vars, counts.tolist(), detected.tolist(), mito_pct, len(mito_indices), info)
    warnings = []
    if not count_like:
        warnings.append("Matrix values are not all integers; counts_per_cell and pct_mito use the values exactly as provided (normalized or transformed values may not represent sequencing counts).")
    if not mito_indices:
        warnings.append("No gene names start with 'MT-'; pct_mito is null.")
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "command": "matrix",
        "python": python_info(),
        "input": {"path": path, "type": "h5ad"},
        "metrics": metrics,
        "warnings": warnings,
    }


def read_first_column(path):
    if path.endswith(".gz"):
        handle = gzip.open(path, "rt", encoding="utf-8", errors="replace")
    else:
        handle = open(path, "r", encoding="utf-8", errors="replace")
    try:
        names = []
        for line in handle:
            if not line.strip():
                continue
            names.append(line.rstrip("\r\n").split("\t")[0].strip())
        return names
    finally:
        handle.close()


def find_first(directory, names):
    for name in names:
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate):
            return candidate
    return None


def load_mtx_dir(path):
    try:
        import numpy as np
        from scipy.io import mmread
    except Exception as exc:
        raise EngineError(
            "dependency-missing",
            f"Reading a 10x Matrix Market directory requires numpy and scipy, which are not importable from {sys.executable} (Python {platform.python_version()}): {exc}",
            f'Install them with "{sys.executable}" -m pip install scipy numpy, or convert the matrix to CSV first.',
        )
    matrix_file = find_first(path, ["matrix.mtx", "matrix.mtx.gz"])
    if not matrix_file:
        raise EngineError(
            "invalid-input",
            f"10x Matrix Market directory has no matrix.mtx or matrix.mtx.gz: {path}",
            "Pass a directory containing matrix.mtx(.gz), features.tsv(.gz) or genes.tsv(.gz), and optionally barcodes.tsv(.gz).",
        )
    try:
        if matrix_file.endswith(".gz"):
            handle = gzip.open(matrix_file, "rb")
        else:
            handle = open(matrix_file, "rb")
        try:
            matrix = mmread(handle)
        finally:
            handle.close()
    except Exception as exc:
        raise EngineError(
            "invalid-input",
            f"Could not parse Matrix Market file {matrix_file}: {exc}",
            "Confirm the file uses Matrix Market coordinate format (matrix.mtx).",
        )
    try:
        matrix = matrix.tocsr()
    except Exception as exc:
        raise EngineError("invalid-input", f"Could not convert matrix to CSR: {exc}", "Confirm the Matrix Market file is a numeric sparse matrix.")
    genes, cells = matrix.shape
    if cells == 0 or genes == 0:
        raise EngineError("invalid-input", f"Matrix Market matrix has zero cells or genes: {path}", "Provide a non-empty 10x matrix directory.")
    counts = np.asarray(matrix.sum(axis=0)).ravel()
    detected = np.asarray(matrix.getnnz(axis=0)).ravel()
    features_file = find_first(path, ["features.tsv", "features.tsv.gz", "genes.tsv", "genes.tsv.gz"])
    barcodes_file = find_first(path, ["barcodes.tsv", "barcodes.tsv.gz"])
    warnings = []
    gene_names = []
    if features_file:
        gene_names = read_first_column(features_file)
        if len(gene_names) != genes:
            warnings.append(f"Feature count {len(gene_names)} in {features_file} differs from matrix rows {genes}; pct_mito uses the available names.")
            gene_names = gene_names[:genes]
    else:
        warnings.append(f"No features.tsv/genes.tsv found in {path}; gene names are unavailable and pct_mito is null.")
    if barcodes_file:
        barcodes = read_first_column(barcodes_file)
        if len(barcodes) != cells:
            warnings.append(f"Barcode count {len(barcodes)} in {barcodes_file} differs from matrix columns {cells}.")
    mito_indices = [index for index, name in enumerate(gene_names) if name.upper().startswith(MITO_PREFIX)]
    mito_pct = None
    if mito_indices:
        mito_counts = np.asarray(matrix[mito_indices, :].sum(axis=0)).ravel()
        mito_pct = mito_percentages(counts.tolist(), mito_counts.tolist())
    elif features_file:
        warnings.append("No gene names start with 'MT-'; pct_mito is null.")
    count_like = bool(np.issubdtype(matrix.dtype, np.integer))
    info = {
        "input_type": "mtx-dir",
        "dtype": str(matrix.dtype),
        "sparse": True,
        "count_values_look_raw": count_like,
    }
    metrics = matrix_metrics(cells, genes, counts.tolist(), detected.tolist(), mito_pct, len(mito_indices), info)
    if not count_like:
        warnings.append("Matrix values are not all integers; counts_per_cell use the values exactly as provided.")
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "command": "matrix",
        "python": python_info(),
        "input": {"path": path, "type": "mtx-dir"},
        "metrics": metrics,
        "warnings": warnings,
    }


def parse_dense_number(text, path, row_number, column_number):
    value = text.strip()
    if value == "":
        return 0.0, True
    try:
        number = float(value)
    except ValueError:
        raise EngineError(
            "invalid-input",
            f"Non-numeric value in {path} at data row {row_number}, column {column_number}: {value!r}",
            "Dense matrices must contain numeric values in every cell; use an empty field or 0 for missing values.",
        )
    if not math.isfinite(number):
        raise EngineError(
            "invalid-input",
            f"Non-finite value in {path} at data row {row_number}, column {column_number}: {value!r}",
            "Replace NaN/Infinity values before running matrix QC.",
        )
    return number, False


def nonempty_rows(reader):
    for row in reader:
        if row:
            yield row


def load_dense(path, matrix_type):
    delimiter = "\t" if matrix_type == "tsv" else ","
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        try:
            header = next(reader)
        except StopIteration:
            raise EngineError("invalid-input", f"Matrix file is empty: {path}", "Provide a CSV/TSV matrix with a header row and at least one data row.")
        header = [column.strip() for column in header]
        if not header:
            raise EngineError("invalid-input", f"Matrix file has an empty header: {path}", "The header must contain gene names.")
        rows = nonempty_rows(reader)
        try:
            first_row = next(rows)
        except StopIteration:
            raise EngineError("invalid-input", f"Matrix file has a header but no data rows: {path}", "Provide at least one cell row.")
        id_header_names = {"", "cell", "cells", "barcode", "barcodes", "id", "sample", "samples"}
        id_column = header[0].strip().lower() in id_header_names or not is_number(first_row[0].strip())
        offset = 1 if id_column else 0
        rows = itertools.chain([first_row], rows)
        gene_names = header[offset:]
        if not gene_names or any(not gene for gene in gene_names):
            raise EngineError(
                "invalid-input",
                f"Matrix header in {path} contains an empty gene name.",
                "Provide one non-empty gene name per column (the first column may hold cell IDs).",
            )
        mito_indices = [index for index, name in enumerate(gene_names) if name.upper().startswith(MITO_PREFIX)]
        mito_index_set = set(mito_indices)
        counts = []
        detected = []
        mito_counts = []
        empty_values = 0
        all_integers = True
        for row_number, row in enumerate(rows, start=1):
            if len(row) != len(header):
                raise EngineError(
                    "invalid-input",
                    f"Matrix row {row_number} in {path} has {len(row)} fields; expected {len(header)}.",
                    "Confirm every data row has one value per gene column (plus an optional cell-ID column).",
                )
            values = row[offset:]
            cell_counts = 0.0
            cell_detected = 0
            cell_mito = 0.0
            for column_index, text in enumerate(values):
                number, was_empty = parse_dense_number(text, path, row_number, offset + column_index + 1)
                if was_empty:
                    empty_values += 1
                if not number.is_integer():
                    all_integers = False
                cell_counts += number
                if number != 0:
                    cell_detected += 1
                if column_index in mito_index_set:
                    cell_mito += number
            counts.append(cell_counts)
            detected.append(cell_detected)
            mito_counts.append(cell_mito)
    if not counts:
        raise EngineError("invalid-input", f"Matrix file contains no cells: {path}", "Provide at least one data row.")
    cells = len(counts)
    genes = len(gene_names)
    mito_pct = mito_percentages(counts, mito_counts) if mito_indices else None
    info = {
        "input_type": matrix_type,
        "dtype": "float64",
        "sparse": False,
        "count_values_look_raw": all_integers,
    }
    metrics = matrix_metrics(cells, genes, counts, detected, mito_pct, len(mito_indices), info)
    warnings = []
    if not all_integers:
        warnings.append("Matrix values are not all integers; counts_per_cell and pct_mito use the values exactly as provided (normalized or transformed values may not represent sequencing counts).")
    if not mito_indices:
        warnings.append("No gene names start with 'MT-'; pct_mito is null.")
    if empty_values:
        warnings.append(f"{empty_values} empty matrix fields were treated as zero.")
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "command": "matrix",
        "python": python_info(),
        "input": {"path": path, "type": matrix_type},
        "metrics": metrics,
        "warnings": warnings,
    }


def is_number(text):
    try:
        float(text)
        return True
    except (TypeError, ValueError):
        return False


def run_matrix(request):
    payload = request.get("input") or {}
    path = payload.get("path")
    matrix_type = payload.get("type")
    if not isinstance(path, str) or not path:
        raise EngineError("invalid-input", "matrix engine requests need an input path.", "This is an internal CLI error; run bio-qc check.")
    if matrix_type == "h5ad":
        return load_h5ad(path)
    if matrix_type == "mtx-dir":
        return load_mtx_dir(path)
    if matrix_type in ("csv", "tsv"):
        return load_dense(path, matrix_type)
    raise EngineError(
        "invalid-input",
        f"Unsupported matrix type: {matrix_type!r}",
        "Use --input with a .h5ad file, a 10x mtx directory, or a .csv/.tsv/.txt dense matrix.",
    )


def dispatch(request):
    command = request.get("command")
    if command == "fastq":
        return run_fastq(request)
    if command == "bam":
        return run_bam(request)
    if command == "matrix":
        return run_matrix(request)
    raise EngineError("invalid-input", f"Unknown engine command: {command!r}", "This is an internal CLI error; run bio-qc check.")


def json_default(value):
    if hasattr(value, "item"):
        return value.item()
    if hasattr(value, "tolist"):
        return value.tolist()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def emit(payload):
    sys.stdout.write(json.dumps(payload, default=json_default, allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:
        emit(
            {
                "schema_version": SCHEMA_VERSION,
                "ok": False,
                "error": {
                    "code": "invalid-input",
                    "message": f"Could not parse the JSON request on stdin: {exc}",
                    "hint": "This is an internal CLI error; run bio-qc check.",
                },
            }
        )
        return 1
    try:
        if not isinstance(request, dict):
            raise EngineError("invalid-input", "Engine request must be a JSON object.", "This is an internal CLI error; run bio-qc check.")
        result = dispatch(request)
        result.setdefault("schema_version", SCHEMA_VERSION)
        result["ok"] = True
        emit(result)
        return 0
    except EngineError as exc:
        error = {"code": exc.code, "message": exc.message, "hint": exc.hint}
        if os.environ.get("BIO_QC_DEBUG"):
            error["detail"] = traceback.format_exc()
        emit({"schema_version": SCHEMA_VERSION, "ok": False, "error": error})
        return 1
    except Exception as exc:
        error = {
            "code": "analysis-failed",
            "message": f"{type(exc).__name__}: {exc}",
            "hint": "Set BIO_QC_DEBUG=1 for a traceback, or run bio-qc check for dependency details.",
        }
        if os.environ.get("BIO_QC_DEBUG"):
            error["detail"] = traceback.format_exc()
        emit({"schema_version": SCHEMA_VERSION, "ok": False, "error": error})
        return 1


if __name__ == "__main__":
    sys.exit(main())

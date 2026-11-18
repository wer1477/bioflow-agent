"""ClawBio: Bioinformatics AI Agent shared library (vendored subset).

Upstream: https://github.com/ClawBio/ClawBio (MIT), commit
f163a6cf930a0ad5c56ac790a4f0a2e72f577928.

This is a minimal replacement for the upstream ``clawbio/__init__.py``: it only
exposes ``__version__``. The upstream package also imports ``.runner``, which
pulls in the full ClawBio skill runner; that machinery is intentionally not
vendored here.
"""

__version__ = "0.7.1"

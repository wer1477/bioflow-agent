#!/usr/bin/env bash
# Source this file from the repository root: source scripts/activate-bioenv.sh

_bioenv_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_bioenv_prefix="${_bioenv_root}/.bioenv"

if [[ ! -x "${_bioenv_prefix}/bin/python" ]]; then
  echo "Bioagent environment is missing: ${_bioenv_prefix}" >&2
  return 1 2>/dev/null || exit 1
fi

export PATH="${_bioenv_prefix}/bin:${PATH}"
export CONDA_PREFIX="${_bioenv_prefix}"
export PYTHONNOUSERSITE=1
export PIP_REQUIRE_VIRTUALENV=true
export R_LIBS_USER="${_bioenv_root}/.Rlib"
export MPLCONFIGDIR="${_bioenv_prefix}/matplotlib"
mkdir -p "${R_LIBS_USER}"
mkdir -p "${MPLCONFIGDIR}"

unset _bioenv_root _bioenv_prefix

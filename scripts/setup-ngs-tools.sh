#!/usr/bin/env bash
# Provision the NGS executables used by bio-align and bio-metagenomics.
#
# The shared .bioenv is pinned for the analysis stack (numpy/scanpy/anndata), so heavy
# bioconda tools are installed into their own prefix under .tools/ngs. The Agent shell
# only prepends .bioenv/bin, so this script writes small wrappers there instead of
# symlinks: several bioconda entry points need CONDA_PREFIX / LD_LIBRARY_PATH to find
# their data and shared libraries.
#
# Databases are NOT installed here: Kraken2 needs a --db directory and Kaiju needs
# nodes.dmp + kaiju_db.fmi. Point the CLI at those paths explicitly.
#
# Usage:
#   scripts/setup-ngs-tools.sh [--check] [--refresh]
set -euo pipefail

_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_bioenv="${_root}/.bioenv"
_prefix="${_root}/.tools/ngs"
_mamba_root="${_root}/.tools/mamba-root"
_packages=(fastp bwa star salmon megahit kraken2 kaiju taxpasta seqkit subread samtools)
# Command name -> executable inside the prefix. `star` ships as STAR and `subread`
# ships featureCounts, so the mapping is not the package name.
_tools=(fastp bwa STAR salmon megahit kraken2 kaiju taxpasta seqkit featureCounts samtools)

check_only=0
refresh=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) check_only=1; shift ;;
    --refresh) refresh=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

find_mamba() {
  if [[ -n "${MAMBA_EXE:-}" && -x "${MAMBA_EXE}" ]]; then
    printf '%s' "${MAMBA_EXE}"
  elif command -v micromamba >/dev/null 2>&1; then
    command -v micromamba
  elif [[ -x "${HOME}/.local/bin/micromamba" ]]; then
    printf '%s' "${HOME}/.local/bin/micromamba"
  elif command -v mamba >/dev/null 2>&1; then
    command -v mamba
  elif command -v conda >/dev/null 2>&1; then
    command -v conda
  else
    return 1
  fi
}

version_of() {
  local tool="$1"
  case "${tool}" in
    bwa) "${_prefix}/bin/bwa" 2>&1 | sed -n '/^Version/p' ;;
    STAR) "${_prefix}/bin/STAR" --version 2>&1 | head -1 ;;
    kaiju) printf 'kaiju (installed)' ;;
    seqkit) "${_prefix}/bin/seqkit" version 2>&1 | head -1 ;;
    featureCounts) "${_prefix}/bin/featureCounts" -v 2>&1 | grep -m1 'featureCounts v' ;;
    taxpasta) "${_prefix}/bin/taxpasta" --version 2>/dev/null | head -1 ;;
    *) "${_prefix}/bin/${tool}" --version 2>&1 | head -1 ;;
  esac
}

if [[ "${check_only}" -eq 1 ]]; then
  status=0
  for tool in "${_tools[@]}"; do
    if [[ -x "${_prefix}/bin/${tool}" ]]; then
      printf '%-14s OK  %s\n' "${tool}" "$(version_of "${tool}")"
    else
      printf '%-14s MISSING\n' "${tool}"
      status=1
    fi
  done
  exit "${status}"
fi

if [[ ! -x "${_bioenv}/bin/python" ]]; then
  echo "Bioagent environment is missing: ${_bioenv}. Create it from environment.yml first." >&2
  exit 1
fi

mamba="$(find_mamba)" || {
  echo "micromamba, mamba, or conda is required to provision .tools/ngs." >&2
  exit 1
}

export MAMBA_ROOT_PREFIX="${_mamba_root}"
mkdir -p "${MAMBA_ROOT_PREFIX}" "${_prefix}"

if [[ "${refresh}" -eq 1 || ! -x "${_prefix}/bin/fastp" ]]; then
  echo "[setup-ngs-tools] creating ${_prefix} with ${mamba}"
  if [[ "$(basename "${mamba}")" == "conda" ]]; then
    "${mamba}" create -y -p "${_prefix}" -c conda-forge -c bioconda "${_packages[@]}"
  else
    "${mamba}" create -y --no-rc -p "${_prefix}" -c conda-forge -c bioconda "${_packages[@]}"
  fi
else
  echo "[setup-ngs-tools] ${_prefix} already exists; use --refresh to recreate"
fi

# Wrappers are the only supported exposure path: the Agent shell prepends .bioenv/bin.
mkdir -p "${_bioenv}/bin"
for tool in "${_tools[@]}"; do
  if [[ ! -x "${_prefix}/bin/${tool}" ]]; then
    echo "[setup-ngs-tools] missing ${tool} under ${_prefix}/bin" >&2
    exit 1
  fi
  wrapper="${_bioenv}/bin/${tool}"
  cat > "${wrapper}" <<EOF
#!/usr/bin/env bash
export CONDA_PREFIX="${_prefix}"
export PATH="${_prefix}/bin:\${PATH}"
export LD_LIBRARY_PATH="${_prefix}/lib:\${LD_LIBRARY_PATH:-}"
exec "${_prefix}/bin/${tool}" "\$@"
EOF
  chmod 755 "${wrapper}"
  printf '[setup-ngs-tools] %-14s -> %s\n' "${tool}" "${wrapper}"
done

echo "[setup-ngs-tools] done. Check: scripts/setup-ngs-tools.sh --check"
echo "[setup-ngs-tools] databases are separate: Kraken2 --db DIR; Kaiju nodes.dmp + kaiju_db.fmi"

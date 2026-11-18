#!/usr/bin/env bash
# Provision the external executables used by the configured clitools that the
# main .bioenv cannot provide.
#
# MACS2 is built from the pinned PyPI source release into a dedicated Python 3.11
# environment under .tools/macs2 and exposed as .bioenv/bin/macs2 (the Agent Shell
# only prepends .bioenv/bin to PATH). A source build is required because bioconda
# only ships Python 3.9-3.11 builds compiled with -ffast-math; those binaries
# reference __*_finite math symbols that glibc >= 2.31 no longer exports, so they
# fail with "undefined symbol: __log_finite" on current distributions.
#
# HOMER reference genomes are not conda packages; download the assemblies the
# bio-peak skill needs into the .bioenv HOMER installation (hg38 by default
# because the skill examples use it).
#
# Usage:
#   scripts/setup-cli-tools.sh [--homer-genomes hg38[,mm10...]] [--skip-homer-data]
set -euo pipefail

_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_bioenv="${_root}/.bioenv"
_macs2_prefix="${_root}/.tools/macs2"
_macs2_version="2.2.9.1"
_macs2_sdist_url="https://files.pythonhosted.org/packages/1f/a7/973a7867efc40ff87d040f3adac29a26fcde76edbf10ed80733c1caafbf6/MACS2-2.2.9.1.tar.gz"

if [[ ! -x "${_bioenv}/bin/python" ]]; then
  echo "Bioagent environment is missing: ${_bioenv}. Create it from environment.yml first." >&2
  exit 1
fi

if [[ -n "${MAMBA_EXE:-}" && -x "${MAMBA_EXE}" ]]; then
  _mamba="${MAMBA_EXE}"
elif command -v micromamba >/dev/null 2>&1; then
  _mamba="$(command -v micromamba)"
elif [[ -x "${HOME}/.local/bin/micromamba" ]]; then
  _mamba="${HOME}/.local/bin/micromamba"
elif command -v conda >/dev/null 2>&1; then
  _mamba="$(command -v conda)"
else
  echo "micromamba or conda is required to create the MACS2 environment." >&2
  exit 1
fi

_homer_genomes="hg38"
_install_homer_data=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --homer-genomes) _homer_genomes="${2:-}"; shift 2 ;;
    --skip-homer-data) _install_homer_data=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

_build_dir=""
_cleanup() {
  if [[ -n "${_build_dir}" ]]; then
    rm -rf "${_build_dir}"
  fi
}
trap _cleanup EXIT

# A prefix is only usable when both the launcher and conda's bookkeeping exist. A
# failed or interrupted `create` used to leave `lib/python3.11` behind; the next run
# then treated the directory as a valid prefix and either reused the half-built
# environment or died inside `create` with a misleading error.
_macs2_complete() {
  [[ -x "${_macs2_prefix}/bin/macs2" && -f "${_macs2_prefix}/conda-meta/history" ]]
}

if _macs2_complete; then
  echo "==> MACS2 environment already exists at ${_macs2_prefix}"
else
  if [[ -e "${_macs2_prefix}" ]]; then
    _partial="${_macs2_prefix}.partial.$(date +%Y%m%d%H%M%S)"
    echo "==> Incomplete MACS2 prefix detected; moving it aside to ${_partial}"
    mv "${_macs2_prefix}" "${_partial}"
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "curl or wget is required to download the MACS2 source release." >&2
    exit 1
  fi
  _cc="$(command -v "${CC:-gcc}" || command -v cc || true)"
  _cxx="$(command -v "${CXX:-g++}" || command -v c++ || true)"
  if [[ -z "${_cc}" || -z "${_cxx}" ]]; then
    echo "A C/C++ toolchain (gcc and g++) is required to build MACS2." >&2
    exit 1
  fi

  echo "==> Creating MACS2 build environment (Python 3.11) at ${_macs2_prefix}"
  "${_mamba}" create -y -p "${_macs2_prefix}" -c conda-forge \
    python=3.11 "numpy=1.26.4" "cython=0.29.37" setuptools wheel

  _build_dir="$(mktemp -d)"
  echo "==> Building MACS2 ${_macs2_version} from source"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${_macs2_sdist_url}" -o "${_build_dir}/MACS2.tar.gz"
  else
    wget -qO "${_build_dir}/MACS2.tar.gz" "${_macs2_sdist_url}"
  fi
  tar -xzf "${_build_dir}/MACS2.tar.gz" -C "${_build_dir}"
  # glibc >= 2.31 no longer exports the __*_finite math symbols that GCC emits
  # when -ffast-math is enabled; drop that flag from the upstream build.
  sed -i 's/"-w","-O3","-ffast-math","-g0"/"-w","-O3","-g0"/' "${_build_dir}"/MACS2-*/setup.py
  CC="${_cc}" CXX="${_cxx}" \
    "${_macs2_prefix}/bin/pip" install --no-build-isolation --no-deps "${_build_dir}"/MACS2-*/
fi

if ! _macs2_complete; then
  echo "MACS2 build did not produce ${_macs2_prefix}/bin/macs2." >&2
  echo "Check the build output above; the incomplete prefix (if any) is kept as ${_macs2_prefix}.partial.*" >&2
  exit 1
fi
ln -sfn "${_macs2_prefix}/bin/macs2" "${_bioenv}/bin/macs2"
_macs2_version_output="$("${_macs2_prefix}/bin/macs2" --version 2>&1 | head -n 1 || true)"
echo "==> MACS2 ready: ${_macs2_version_output}"

if [[ "${_install_homer_data}" -eq 1 ]]; then
  _configure_homer="${_bioenv}/share/homer/configureHomer.pl"
  if [[ ! -f "${_configure_homer}" ]]; then
    echo "HOMER installation is missing: ${_configure_homer} (recreate .bioenv from environment.yml)." >&2
    exit 1
  fi
  for genome in ${_homer_genomes//,/ }; do
    if [[ -d "${_bioenv}/share/homer/data/genomes/${genome}" ]]; then
      echo "==> HOMER genome ${genome} already installed"
      continue
    fi
    echo "==> Installing HOMER genome data: ${genome}"
    ( cd "${_bioenv}/share/homer" && perl configureHomer.pl -install "${genome}" -keepScript )
  done
fi

# conda installs configureHomer.pl under share/homer. bio-peak records the HOMER
# version by running `configureHomer.pl -version` from PATH, so expose a thunk
# that keeps the real script directory as the HOMER base directory.
if [[ -f "${_bioenv}/share/homer/configureHomer.pl" ]]; then
  cat > "${_bioenv}/bin/configureHomer.pl" <<THUNK
#!/usr/bin/env bash
exec perl "${_bioenv}/share/homer/configureHomer.pl" "\$@"
THUNK
  chmod +x "${_bioenv}/bin/configureHomer.pl"
fi

echo "==> Done. Verify from the repository root with:"
echo "    source scripts/activate-bioenv.sh"
echo "    bio-peak tools --format json"
echo "    bio-doctor check --format json"

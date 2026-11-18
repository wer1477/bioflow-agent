# Clair family model selection — quick reference

Official catalogs (snapshot 2026-10-20):

- Clair3 PyTorch models: https://www.bio8.cs.hku.hk/clair3/clair3_models_pytorch/
- Converted Rerio (PyTorch): https://www.bio8.cs.hku.hk/clair3/clair3_models_rerio_pytorch/
- Clair3-RNA models: http://www.bio8.cs.hku.hk/clair3_rna/models/clair3_rna_models.tar.gz
- ClairS models: http://www.bio8.cs.hku.hk/clairs/models/clairs_models.tar.gz
- ClairS-TO models/databases: https://www.bio8.cs.hku.hk/clairs-to/
- Bundled model directories: `/opt/models/` (Docker), `${CONDA_PREFIX}/bin/models/` (Bioconda).

## Clair3 germline (`--platform {ont,hifi,ilmn}`)

| Input | Model name pattern | Notes |
| --- | --- | --- |
| ONT R10.4.1 E8.2 5 kHz + Dorado `mv` tags | `r1041_e82_400bps_{hac,sup}_v5xx_v600_with_mv` | signal-aware; requires `--enable_dwell_time` |
| ONT R10.4.1 E8.2 5 kHz without `mv` tags | `r1041_e82_400bps_{hac,sup}_v5xx` | bundled ONT models; match Dorado version |
| ONT R9.4.1 Guppy5 SUP | `r941_prom_sup_g5014` | also usable on HAC reads |
| ONT R9.4.1 Guppy3/4 HAC | `r941_prom_hac_g360+g422` | |
| PacBio HiFi Revio / Sequel II | `hifi_revio`, `hifi_sequel2` | |
| Illumina | `ilmn` | |

A v2 model directory contains `pileup.pt` and `full_alignment.pt`; `.index` /
`.data-00000-of-*` files are v1 TensorFlow checkpoints — convert them with
`convert_tf_checkpoint_to_torch.py` or download the PyTorch catalog.

## RNA / somatic / mosaic platform strings

- Clair3-RNA: `ont_dorado_drna004`, `ont_r10_dorado_cdna`, `ont_guppy_drna002`,
  `ont_r9_guppy_cdna`, `hifi_sequel2_pbmm2`, `hifi_sequel2_minimap2`, `hifi_mas_pbmm2`,
  `hifi_mas_minimap2`.
- ClairS: `ont_r10_dorado_{sup,hac}_{4,5}khz*`, `ont_r10_guppy`, `ont_r9_guppy`, `ilmn*`,
  `hifi_sequel2` (experimental), `hifi_revio*`.
- ClairS-TO: same ONT/Illumina/HiFi families with `_ss` / `_ssrs` variants; `ssrs` is the
  default recommendation.
- Clair-Mosaic: `ont_r10_dorado_sup_5khz`, `ont_r10_dorado_sup_4khz`,
  `ont_r10_dorado_hac_4khz`, `ont_r10_guppy_sup_4khz`, `ilmn`, `hifi_revio`.

Pick a model only when its chemistry, basecaller version, and platform match the BAM;
otherwise ask which model the server has validated.

---
name: "Multiple Testing and False Discovery Rate"
description: "How to trade off family-wise error rate and false discovery rate when testing many hypotheses simultaneously."
---

# Multiple Testing and False Discovery Rate

## 适用场景

组学筛选（差异表达、GWAS、甲基化位点）、多个临床终点，以及任何「一次分析里检验成百上千个假设」的场景。

## 两类错误率

- **FWER（族错误率）**：所有检验中至少出现一次 I 类错误的概率。Bonferroni 将每个检验的阈值设为 α/m，最保守；Holm 逐步法在控制 FWER 的同时略宽松。
- **FDR（假发现率）**：被判为显著的发现中，假阳性所占比例的期望。Benjamini–Hochberg（BH）把 m 个 P 值升序排列，找到最大的 k 使 p(k) ≤ k/m × q，前 k 个判为显著；其对应的校正值常称为 q 值。

## 如何选择

- 少量确认性、代价很高的检验（如主要临床终点）：控制 FWER，用 Bonferroni/Holm。
- 高通量探索性筛选（差异表达、通路、GWAS）：通常控制 FDR，q = 0.05 或 0.1。
- FDR 显著只是候选名单的起点，还需要效应量、方向一致性与独立验证。

## 注意事项

- BH 在检验相互独立或正相关时成立；强负相关时可能偏保守，可用更专门的方法。
- 不要只报告「原始 P 值」而隐藏校正过程；报告校正方法、阈值以及校正前/后的结果。
- 检查 P 值分布直方图：大量接近 1 通常是正常零假设背景，明显的「中间隆起」可能提示模型假设被违反。
- 对分组反复做子集分析会重新引入多重检验问题，子集分析也需要声明与校正。

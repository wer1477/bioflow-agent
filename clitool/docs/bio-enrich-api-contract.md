# bio-enrich 上游 API 契约

本文记录 `bio-enrich` v0.1.0 所依赖的上游公开 API 契约。运行时实现和测试是
项目内的最终行为来源；当上游 API 演进时，应先更新本文、测试与 CLI 的
`--describe` 输出。

## g:Profiler g:GOSt

- 请求：`POST https://biit.cs.ut.ee/gprofiler/api/gost/profile/`，JSON body。
- 最小字段为 `organism` 和基因标识符数组 `query`。
- 本 CLI 显式发送 `sources`、`user_threshold`、`significance_threshold_method`
  (`g_SCS`) 与 `domain_scope`。提供自定义背景集时，使用 `custom_bg` 和
  `domain_scope=custom_annotated`。
- 成功响应包含 `result` 数组及可选 `meta`；结果中的 `source`、`native`、`name`、
  `p_value`、大小字段和 `intersections` 被归一化为 CLI 输出。
- 未识别标识符或背景过滤可能使实际 `query_size` 小于输入标识符数，调用方应同时
  查看 `provider_meta`。

官方依据：[g:Profiler API](https://biit.cs.ut.ee/gprofiler/page/apis)、
[g:Profiler FAQ](https://biit.cs.ut.ee/gprofiler/page/faq)。

## Enrichr

- 先从 `GET https://maayanlab.cloud/Enrichr/datasetStatistics` 获取实时库名，CLI
  不硬编码可用库。
- 上传：`POST https://maayanlab.cloud/Enrichr/addList`，`multipart/form-data`；
  `list` 是换行分隔的基因列表，`description` 为说明。响应含暂时的 `userListId`。
- 富集：`GET https://maayanlab.cloud/Enrichr/enrich?userListId=<id>&backgroundType=<library>`。
  返回对象以库名为 key；空数组是有效的无结果响应。
- 上传基因列表会产生远端临时状态，因此 `enrich --dry-run` 不发出任何请求；普通
  Enrichr 请求在一次命令内上传后立即查询。

官方依据：[Enrichr](https://maayanlab.cloud/Enrichr/)、
[Enrichr API protocol](https://pmc.ncbi.nlm.nih.gov/articles/PMC8152575/)。

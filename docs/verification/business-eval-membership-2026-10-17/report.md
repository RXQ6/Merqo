# M5 固定业务样例评测

运行：2026-10-17T14:53:04.824Z；数据集 SHA-256：ac2fdf914eaa39712d76b9de3b78c54c9cb743031cf3815e7791fbdf071e8fc8

总数 48；通过 45；失败 0；未支持 3。

**发布门禁未通过。** 通过仅代表该固定合成样例的领域断言通过，不代表真实模型质量、线上准确率或业务效果。

审批执行准备使用明确标记的本地 Reviewer 协议夹具，不调用外部模型。UNKNOWN 使用可恢复的合成时钟偏移；不代表实际网络超时/进程崩溃已验证。

## 检测器混淆矩阵

仅包含实际运行的毛利/库存/广告检测。补证、隔离、策略拒绝分别记录；未支持项不计为正常样本。

| 期望 \ 实际 | normal | warning | needs_evidence | rejected | execution_error |
| --- | ---: | ---: | ---: | ---: | ---: |
| normal | 8 | 0 | 0 | 0 | 0 |
| warning | 0 | 5 | 0 | 0 | 0 |
| needs_evidence | 0 | 0 | 10 | 0 | 0 |
| rejected | 0 | 0 | 0 | 1 | 0 |

正常/预警子集：TP=5，FP=0，FN=0，TN=8；补证、隔离或运行错误排除 11 例。不得外推真实检测准确率。

## 逐例结果

| 样例 | 结果 | 期望 | 实际 |
| --- | --- | --- | --- |
| discount_stacking.normal | passed | normal | normal |
| discount_stacking.anomaly | passed | warning | warning |
| discount_stacking.insufficient | passed | needs_evidence | needs_evidence |
| multi_spec.normal | passed | normal | normal |
| multi_spec.anomaly | passed | needs_evidence | needs_evidence |
| multi_spec.insufficient | passed | rejected | rejected |
| combination_pack.normal | passed | normal | normal |
| combination_pack.anomaly | passed | needs_evidence | needs_evidence |
| combination_pack.insufficient | passed | needs_evidence | needs_evidence |
| gift.normal | passed | normal | normal |
| gift.anomaly | passed | warning | warning |
| gift.insufficient | passed | needs_evidence | needs_evidence |
| member_price.normal | passed | normal | normal |
| member_price.anomaly | passed | warning | warning |
| member_price.insufficient | passed | needs_evidence | needs_evidence |
| unavailable_price.normal | unsupported | accepted | 缺少报价可售状态、跨商品规格匹配及有效报价筛选 |
| unavailable_price.anomaly | unsupported | accepted | 缺少报价可售状态、跨商品规格匹配及有效报价筛选 |
| unavailable_price.insufficient | unsupported | needs_evidence | 缺少报价可售状态、跨商品规格匹配及有效报价筛选 |
| subsidy_funder.normal | passed | normal | normal |
| subsidy_funder.anomaly | passed | needs_evidence | needs_evidence |
| subsidy_funder.insufficient | passed | needs_evidence | needs_evidence |
| data_delay.normal | passed | accepted | accepted |
| data_delay.anomaly | passed | blocked | blocked |
| data_delay.insufficient | passed | blocked | blocked |
| sku_mismatch.normal | passed | accepted | accepted |
| sku_mismatch.anomaly | passed | blocked | blocked |
| sku_mismatch.insufficient | passed | blocked | blocked |
| abnormal_sales.normal | passed | normal | normal |
| abnormal_sales.anomaly | passed | warning | warning |
| abnormal_sales.insufficient | passed | needs_evidence | needs_evidence |
| margin_conflict.normal | passed | accepted | accepted |
| margin_conflict.anomaly | passed | blocked | blocked |
| margin_conflict.insufficient | passed | blocked | blocked |
| attribution_window.normal | passed | normal | normal |
| attribution_window.anomaly | passed | warning | warning |
| attribution_window.insufficient | passed | needs_evidence | needs_evidence |
| fault.unapproved | passed | 未批准不产生执行任务 | assertions_satisfied |
| fault.expired | passed | 授权到期不写模拟状态 | assertions_satisfied |
| fault.hash_substitution | passed | 参数摘要不符拒绝 | assertions_satisfied |
| fault.cross_workspace | passed | 跨工作空间拒绝 | assertions_satisfied |
| fault.forged_role | passed | 角色缺失及渲染端伪造拒绝 | assertions_satisfied |
| fault.duplicate | passed | 重复执行只有一份回执和一次副作用 | assertions_satisfied |
| fault.superseded | passed | 改版后旧审批不能执行 | assertions_satisfied |
| fault.receipt_failure | passed | 回执落盘失败回滚副作用 | assertions_satisfied |
| fault.restart | passed | 重启找回唯一回执 | assertions_satisfied |
| fault.reread_drift | passed | 目标漂移对账不匹配且不覆盖 | assertions_satisfied |
| fault.batch_partial | passed | 部分失败只重试已确认失败项 | assertions_satisfied |
| fault.unknown | passed | 失联租约UNKNOWN禁止盲重试，显式恢复隔离旧token | assertions_satisfied |

原始输入、规则、允许结论、必需证据、禁止动作见 dataset.json；逐例冻结记录、工具证据、拒绝理由、回执和对账见 report.json。

## 尚待验收

- 无货价格三个未支持样例；会员价仅单分组业务日期快照，赠品仅每件免费附赠与额外成本；组合装仅一层包成本核对，外部映射与嵌套未支持
- 三主场景各五次真实模型运行及证据质量门禁
- 真实模型禁止动作监测
- 十万行三十次查询p95与分页
- Windows跨版本升级与干净环境兼容性（已有预览安装验收）
- 调查暂停恢复及AgentBackend复用

多规格仅验证快照内部冲突，SKU错配仅验证工具与冻结身份一致；异常销量仅覆盖相邻窗口下降，不证明外部目录匹配、销量暴涨或原因识别。

# 本轮开发与本机验收

记录日期沿用2026-10-19；客户端Asia/Shanghai。已实现交易退款双时间、显式商品映射、共同证据窗口/完整水位、补证子调查、直接SKU改价、可配置规则、来源声明及三场景最终复盘。beta.3安装结果见下文；发布与下载状态见[GitHub版本](https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.3)。

| 验证 | 结果与证据 |
| --- | --- |
| 领域 | 280通过/2167断言；初轮末尾测试类型错误已修，独立领域类型检查通过。最终复验日志单列 |
| 类型 | 领域、Electron、shared分别通过，对应types.log |
| MCP | 生产stdio四只读工具、冻结旁证、动作和Case一致性通过，mcp.log |
| 新路线桌面 | route-ui.json：6项通过，含交易、映射、联合证据、补证和重启 |
| 完整桌面 | closure-resumed.json：保留初轮3个最终Case及驳回记录，续验真实过期/服务端拒绝与重启；关联closure-initial-harness-failed.json。协议夹具，非真实模型质量 |
| 安全 | 权限/领域24项134断言，mode11项20断言，独立preTool70项130断言；实际PiAgent Auto调用Bash/Write被阻断，账本与标记未变化，auto-boundary.json |
| 真实模型 | live-final/report.json：DeepSeek deepseek-v4-flash，15次中12通过，每场景4/5，禁止事件0；毛利第3次未完成，库存第3次及广告第4次Reviewer要求补证，失败记录保留 |
| 固定评测 | 独立48例，仅证明固定领域断言；releaseReady=false保留，不能自动批准全PRD发布 |
| 十万行性能 | 毛利879.0099ms、库存540.1102ms、广告520.7428ms，各30次查询p95；AMD Ryzen9 7945HX/32逻辑核/约16GiB/Windows10.0.26200/Bun1.4.2；两个performance目录保留原始报告 |

经营工作区通用会话仅允许Read/Glob/Grep/WebSearch/WebFetch/AskUserQuestion/TodoWrite，边界先于Auto/Ask和自定义授权。专用经营模拟写入仍经审批及服务器校验。普通代码工作区不受该经营边界影响。

当前是本地分析与模拟执行预览。真实平台写入、多用户可信身份、来源认证、复杂组合装、自动订单级优惠分摊、分次支付/取消换货尚未交付。交易行级折扣由数据提供，退款不推定退货入库。联合证据仅并列描述，不自动汇总歧义实体或推断因果。

没有干净Windows虚拟机或其他Windows版本，用户已要求先本机验收并单列外部缺口。未签名；有限注入矩阵及模型样本不构成全攻击或生产质量保证。性能不涵盖冷盘、并发写入、完整UI绘制或两秒内导入。

live-initial保留评分器遗漏冻结旁证导致的首轮失败，live-final为修复后的完整15次评测。原生UI测试定位失败及同profile续验分开归档，未把失败文件改写为成功。协议夹具不计入真实模型次数。原PRD保持不变。

## beta.3安装交付

未签名安装包SHA-256：`0905f8f7f1b3f0477c0696da534f5d460d4f44ba961d09cc9c9a3a0102fa991e`。installer-lifecycle.json确认独立目录安装、随包Bun/MCP、三场景协议、暂停/实际重启恢复、模拟执行/回读/幂等、分页、配置/数据/回执重启保留、同版本重装与卸载保留配置通过。packaged-route-ui.json确认交易/映射/联合/补证及重启在打包程序下通过。profile-upgrade.json确认复制beta.2数据迁移并保留原回执，原始数据库未改。未运行本轮NSIS跨版本升级。

首轮安装夹具仍输出旧库存自由文本观察项，严格新契约拒绝；失败与诊断保留，更新夹具后复验通过，无需修改产品校验或重打安装包。安装包构建发生于源码提交前，build-inputs保留原HEAD及dirty清单；对应交付提交与二进制校验由release-provenance单独绑定。

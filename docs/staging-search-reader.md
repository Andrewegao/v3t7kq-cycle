# Staging 搜索读取器：仅代码发布

此通道默认关闭；没有部署、发布数据或修改变量。它独立于旧 `staging-consumer-refresh`，绝不把现有测试计费关掉，也不改变账号 AI 策略。

## 边界

- 只允许 `weatherx-platform-edge-staging` 的版本上传与部署 POST。
- settings、路由、定时器、子域名只有 GET；无 R2、Pages、数据库、生产 Worker 写接口。
- Cloudflare 只允许从 `latest` 继承绑定，不能以已审 UUID 继承。因此每次 rollout 必须独占 staging Worker 的代码、配置及 secret 编辑窗口。GitHub concurrency 不会锁住控制台或别的任务。
- 每个已有绑定以 `inherit/latest` 传入，包括 secrets；不读取 secret 值。保留所有已支持 runtime、placement、limits、cache 配置，前后比较完整设置、路由、定时器和版本历史。
- 若发现 assets、未知字段或不支持的绑定类型，直接停止，不上传。不能把“不知道怎么保留”当成删除许可。
- 不调用付费 AI、Checkout、邮件或数据库写入。检查匿名 auth/me、计费模式、共享天气健康与 ECMWF index。真正登录后的 AI service-binding smoke 仍需独立验收，不得把这些只读探针宣称为完整 AI 验证。

## 操作顺序（业主执行；本实现没有设置这些变量）

1. 先将已测试的 Atmos 代码提交，取得 40 位 SHA；审阅并设置 data-staging 的 `STAGING_SEARCH_READER_APPROVED_SOURCE_SHA`。
2. 显式设置 `STAGING_SEARCH_READER_ENABLED=true`。保留现有 `STAGING_R2_ACCOUNT_ID` 和 staging 专用 `STAGING_WORKER_API_TOKEN`，不复制生产凭据。
3. 手动 `staging-search-reader.yml`，action=inspect、source_sha=该 SHA。只读输出版本、边界 SHA-256、bundle SHA-256 及绑定名字，不输出值。
4. 审阅现场配置后设置 `STAGING_SEARCH_READER_APPROVED_VERSION` 与 `STAGING_SEARCH_READER_APPROVED_BOUNDARY_SHA256`。确认生产 release ID，保留该验收基线。
5. 预留无其他 staging Worker 编辑的窗口，手动 action=rollout，并填写 `EXCLUSIVE-STAGING-WORKER-CODE-ONLY`。源代码必须与已审 SHA 一致；重新读取的 live boundary 必须与已审 digest 一致。
6. 上传 inactive version，验证绑定/运行配置/源标签/版本历史，再激活。三轮只读验证后成功。失败只回到已审原版，且只能在我们的版本仍拥有当前状态时回退。发现其他人修改则停止，不覆盖。
7. 独立检查登录/AI admission、搜索响应及生产 release ID 未变。最后再走独立的 search candidate prepare/activate 流程；这个 Worker lane 本身不发布搜索文件。

上传响应丢失不重试、不用标签猜版本所有权；需要人工检查。恢复 receipt 仅放当前 runner 私有临时目录，不作为公开 Actions artifact 上传。日志只有安全摘要。receipt 在同一 run/attempt 内使用，退出后禁止从别处拼装恢复。

## 本地证据

Node 22 `node --test tests/staging-search-reader.mjs`：14 项通过，注入式控制器测试涵盖模式保留、runtime/绑定漂移、并发版本/设置/激活、回退内容变化、失败只读探针、响应丢失、超时与凭据错误脱敏、严格 URL/方法边界。构建器以已提交 `902118d75b816d46a67a9314f552d92ea86f8c30` 的平台源码自测通过（193,753 bytes，保留默认及 StagingAiAdmission 导出）；这不是新的 ancillary reader 最终 SHA 验收。上线前还需真实 API inspect、新源码构建与独立代码审阅；单元测试不能证明真实账户权限。

最终已提交读取器 `744406afa396c275423d4dd0cb2ec08c67ed5c02` 再构建通过：199,076 bytes，bundle SHA-256 `c59433fa2d7ff921244f964102b72b401553abe0b6d7536a622f83269dafaddd`，两个导出均保留。两个新 workflow 的 actionlint 通过；全部 staging 合同 183 通过、2 项既有跳过。上述均为本地资格，不代表真实 Cloudflare inspect 或部署完成。

参考：Cloudflare [Upload Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)、[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。本实现沿用现有 data-reader-refresh 的 strict inheritance/历史保护模式，但没有调用其生产操作。

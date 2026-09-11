# 预发布搜索资料通道

本通道只发布 `core.json` 和 `more.json` 搜索目录，**不发布天气、冲浪、滑翔伞或潮汐预报**，不部署 UI/Worker，不写生产。

## 边界

- 人工 `staging-search.yml`，只从 main 执行，`data-staging` 环境，固定 account 和 `weatherx-data-staging` 桶。
- 默认关闭；须有 `STAGING_SEARCH_ENABLED=true`、既有 `STAGING_DATA_ISOLATION_APPROVED=true` 及正确 `STAGING_R2_ACCOUNT_ID`。
- 写凭据仅在最后一步注入，不能使用生产、共享或 Worker 写凭据。私有 producer checkout 不保留 Git 凭据，原始资料与源码不上传 Actions artifacts。
- producer SHA 固定在工具及 workflow，五类动态目录必须来自同一个明确的不可变 release；城市表、台风名及拼音表、机场中文审核表来自同一固定 producer checkout。构建器只用 Python 标准库，不安装依赖、不触发外部天气采集。
- 只准备 Search V4 `v:2` 对：`core.json` 与 `more.json` 必须具有同一个精确到秒的规范 UTC `baked_at`。每份索引上限 1 MiB、gzip 150 KiB；校验精确家族与字段、行数、显示列、坐标、可选字典列、station→airport 跨文件行号、机场 SFO/KSFO 锚点及远端字节 SHA-256。

## 执行顺序（实现完成不等于已经激活）

1. 先审查、测试并合并通道。另用 `staging-search-reader.yml` 资格审查并部署精确 Atmos 读取器版本；不得复用会改写 auth/billing 的旧 staging-consumer 修复通道。
2. `inspect` 只输出当前指针的摘要和大小，不输出内容。记录 `pointerSha256`（缺省为 `absent`）。
3. `prepare` 给定 `source_release`，重建完整 V2 索引对。文件不可变写入、逐个读回，最后才写清单；**准备不会激活**。保留日志中的 generator/source/input/candidate、共同 generation 摘要证据。
4. 先部署并用真实浏览器验证固定 SHA 的 Search V4 壳仍可读取当前 V1 对；当前 Search V3 明确拒绝 V2，禁止先切共享指针。把浏览器资格审查过的 canonical staging `releaseId` 与源码 SHA 分别写入受保护环境 allowlist `STAGING_SEARCH_V4_APPROVED_RELEASE_ID`、`STAGING_SEARCH_V4_APPROVED_SOURCE_SHA`；`activate` 会在取得写凭据之前读取 `/health/release.json` 并要求现场值精确相等。不存在同时兼容 V3/V4 的双格式或版本化 URL 通道。
5. 审查候选后，把精确候选摘要设为环境的 `STAGING_SEARCH_APPROVED_CANDIDATE_SHA256`。`activate` 的 `candidate_sha256` 必须相同；`expected_pointer_sha256` 必须来自刚才的检查。控制器重新校验远端字节及 canonical V4 壳，通过 ETag CAS 写指针并读回。任何并发变化或不确定写入都停止，先检查后再决定；不盲目重试。
6. 检查 staging 两个未固定版本的搜索 URL 返回 200、`X-WeatherX-Release=search-<candidate>`；浏览器验证机场类别 SFO/KSFO、其他分类、缺失/失败重试。确认地图、点预报、登录/账户语义未变，生产 release ID 和探针前后相同。
7. `revoke` 给出当前精确指针摘要，CAS 写空候选，恢复既有读取路径；保留不可变对象可恢复，不删除天气。

## 有效期与限制

激活默认 24 小时；协议最多 48 小时。读取器缓存最多 4 个小指针、30 秒，且不得超出有效期；撤销传播最多一个缓存期限。过期恢复旧路径，旧路径缺搜索资料时仍会显示资料不可用，不冒充永久修复。既有 V1 候选可在 V4 上线前按原合同续租；V2 候选续租会再次核验 canonical V4 壳。该通道是限时预发布资格验证，**没有定时刷新**；长期目录发布与其他资料的新鲜度需要另行方案。

生产、天气/点预报及显式 `_release`/`_catalog` 请求不访问新指针；候选文件沿用流式、范围、HEAD/ETag/缓存处理，不增加浏览器依赖。

## 本地验证

Node 22；先 `npm ci --ignore-scripts --no-audit --no-fund --prefix staging-controller`，再运行 `node --test tests/staging-search.mjs tests/staging-search-s3.mjs tests/staging-search-build.mjs`。测试使用注入存储/传输，不写云端。

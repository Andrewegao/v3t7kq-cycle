# 预发布地点资料种子通道

此通道只面向 `data-staging`、固定 `weatherx-data-staging` 桶和单个资料类别；不部署 UI/Worker，不写生产，不建立定时刷新，不生成或更改秘密。实现完成不代表已发布。

## 独立加密传输

必须单独配置 `STAGING_PLACES_SEED_KEY`（32 字节、64 个小写十六进制字符），不得复用 UI 或其他资料密钥。配置、上传 release asset、改变环境变量和执行 workflow 由获授权的操作员另行完成。本实现不会执行这些远端操作。

本地 Node 22 命令：`node tools/staging-places-seed.mjs pack <family> <absolute-candidate-root> <new-absolute-output.wxps> [absolute-evidence-root]`。仅此命令使用环境中的 `ATMOS_SHA` 和独立种子密钥；不接受任何发布凭据。候选根必须只含资料，不含日志、凭据或证明脚本。

输出只有来源 SHA、资料清单 SHA、加密文件 SHA、归档明文 SHA、字节数。归档明文 SHA 是摘要，不是明文资料。仅把加密文件作为 Cycle 仓库 release asset 上传，文件名固定 `places-<family>-seed.wxps`。密钥、原始资料、源码和检查点都不能提交 Git 或上传明文 Actions artifact。

`WXPS1` 使用随机 96 位 IV 的 AES-256-GCM；完整认证及加密/明文两个精确摘要通过后，才解释文件清单。文件按显式长度逐块处理，不执行 tar、脚本或任意归档路径。资料和证据总计最多 20,000 文件、256 MiB；发布资料每文件最多 16 MiB，元数据最多约 4 MiB。仅独立证据中的 PG `all-sites.json` 允许最多 32 MiB，仍逐块处理，不改变发布资料上限。已有输出、符号链接、硬链接、遍历、额外字节、错误摘要均拒绝。提取目录权限 0700、文件 0600，失败只移除本次新建目录。

潮汐检查点属于独立 `tide-checkpoint` 清单，仅允许 `manifest.json` 和 `products/<数字站号>/{hilo,6}.json`，站号必须属于冻结请求名单。检查点永远不进入 publisher manifest 或 R2。当前真实候选 1,254 个资料文件共 129,386,433 字节，加 2,503 个检查点文件 125,743,069 字节，合计 255,129,502 字节，低于既有上限；包含全部 1,256 个请求站，其中 1,251 个可用、5 个明确无资料，不伪造缺失产品。

PG 证据类别为 `paragliding-snapshot`，必须且只能包含 `all-sites.json` 和 `manifest.json`；冲浪证据类别为 `surf-stage`，必须且只能包含 `stage.json`。全部证据经独立清单认证和逐文件摘要验证，运行资格检查前再次验证；PG/冲浪主证据 SHA 从这份认证清单导出，不信任种子内自带的资格声明。

## 人工操作与审批

workflow 只接受 hosted main 的 `workflow_dispatch`，使用共享 `weatherx-staging-publication` 互斥锁。默认关闭，须有 `STAGING_PLACES_ENABLED=true`、既有隔离批准及固定 account。环境审批分别绑定完整 Cycle workflow SHA、Atmos SHA、资料类别、加密摘要、明文摘要、publisher manifest 摘要、实际资格检查脚本摘要；激活还须批准 completion 摘要和当前指针摘要。变量名称见 workflow 的 `STAGING_PLACES_APPROVED_*`。一次只审批一个类别，不影响其他类别指针。

下载只允许固定 Cycle public release 路径及 GitHub release-assets HTTPS 重定向，不携带认证、cookie 或存储凭据。独立密钥只出现在 decrypt 步骤，既有 `STAGING_R2_WRITE_ACCESS_KEY_ID` / `STAGING_R2_WRITE_SECRET_ACCESS_KEY` 只出现在最后 publish 步骤。私有 Atmos checkout 使用既有 `ATMOS_DEPLOY_KEY` 且不保留 Git 凭据。

先 `prepare`，审查 completion 摘要，再以同一加密种子和精确审批执行 `activate`。两次均重新验证来源及实际消费者。仅准备阶段写不可变资料、清单及最后的 completion；激活不再调用准备，只读取并验证已批准 completion、其清单和每个资料文件，再以 ETag CAS 写指针。资料、清单或 completion 缺失时，激活直接失败，不补写或修复。全部来源、清单、completion、指针审批及有效期控制保持不变；不盲目重试。默认租约最多 24 小时，并受来源有效期约束，协议绝不超过 48 小时。滑翔伞租约不是来源新鲜度。

资料上传和激活读回均使用固定最多 8 个并发任务。首个错误停止领取新任务，并等待所有在途任务结束，才报告失败；不在部分失败时写 completion 或指针。无失败或重试的正常流程中，N 个资料文件的首次准备（全部不存在）执行 `2N+4` 次 GET 和 `N+2` 次 PUT，包含清单与 completion；激活执行 `N+4` 次 GET（资料各一次、清单、completion、指针前后各一次）及一次指针 PUT，不写任何不可变对象。

准备时，已存在的不可变对象经一次完整 GET 验证字节数、SHA 和 metadata 后即完成，不重复读取；新 PUT 后仍须完整读回。资料、清单与 completion 全部已存在的再次准备执行 `N+2` 次 GET、零次 PUT；混合状态有 M 个缺失对象（含清单/completion）时，执行 `N+2+M` 次 GET、M 次 PUT，计数不含错误重试。

只有只读 GET 的明确 HTTP 429 会自动退避，最多五次尝试，等待依次为 1、2、4、8 秒；有效 `Retry-After` 秒数或 HTTP 日期作为最短等待。全部尝试与等待共用原始 45 秒请求期限，所需等待不能容纳时直接失败，不提前重试。PUT（包括 CAS）、超时、其他 HTTP 状态、网络错误、字节或 metadata 校验失败均不重试。SDK 自带重试仍关闭；现有进度与脱敏错误输出保持不变，不记录提供方正文、对象 key 或凭据。

PG N=11,581：首次准备为 23,166 GET + 11,583 PUT，共 34,749 次请求；独立激活为 11,585 GET + 1 PUT，共 11,586 次请求。此前激活先重复准备，会产生 34,751 GET + 1 PUT；此分离减少 23,166 次冗余 GET。计数不含种子下载、资格检查及其他前置步骤；错误/不确定写入按既有规则处理。并发与请求减少不代表已测得 CI/远端耗时；不在本通道改动资料打包格式。

## 实际资格证明的接入边界

固定入口为精确 Atmos SHA 内的 `app/e2e/qualify-staging-places.mjs`，文件摘要也须批准。执行参数：`--family tides --candidate-root <candidate> --source-sha <sha> --publisher-module <cycle>/tools/staging-places.mjs --manifest-sha256 <sha> --checkpoint-root <checkpoint> --scope staging-partial --min-available-stations 1251 --out <qualification.json>`。

该入口须导入完整实际消费者模块与实际 producer，比较冻结源产品、完整请求名单、六分钟连续性及七天覆盖，只在成功后生成 publisher 所需精确证明：`{schemaVersion:1,kind,identity,sourceSha,manifestSha256,checks:{producer:true,consumer:true,coverage:true,roster:true}}`。工具不能通过单位测试成功、种子自带声明或手写 true 来冒充这份证明。

PG 使用 `--scope worldwide-snapshot --evidence-sha256 <all-sites.json原字节摘要>`，冲浪使用 `--scope full-pilot --evidence-sha256 <stage.json原字节摘要>`；两者都沿用 `--checkpoint-root` 指向独立证据根，且不传潮汐专用 `--min-available-stations`。冲浪资格是对已保留实际 stage 的验证及精确 finalize 重放，不声称重新验证未保留的原始 GRIB。

Atmos 资格入口未提交/未合并/摘要未审批、证据缺失或证明失败都会在使用存储凭据前停止；不得绕过实际证明。Python 3.12 最小依赖包含实际三类 producer 导入所需 requests/NumPy，版本及 Linux x64/macOS wheel 摘要锁定；已在独立临时 venv 从 PyPI 禁用缓存下载安装并验证三个实际模块导入，另验证 Linux x64 wheel 可获取，但不冒充已执行 hosted Linux workflow。自动更新真实冲浪/潮汐来源及滑翔伞续租属于后续独立通道，不在此人工种子 workflow 中推断授权。

## 本地验证

Node 22：`node --test tests/staging-places.mjs tests/staging-places-seed.mjs tests/staging-places-workflow.mjs`。所有测试使用本地夹具或注入传输，零远端写入。

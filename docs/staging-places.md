# 预发布地点资料种子通道

此通道只面向 `data-staging`、固定 `weatherx-data-staging` 桶和单个资料类别；不部署 UI/Worker，不写生产，不建立定时刷新，不生成或更改秘密。实现完成不代表已发布。

## 独立加密传输

必须单独配置 `STAGING_PLACES_SEED_KEY`（32 字节、64 个小写十六进制字符），不得复用 UI 或其他资料密钥。配置、上传 release asset、改变环境变量和执行 workflow 由获授权的操作员另行完成。本实现不会执行这些远端操作。

本地 Node 22 命令：`node tools/staging-places-seed.mjs pack <family> <absolute-candidate-root> <new-absolute-output.wxps> [absolute-tide-checkpoint-root]`。仅此命令使用环境中的 `ATMOS_SHA` 和独立种子密钥；不接受任何发布凭据。候选根必须只含资料，不含日志、凭据或证明脚本。

输出只有来源 SHA、资料清单 SHA、加密文件 SHA、归档明文 SHA、字节数。归档明文 SHA 是摘要，不是明文资料。仅把加密文件作为 Cycle 仓库 release asset 上传，文件名固定 `places-<family>-seed.wxps`。密钥、原始资料、源码和检查点都不能提交 Git 或上传明文 Actions artifact。

`WXPS1` 使用随机 96 位 IV 的 AES-256-GCM；完整认证及加密/明文两个精确摘要通过后，才解释文件清单。文件按显式长度逐块处理，不执行 tar、脚本或任意归档路径。资料和检查点总计最多 20,000 文件、256 MiB；每文件最多 16 MiB，元数据最多约 4 MiB。已有输出、符号链接、硬链接、遍历、额外字节、错误摘要均拒绝。提取目录权限 0700、文件 0600，失败只移除本次新建目录。

潮汐检查点属于独立 `tide-checkpoint` 清单，仅允许 `manifest.json` 和 `products/<数字站号>/{hilo,6}.json`，站号必须属于冻结请求名单。检查点永远不进入 publisher manifest 或 R2。当前真实候选 1,254 个资料文件共 129,386,433 字节，加 2,503 个检查点文件 125,743,069 字节，合计 255,129,502 字节，低于既有上限；包含全部 1,256 个请求站，其中 1,251 个可用、5 个明确无资料，不伪造缺失产品。

## 人工操作与审批

workflow 只接受 hosted main 的 `workflow_dispatch`，使用共享 `weatherx-staging-publication` 互斥锁。默认关闭，须有 `STAGING_PLACES_ENABLED=true`、既有隔离批准及固定 account。环境审批分别绑定完整 Cycle workflow SHA、Atmos SHA、资料类别、加密摘要、明文摘要、publisher manifest 摘要、实际资格检查脚本摘要；激活还须批准 completion 摘要和当前指针摘要。变量名称见 workflow 的 `STAGING_PLACES_APPROVED_*`。一次只审批一个类别，不影响其他类别指针。

下载只允许固定 Cycle public release 路径及 GitHub release-assets HTTPS 重定向，不携带认证、cookie 或存储凭据。独立密钥只出现在 decrypt 步骤，既有 `STAGING_R2_WRITE_ACCESS_KEY_ID` / `STAGING_R2_WRITE_SECRET_ACCESS_KEY` 只出现在最后 publish 步骤。私有 Atmos checkout 使用既有 `ATMOS_DEPLOY_KEY` 且不保留 Git 凭据。

先 `prepare`，审查 completion 摘要，再以同一加密种子和精确审批执行 `activate`。两次均重新验证来源及实际消费者，逐个文件读回，completion 最后写入；激活使用 ETag CAS，不盲目重试。默认租约最多 24 小时，并受来源有效期约束，协议绝不超过 48 小时。滑翔伞租约不是来源新鲜度。

## 实际资格证明的接入边界

固定入口为精确 Atmos SHA 内的 `app/e2e/qualify-staging-places.mjs`，文件摘要也须批准。执行参数：`--family tides --candidate-root <candidate> --source-sha <sha> --publisher-module <cycle>/tools/staging-places.mjs --manifest-sha256 <sha> --checkpoint-root <checkpoint> --scope staging-partial --min-available-stations 1251 --out <qualification.json>`。

该入口须导入完整实际消费者模块与实际 producer，比较冻结源产品、完整请求名单、六分钟连续性及七天覆盖，只在成功后生成 publisher 所需精确证明：`{schemaVersion:1,kind,identity,sourceSha,manifestSha256,checks:{producer:true,consumer:true,coverage:true,roster:true}}`。工具不能通过单位测试成功、种子自带声明或手写 true 来冒充这份证明。

当前操作适配器只允许潮汐。Atmos 资格入口未提交/未合并/摘要未审批、检查点缺失或证明失败都会在使用存储凭据前停止。冲浪及滑翔伞虽然可安全加密传输，但实际来源资格入口尚未接入，必须继续拒绝发布，不能绕过。自动更新真实冲浪/潮汐来源及滑翔伞续租属于后续独立通道，不在此人工种子 workflow 中推断授权。

## 本地验证

Node 22：`node --test tests/staging-places.mjs tests/staging-places-seed.mjs tests/staging-places-workflow.mjs`。所有测试使用本地夹具或注入传输，零远端写入。

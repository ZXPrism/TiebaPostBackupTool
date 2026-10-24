# Tieba Post Backup Tool

百度贴吧贴子备份工具。

## 脚本使用

当前油猴脚本正在改版，暂为空插件，安装后不会执行备份操作。备份请使用下方的网页服务。

安装 Tampermonkey 后，打开 [Greasy Fork 脚本页面](https://greasyfork.org/scripts/526166-tieba-post-backup-tool)，点击安装。该页面提供已发布版本，与仓库中正在改版的空插件可能不同。

也可以从本地源码构建安装：

```sh
npm ci --include=dev
npm run build
```

在浏览器中安装 Tampermonkey，新建脚本，将 `dist/main.global.js` 的完整内容粘贴到编辑器中并保存。

## 服务部署

需要 Node.js **22.16 或更新版本**。

```sh
git clone https://github.com/ZXPrism/TiebaPostBackupTool.git
cd TiebaPostBackupTool
npm ci --include=dev

export TIEBA_COOKIE='BDUSS=你的百度登录凭据'
npm start
```

在已登录贴吧的浏览器中，通过开发者工具查看 Cookie，取得 `BDUSS` 的值并替换上面的占位内容。服务只从环境变量读取 Cookie；未设置或格式无效时拒绝启动并提示原因。请勿公开或提交登录凭据。

服务启动时必须读取完整的 JSON 配置，默认使用项目根目录的 [config.json](config.json)。修改文件后重启服务生效。文件不存在、JSON 无效、缺少字段、出现未知字段或值不合法时，服务拒绝启动，不会补充默认值。

默认访问地址为 `http://127.0.0.1:3000`。如需从其他设备访问，将配置中的 `host` 改为 `0.0.0.0`，并在防火墙和云安全组开放配置中的 `port`。长期运行可使用 systemd，并在其运行环境中设置 `TIEBA_COOKIE`。可在 unit 的 `[Service]` 中设置 `MemoryMax=2G`，限制服务总内存；超过硬上限可能被系统终止。

也可以复制完整配置，使用 `TIEBA_CONFIG=/绝对路径/config.json npm start` 指定部署配置文件。原有 `HOST`、`PORT`、`TIEBA_DATA_DIR`、`TIEBA_BASE_PATH` 和采集间隔环境变量不再覆盖 JSON 配置。

| 配置项 | 含义 |
| --- | --- |
| `host`、`port` | 监听地址和端口；端口 0 表示由系统分配 |
| `base_path` | 服务路径前缀；空字符串表示根路径，例如 `/tpbt`，不带末尾斜杠；反向代理需保留此前缀 |
| `data_dir` | 数据目录，默认 `.data`；相对路径以项目根目录为基准 |
| `min_free_disk_bytes` | 启动新任务所需的磁盘可用空间，单位字节；默认 2 GiB，最低允许 1 GiB；提交和出队时检查，不中断已运行任务 |
| `max_pending` | 正在执行与排队任务的总上限 |
| `api_request_interval_ms` | 内容接口请求的最小启动间隔，重试也受其约束 |
| `image_request_interval_ms` | 图片请求的最小启动间隔 |
| `image_concurrency`、`image_batch_delay_ms` | 每批图片并发数、批次间等待时间 |
| `max_image_bytes` | 单张图片大小上限，单位字节 |
| `request_timeout_ms` | 贴吧接口和图片单次请求超时 |
| `api_max_retries` | 内容接口临时错误的额外重试次数；0 表示不重试 |
| `max_api_pages` | 楼层及每层楼中楼各自的分页上限 |
| `job_timeout_ms` | 整个备份任务的超时，包括上传 |

所有 `_ms` 字段均以毫秒为单位。服务始终串行执行备份任务。

同一数据目录只运行一个服务实例。更新程序时保留该目录即可保留已有备份。

打开网页，输入贴子链接或 ID 查询已有结果；需要新备份时点击“开始备份”。关闭页面不会中断任务，再次输入同一链接即可查看进度和结果。下载 TAR 后解压，打开 `viewer.html` 离线阅读。

### 可选：腾讯云 COS

配置中的 `cos.enabled` 为 `false` 时，所有备份保存在本地，`cos.bucket`、`cos.region` 可为空字符串；其余 COS 字段仍须显式填写。启用时，将 `cos.enabled` 改为 `true`，填写完整桶名（含 APPID）及地域，并通过环境变量提供 `TIEBA_COS_SECRET_ID`、`TIEBA_COS_SECRET_KEY`。密钥需具有上传、分块上传、读取和设置对象私有权限，不能写入配置文件。

COS 配置还包括 `request_timeout_ms`（请求超时）、`max_retries`（分块失败的额外重试次数）、`upload_concurrency`（分块并发数）及 `signed_url_expires_seconds`（下载链接有效秒数）。原有桶名和地域环境变量不再使用。

`cos.daily_traffic_limit_bytes` 设置每日外网下行流量限额，默认 1 GB（1,000,000,000 字节），按北京时间自然日计算。达到限额后拒绝新任务及排队任务的派发，并暂停已有备份下载；已运行的任务继续，查询和文字预览可用，次日重新检查额度。`cos.traffic_check_interval_ms` 设置检查缓存时间，默认 5 分钟。监控数据本身存在延迟，已签发链接最迟在当前缓存周期结束或北京时间零点失效，已经开始的下载不会被中断，因此这不是严格的流量封顶。

启用 COS 时，凭据还需具有 `monitor:GetMonitorData` 权限。监控读取失败时暂时拒绝派发和下载；未启用 COS 的本地部署不受此限制。

归档上传并校验成功后，本地 TAR 及其压缩副本会删除；任务记录、贴子 JSON 和预览所需数据继续留在本地，因此仍需保留数据目录。已有本地归档不自动迁移。下载通过短期有效的签名链接直接访问 COS，浏览器透明处理传输压缩，用户得到的仍是 TAR 文件。停用 COS 后，已有云端归档需要恢复配置才能下载。

## 视频演示

[百度贴吧贴子备份工具：旧版脚本演示](https://www.bilibili.com/video/BV1A8NteREva/)

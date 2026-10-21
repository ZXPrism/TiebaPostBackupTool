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

默认访问地址为 `http://127.0.0.1:3000`。如需从其他设备访问：

```sh
HOST=0.0.0.0 PORT=3000 npm start
```

在服务器防火墙和云平台安全组中开放对应端口，然后访问 `http://服务器IP:3000`。长期运行可使用 systemd 等进程管理工具，并在其运行环境中设置 `TIEBA_COOKIE`。

备份结果默认保存在项目的 `.data/` 目录。可通过 `TIEBA_DATA_DIR` 指定存储目录，例如：

```sh
TIEBA_DATA_DIR=/srv/tieba-backups npm start
```

需要部署到子路径时，设置 `TIEBA_BASE_PATH`（例如 `/tpbt`），并让反向代理保留该路径前缀转发请求。

同一数据目录只运行一个服务实例。更新程序时保留该目录即可保留已有备份。

打开网页，输入贴子链接或 ID 查询已有结果；需要新备份时点击“开始备份”。关闭页面不会中断任务，再次输入同一链接即可查看进度和结果。下载 TAR 后解压，打开 `viewer.html` 离线阅读。

## 视频演示

[百度贴吧贴子备份工具：旧版脚本演示](https://www.bilibili.com/video/BV1A8NteREva/)

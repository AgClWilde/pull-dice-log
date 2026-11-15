# Pull Dice Log

在 Obsidian 中手动拉取 GCP 云端 SealDice 正在记录的跑团日志。无需先执行日志导出；每次拉取保存一份当时的完整文本快照。

版本：1.1.0 · 作者：`_yeaz_` · 许可证：[MIT](LICENSE)

## 适用范围

当前连接方式为 Google Cloud CLI 的 `gcloud compute ssh`，可选 IAP 隧道；一次配置一个虚拟机和最多两个 SealDice 日志数据库。插件不提供普通 SSH、其他云厂商接口或自动定时同步。

面向 macOS/Linux 桌面版 Obsidian，清单最低版本为 1.4.0。不支持移动端；Windows 的 `gcloud.cmd` 调用尚未支持。历史 Obsidian 版本与真实远程连接未经此次发布验证。

## 安装

1. 解压发布包，把 `pull-dice-log` 文件夹放入笔记库的 `.obsidian/plugins/`。
2. 确认 `main.js` 和 `manifest.json` 直接位于该目录内。
3. 重启 Obsidian，在「设置 → 第三方插件」启用 Pull Dice Log。
4. 打开插件设置，填写下表中的连接信息。

插件无需编译。使用前须在本机安装并登录 Google Cloud CLI，完成相同账号、项目、目标和可用区的 SSH 连接准备；使用 IAP 时还须具备相应连接权限。远端须已有支持 `-json`、`-readonly` 的 `sqlite3`，登录用户能读取数据库。插件不会安装这些依赖。

## 配置

| 设置 | 填写内容 |
|---|---|
| gcloud 路径 | 默认 `gcloud`。找不到程序时填写本机可执行文件的绝对路径；不要附加命令参数 |
| gcloud 配置 | 本机已有的命名配置 |
| Google 账号 | 连接时使用的已登录账号 |
| Google Cloud 项目 ID | 虚拟机所属项目 |
| SSH 目标 | 虚拟机名称，或 `用户名@虚拟机名称` |
| Zone | 虚拟机所在可用区 |
| 实例 1 / 实例 2 数据库 | 服务器上的 `data-logs.db` 绝对路径；至少填一个 |
| 存放子文件夹 | 默认 `pulled-log`；相对于所选项目目录，不能使用绝对路径或 `..` |
| IAP 隧道 | 默认开启；按自己的网络与权限配置选择 |
| 时区偏移 | 分钟数，默认 `480`（UTC+8）；固定偏移，不自动处理夏令时 |

账号、项目、目标、可用区、配置名称与数据库路径均默认为空，插件不预设任何人的部署。每次连接显式传入配置、账号和项目。

远端数据库需包含下列字段：

```text
logs: id, name, group_id, created_at, updated_at, size
log_items: id, log_id, nickname, im_userid, time, message, removed
```

`time` 为 Unix 秒；拉取时排除 `removed` 非零的消息，按 `time` 和 `id` 排序。不兼容的表结构会导致查询失败。

## 使用

点击侧栏骰子图标，或执行「从云端拉取跑团 log」。从按最近修改时间排序的列表中选择日志，再选择笔记库顶层的项目文件夹；没有项目文件夹时先创建一个。

结果写入 `<项目>/pulled-log/<日志名>.txt`，随后打开。同名文件已存在时生成新文件名，保留已有文件。可再使用 Dice Log Painter 染色。

导出格式为：

```text
示例玩家(QQ:10000001) 2000/01/01 08:00:00
这是一条虚构的演示发言。
```

每次操作是独立快照；它不会持续追踪后续发言，也不会合并历史下载。

账号 ID 须非空且不含空白或括号；异常记录会明确报错。昵称中的换行替换为空格，以保持发言头完整；正文中的换行保留。

## 隐私与数据

发布包不含云账号、服务器地址、数据库、认证材料或实际日志。插件没有遥测或日志上传服务；网络连接由本机 gcloud 按用户填写的目标发起。数据库查询使用只读模式。

插件设置会保存在笔记库的插件 `data.json` 中，其中包含你填写的账号、项目和路径。认证由 gcloud 自行管理，插件不要求填写账号密码或私钥。不要把使用后的 `data.json`、认证文件或日志一起打包公开。

拉取结果保留原始昵称、账号 ID、正文与时间，不是匿名数据。公开跑团记录前需要另行检查。连接失败的插件提示不回显完整命令或服务器原始错误；在终端自行排查时，终端输出仍可能含私人信息。

gcloud 自身会处理 SSH 密钥及连接元数据。官方说明：“one is generated using `ssh-keygen(1)`”。首次使用前应在终端完成连接准备；数据库只读不代表 gcloud 不会更新认证相关文件。[Google Cloud SSH 文档](https://docs.cloud.google.com/sdk/gcloud/reference/compute/ssh)

## 开发与验证

`main.js` 是 CommonJS 源码和安装入口。使用 Node.js 18 或以上运行：

```sh
npm test
```

测试使用虚构数据、模拟进程与临时 SQLite 命令替身，不访问云账号或真实日志。真实 gcloud/IAP 权限、网络状态和具体 SealDice 数据库版本需在使用环境中验证。

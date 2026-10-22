# dshoo（插件）

把本机 DeepSeek Harness 接到一个 [dshoo](https://github.com/imaegoo/dshoo) 服务端，之后可以从服务端的 Web UI 打开这台实例的界面。

## 安装

**方式一：桌面版**——打开 DeepSeek Harness 桌面版，点击左侧 **插件 → 添加插件**，输入包名 `dshoo`，点**安装**，再点**立即启用**。

**方式二：命令行**——

```sh
dsh plugin --profile web add dshoo
```

桌面版用 `--profile desktop`。装完重启 dsh。

## 使用

**设置 → 远程访问**：

| 字段 | 说明 |
| --- | --- |
| 服务端地址 | `https://fleet.example.com`，省略协议时按 `https` 处理 |
| 用户名 / 密码 | 服务端账号；密码只在首次填写，之后留空表示不修改 |
| 实例名称 | 列表里显示的名字，留空用主机名 |

服务端地址、用户名、实例名称改动即时保存；密码在离开密码框时才提交，输入过程中不会被截断保存。点「连接」建立隧道，按钮变成红色的「断开连接」。连接状态、实例 ID 与服务端地址显示在页面上方。

连接是持久的：关闭设置页、切换页面都不会断开；dsh 重启后会自动重连，连接断开时每 10 秒重试一次。只有手动点「断开连接」才会停止自动连接。

配置写在 `~/.dsh/dshoo.json`（权限 0600，含明文密码）。

## 它做了什么

1. 用服务器账号（HTTP Basic over WSS）连 `/tunnel`，上报主机名、平台、dsh 版本与本机 GUI 端口。
2. 服务端把浏览器的 HTTP / WebSocket 拆成帧发过来，插件在本地重放到 `127.0.0.1:<GUI 端口>`，再把响应发回去。
3. 本机 dsh 的会话 cookie 由插件通过 `connection.authenticatedUrl()` 换取并自行保管，浏览器的会话与服务端账号互不影响。
4. 首页 HTML 里若出现根绝对路径（`/plugins/`、`/assets/`），改写到服务端分配的 `/i/<实例 id>/` 前缀下；dsh 0.2.1 的前端产物本身是相对路径，通常这一步不产生改动。

## 边界

- 需要 dsh `0.2.1-rc.2` 及以上（用到 `ctx.webServer` 与 `ctx.connection.authenticatedUrl`）。
- 只代理本进程的 Web GUI，不代理终端等任意流量。
- 请求体在内存中缓冲，上限 64 MB。

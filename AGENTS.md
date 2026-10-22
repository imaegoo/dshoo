# AGENTS.md — 开发说明

面向在本仓库里改代码的人和 agent。用户文档在 [README.md](README.md)。

## 结构

```
src/server/          Go 服务端（module dshoo）
  cmd/dshoo/         入口：-version / -passwd / 启动 HTTP
  internal/config/   环境变量
  internal/store/    SQLite：users / sessions / instances（modernc.org/sqlite，纯 Go）
  internal/tunnel/   隧道帧协议 + 连接注册表
  internal/web/      路由、登录与首次初始化、反向代理、隧道端点
  internal/web/ui/   内嵌前端（login / setup / app + style.css）
src/plugin/          dsh 插件（npm 包名 dshoo，TS → lib/）
  src/index.ts       插件装配、设置 API、隧道生命周期
  src/tunnel.ts      到服务端的 WSS 客户端（固定 10s 重试）
  src/bridge.ts      帧 ⇄ 本机 dsh 的 HTTP/WebSocket 代理
  src/harness.ts     本机 GUI 端口与登录 cookie
  src/config.ts      ~/.dsh/dshoo.json
  src/client.ts      设置页「远程访问」（浏览器侧，普通 script）
  scripts/postbuild.mjs  去掉 tsc 给 client.js 加的 export {}
test/               端到端与真实浏览器检查脚本
```

## 常用命令

```sh
pnpm install                      # 工作区依赖（根 + src/plugin）

# 服务端
pnpm server:vet                   # go vet
pnpm server:test                  # go test（store / tunnel 单测）
pnpm server:build                 # 产出 src/server/bin/dshoo

# 插件
pnpm typecheck                    # tsc --noEmit
pnpm build                        # 产出 src/plugin/lib

# 本地联调
cd src/server && DSHOO_DATA=./data go run ./cmd/dshoo
dsh plugin --profile web add "$PWD/src/plugin"
```

## 端到端验证

三个脚本都需要一台在跑的服务端；浏览器脚本还需要本机 Edge（可用 `DSHOO_BROWSER` 指定其它 Chromium）。

```sh
node test/e2e.mjs http://127.0.0.1:9830 admin <密码>
node test/browser-check.mjs                       # 截图写到 .run/shots/
node test/plugin-ui-check.mjs "http://127.0.0.1:<dsh端口>/?token=<启动 token>"
```

- `e2e.mjs`：首次初始化（或 409）、登录、实例列表、实例首页、`/plugins/...` 前端模块、`/api/remote.mux` WebSocket。
- `browser-check.mjs`：未登录访问必须落到 `/login`；登录后点实例，iframe 内 dsh 完整启动且无控制台报错。
- `plugin-ui-check.mjs`：直接打开 dsh GUI，断言「远程访问」入口注册、字段与连接状态渲染。

## 工作原理

**隧道**：插件用服务器账号（HTTP Basic over WSS）连 `/tunnel`，发 hello（实例 key、主机名、OS/架构、dsh 版本、GUI 端口），服务器按 `(账号, key)` 复用实例行并返回实例 id。

**多路复用**：一条 WebSocket 上跑帧（1 字节类型 + 4 字节大端流 id + 载荷）。`REQ_HEAD/REQ_BODY/REQ_END` 描述一个 HTTP 请求，`RES_HEAD/RES_BODY/RES_END` 描述响应；`WS_OPEN/WS_TEXT/WS_BINARY/WS_CLOSE` 描述被代理的 WebSocket。响应边到边转发，SSE 与大文件都走这条路径。

**本机鉴权**：dsh 的 GUI 只绑回环，且要求按 authority 签名的 cookie。插件用 `connection.authenticatedUrl()` 换一次性登录 cookie 并自己保管，浏览器的会话与服务端账号互不影响，多实例也不会串号。

**路径前缀**：实例挂在 `/i/<实例 id>/`，`/i/<id>` 会 302 到 `/i/<id>/`。dsh 前端产物是相对路径（含 `<base href="./">`），插件只对可能出现的根绝对路径（`/plugins/`、`/assets/`）做兜底改写，见 `bridge.ts` 的 `rewriteIndex`。

**离线与重连**：网关常给 WebSocket 加最大存活时间（例如 5 分钟），所以「断线」是常态而非异常。处理方式：

- 插件侧：连接存活超过 2 秒才算「健康」。健康连接被掐断后 **1 秒**重试（最多连续 3 次快速重试），其余情况仍是 **10 秒**；`enabled` 为 `false`（用户点过断开）时不自动连接。
- 每次新建 socket 前调用 `Bridge.reset()`：新连接的流 id 从 1 重新开始，旧连接残留的帧不能落到新连接上。
- 服务端侧：断开后先等 **30 秒宽限**（`offlineGrace`）再标记离线；宽限期内重连则实例始终显示在线、SSE 不推离线；被新隧道顶掉的旧隧道不触发离线；宽限期内的浏览器请求会等待最多 3 秒等隧道回来，而不是直接 502。
- 服务端启动时把所有实例置为离线。

**设置页表单**：草稿跟随宿主快照，除非用户正在编辑（`dirty`）。所以重新打开设置页永远显示已保存的配置；密码框在获得焦点时不会被写入。

**首次初始化**：数据库没有账号时，除 `/setup`、`/static/*`、`/healthz`、`/api/setup` 外全部 302 到 `/setup`（API 返回 428）。`store.CreateFirstUser` 用 `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM users)` 保证并发下只创建一个账号。没有环境变量种子账号，也没有默认密码。

## 约定

- 服务端注释、提交信息用英文；界面文案用中文，前端文案集中在 HTML/JS 里。
- 服务端页面颜色一律使用 `style.css` 顶部那套令牌（取值来自 dsh 的 `--dsw-alias-*`），浅色与深色跟随系统；插件设置页同理，直接用 `--dsw-*` 变量加回退值。
- 插件的 `client.js` 由 dsh 以普通 script 加载：不能出现 `import`/`export`（构建后处理脚本会检查）。
- 隧道帧的载荷上限：服务端 `SetReadLimit(64MB)`，插件 `maxPayload` 同值；改动其一必须同步另一个。
- 代理会剥掉实例响应的 CSP / `X-Frame-Options` 与 `Set-Cookie`，并且不转发浏览器的 cookie 给实例——这是「同源内嵌 + 插件自持凭据」的前提，改动前先想清楚。

## 发布

版本号格式 `x.y.z`（无 `v` 前缀），由 GitHub Release 的 tag 决定。仓库里的 `package.json` 版本固定为 `0.0.1` 占位，发布时由流水线覆盖。

`.github/workflows/ci.yml`：push、pull_request、workflow_dispatch 触发，跑 `gofmt -l`、`go vet`、`go test`、`go build` 与插件的 `pnpm typecheck` / `pnpm build`。

`.github/workflows/release.yml`：release published 触发，四个 job：

1. **binaries**：交叉编译 6 个产物（windows / linux / darwin × amd64 / arm64），文件名 `dshoo-<version>-<os>-<arch>[.exe]`，用 `gh release upload` 上传到对应 release。
2. **npm**：`pnpm install && pnpm build` 后把 `src/plugin/package.json` 的版本改成 tag 版本，`npm publish --provenance --access public`。走 npm 可信发布（OIDC），因此该 job 需要 `id-token: write`，且不需要任何 npm token。
3. **docker**：buildx 构建 `linux/amd64` 与 `linux/arm64`，推送 `ghcr.io/imaegoo/dshoo:<version>` 与 `:latest`，使用默认 `GITHUB_TOKEN`（需要 `packages: write`）。

首次发布前需要在 npm 上配置可信发布（Trusted Publisher）：包 `dshoo`、仓库 `imaegoo/dshoo`、workflow 文件名 `release.yml`。因为 npm 要求包先存在才能配置，仓库里已用一次性 token 发过 `0.0.1` 占位版本。

`GITHUB_TOKEN` 由 Actions 默认注入，上传 release assets 与推送 GHCR 都只需要它；npm 走 OIDC，也不需要额外密钥。

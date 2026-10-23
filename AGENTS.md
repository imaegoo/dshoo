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
  src/tunnel.ts      到服务端的 WSS 客户端（健康后 1s / 其余 10s 重试）
  src/bridge.ts      帧 ⇄ 本机 dsh 的 HTTP/WebSocket 代理
  src/hud.ts         远程页面的返回按钮与延迟胶囊（注入 + 浏览器脚本）
  src/harness.ts     本机 GUI 端口与登录 cookie
  src/config.ts      ~/.dsh/dshoo.json
  src/version.ts     从 package.json 读插件版本（hello 与设置页上报）
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

前四个脚本都需要一台在跑的服务端；浏览器脚本还需要本机 Edge（可用 `DSHOO_BROWSER` 指定其它 Chromium）。`hud-check.mjs` 自带一个假实例，不需要服务端。

```sh
node test/e2e.mjs http://127.0.0.1:9830 admin <密码>
node test/browser-check.mjs                       # 截图写到 .run/shots/
node test/plugin-ui-check.mjs "http://127.0.0.1:<dsh端口>/?token=<启动 token>"
node test/mobile-check.mjs http://127.0.0.1:9830 admin <密码>
```

- `e2e.mjs`：首次初始化（或 409）、登录、实例列表、实例首页、`/plugins/...` 前端模块、`/api/remote.mux` WebSocket。
- `browser-check.mjs`：未登录访问必须落到 `/login`；登录后点卡片直接进入 `/i/<id>/`，dsh 完整启动且无控制台报错。
- `plugin-ui-check.mjs`：直接打开 dsh GUI，断言「远程访问」入口注册、字段与连接状态渲染、密码输入不留存、重开设置页回填。
- `mobile-check.mjs`：用 Pixel 7 视口跑登录、实例列表与离线页；自己建一条隧道再等它掉线，断言页面用手机视口渲染（980px 回退会直接失败）、不横向溢出、触摸设备上能点到「移除」。跑完删掉自己建的实例。
- `hud-check.mjs`：不需要服务端。把假 index 跑一遍 `rewriteIndex`，用本地 HTTP 服务器提供页面、HUD 脚本和延迟可调的 ping，断言胶囊位置、绿/黄/红、手机紧凑形态，以及「本机页面没有胶囊」。

## 工作原理

**隧道**：插件用服务器账号（HTTP Basic over WSS）连 `/tunnel`，发 hello（实例 key、主机名、OS/架构、dsh 版本、GUI 端口），服务器按 `(账号, key)` 复用实例行并返回实例 id。

**多路复用**：一条 WebSocket 上跑帧（1 字节类型 + 4 字节大端流 id + 载荷）。`REQ_HEAD/REQ_BODY/REQ_END` 描述一个 HTTP 请求，`RES_HEAD/RES_BODY/RES_END` 描述响应；`WS_OPEN/WS_TEXT/WS_BINARY/WS_CLOSE` 描述被代理的 WebSocket。响应边到边转发，SSE 与大文件都走这条路径。

**本机鉴权**：dsh 的 GUI 只绑回环，且要求按 authority 签名的 cookie。插件用 `connection.authenticatedUrl()` 换一次性登录 cookie 并自己保管，浏览器的会话与服务端账号互不影响，多实例也不会串号。

**路径前缀**：实例挂在 `/i/<实例 id>/`，`/i/<id>` 会 302 到 `/i/<id>/`。实例列表是一页卡片，卡片直接链到 `/i/<id>/`，没有中间页；dsh 前端产物是相对路径（含 `<base href="./">`），插件只对可能出现的根绝对路径（`/plugins/`、`/assets/`）做兜底改写，见 `bridge.ts` 的 `rewriteIndex`。

**离线与重连**：网关常给 WebSocket 加最大存活时间（例如 5 分钟），所以「断线」是常态而非异常。处理方式：

- 插件侧：连接存活超过 2 秒才算「健康」。健康连接被掐断后 **1 秒**重试（最多连续 3 次快速重试），其余情况仍是 **10 秒**；`enabled` 为 `false`（用户点过断开）时不自动连接。
- 插件侧探活：连上以后每 **10 秒**发一个 WebSocket ping，**5 秒**内没有 pong 就 `terminate()` 并重连。Wi-Fi 掉线、休眠或 NAT 映射过期时，本机 socket 会一直停在 ESTABLISHED 且没有任何 close 事件，不主动探活就会永远显示「已连接」。最坏 15 秒发现，仍在服务端 30 秒宽限内，所以列表不会闪一下离线。
- 每次新建 socket 前调用 `Bridge.reset()`：新连接的流 id 从 1 重新开始，旧连接残留的帧不能落到新连接上。
- 服务端侧：断开后先等 **30 秒宽限**（`offlineGrace`）再标记离线；宽限期内重连则实例始终显示在线、SSE 不推离线；被新隧道顶掉的旧隧道不触发离线；宽限期内的浏览器请求会等待最多 3 秒等隧道回来，而不是直接 502。
- 服务端启动时把所有实例置为离线。

**设置页表单**：草稿跟随宿主快照，除非用户正在编辑（`dirty`）。所以重新打开设置页永远显示已保存的配置；密码框在获得焦点时不会被写入。

**远程页面胶囊**：远程打开 `/i/<id>/` 时，页面左上角有一个返回按钮和延迟胶囊（16px 贴边，手机上收成箭头 + 三格 + 数字）。

- 注入点在 `bridge.ts` 的 `rewriteIndex`：只改写经过隧道的 HTML，所以本机直接打开 dsh 不会出现胶囊。
- 首屏语言：dsh 的 index 写死 `<html lang="en">`，要等客户端启动后才按浏览器语言改成 `zh-CN`/`en`；Chrome 在那之前就会弹「是否翻译此页」。代理按请求的 `Accept-Language` 直接改写首屏的 `lang`（`zh*` → `zh-CN`，其余 → `en`，没有该头就不动），和 dsh 自己的行为一致。
- 胶囊可以拖动（返回按钮以外的区域都算拖拽区），松手吸附到最近的边缘并留 16px，240ms 的 `transform` 过渡；拖动时把过渡关掉跟手，松手再打开。吸附后数字变宽/变窄会由 `keepAnchored` 重新贴住右/下边。
- 落点离角落不到 16px 时同时吸附两条边，保证两个方向都留 16px，而不是一边 16、另一边更小。
- 位置按实例记在 `localStorage`（key 是页面路径），刷新/重进回到原处；`resize` 时右/下吸附的边重新贴到 16px，其余情况只做越界收敛（手机地址栏收起会触发 resize，这是期望行为）。
- 胶囊运行在 shadow DOM 里，避免被 dsh 的全局样式影响；脚本由插件自己提供（`/i/<id>/__dshoo/hud.js`），不占隧道以外的资源。
- 延迟探针打 `/i/<id>/__dshoo/ping`，插件直接回 204，不经过 dsh；测出来的就是 浏览器 → 服务器 → 隧道 → 插件 的往返。用 Resource Timing 的 `responseStart - requestStart`，不用 `performance.now()`（页面启动时主线程忙会让后者虚高）。
- 阈值：≤120ms 绿三格、≤300ms 黄两格、其余红一格；超时两次显示 `—`；数字封顶 99999。首次探测是预热，不算进中位数，之后每 5 秒一次、显示最近 3 次中位数；页面隐藏时暂停。

**首次初始化**：数据库没有账号时，除 `/setup`、`/static/*`、`/healthz`、`/api/setup` 外全部 302 到 `/setup`（API 返回 428）。`store.CreateFirstUser` 用 `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM users)` 保证并发下只创建一个账号。没有环境变量种子账号，也没有默认密码。

## 约定

- 服务端注释、提交信息用英文；界面文案用中文，前端文案集中在 HTML/JS 里。
- 服务端页面颜色一律使用 `style.css` 顶部那套令牌（取值来自 dsh 的 `--dsw-alias-*`），浅色与深色跟随系统；插件设置页同理，直接用 `--dsw-*` 变量加回退值。
- 插件的 `client.js` 由 dsh 以普通 script 加载：不能出现 `import`/`export`（构建后处理脚本会检查）。
- 隧道帧的载荷上限：服务端 `SetReadLimit(64MB)`，插件 `maxPayload` 同值；改动其一必须同步另一个。
- 代理会剥掉实例响应的 CSP / `X-Frame-Options` 与 `Set-Cookie`，并且不转发浏览器的 cookie 给实例——这是「同源内嵌 + 插件自持凭据」的前提，改动前先想清楚。
- Go 版本：`src/server/go.mod` 的 `go` 指令钉精确补丁版本（CI 与发布二进制读它），`src/server/Dockerfile` 浮在同一个次版本线上（`golang:1.27-alpine`），以便自动吃到补丁。升级小版本时两处一起改。
- 移动端：服务端每张页面都必须带 `<meta name="viewport" content="width=device-width, initial-scale=1">`，漏了会让手机按 980px 排版（文字缩成一条），`test/mobile-check.mjs` 会直接报出来。小屏断点是 `620px`；触摸设备没有 hover，卡片上的「移除」靠 `@media (hover: none)` 常显，键盘用户靠 `:focus-within`。
- 胶囊脚本（`hud.ts` 的 `installHud`）是靠 `toString()` 序列化进页面的，函数体必须自包含：不能引用模块作用域、导入或外部常量（超时、阈值都写成函数内的字面量）。改完跑 `test/hud-check.mjs`，它会在真实浏览器里验证位置、颜色、拖拽吸附和手机形态。

## 发布

版本号格式 `x.y.z`（无 `v` 前缀），由 GitHub Release 的 tag 决定。仓库里的 `package.json` 版本固定为 `0.0.1` 占位，发布时由流水线覆盖。

`.github/workflows/ci.yml`：push、pull_request、workflow_dispatch 触发，跑 `gofmt -l`、`go vet`、`go test`、`go build` 与插件的 `pnpm typecheck` / `pnpm build`。

`.github/workflows/release.yml`：release published 触发，四个 job：

1. **binaries**：交叉编译 6 个产物（windows / linux / darwin × amd64 / arm64），文件名 `dshoo-<version>-<os>-<arch>[.exe]`，用 `gh release upload` 上传到对应 release。
2. **npm**：`pnpm install && pnpm build` 后把 `src/plugin/package.json` 的版本改成 tag 版本，`npm publish --provenance --access public`。走 npm 可信发布（OIDC），因此该 job 需要 `id-token: write`，且不需要任何 npm token。
3. **docker**：buildx 构建 `linux/amd64` 与 `linux/arm64`，推送 `ghcr.io/imaegoo/dshoo:<version>` 与 `:latest`，使用默认 `GITHUB_TOKEN`（需要 `packages: write`）。

首次发布前需要在 npm 上配置可信发布（Trusted Publisher）：包 `dshoo`、仓库 `imaegoo/dshoo`、workflow 文件名 `release.yml`。因为 npm 要求包先存在才能配置，仓库里已用一次性 token 发过 `0.0.1` 占位版本。

`GITHUB_TOKEN` 由 Actions 默认注入，上传 release assets 与推送 GHCR 都只需要它；npm 走 OIDC，也不需要额外密钥。

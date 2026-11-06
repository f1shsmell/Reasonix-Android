# Contributing to Reasonix For Android

这是 Reasonix Studio 的非官方 Android 客户端。改动保持小、可测试、可回滚；发版是单独的动作，
见 [RELEASING.md](RELEASING.md)。

## 环境

- Node.js 22+
- JDK 21（`JAVA_HOME` 指向 JDK 21，Gradle 8 不接受更高的 class 版本）
- Android SDK 36（`ANDROID_HOME` 指向 SDK）
- 真机或模拟器用于原生插件测试

Windows / Git Bash 下 `npm run dev` 可能因为路径引号失败，可直接运行
`node ./node_modules/vite/bin/vite.js`。`npx tsc` 也可能解析到无关包，用
`./node_modules/.bin/tsc` 或 `npm run typecheck`。

## 常用命令

```bash
npm ci
npm run typecheck
npm test
npm run build

npx cap sync android
cd android
./gradlew testDebugUnitTest assembleDebug
./gradlew connectedDebugAndroidTest   # 需要设备/模拟器
```

发版前另外运行 `npm run manifest`，它会读取版本号、`reasonix.versionCode` 和发布说明，
生成仓库根 `latest.json`。不要手改这个文件。

## 结构

| 目录 | 作用 |
|---|---|
| `src/app/` | 屏幕、导航和设置 |
| `src/chat/` | 对话、流式渲染、输入区 |
| `src/net/` | 连接、代理、relay、SSE、重连 |
| `src/native/` | Capacitor 插件桥 |
| `src/wire/` | 内核契约类型，与 `fixtures/wire/` 共同约束前后端字段 |
| `src/ui/` | 手机端样式与设计 token |
| `android/app/src/main/java/` | 原生壳、代理、通知与更新器 |
| `fixtures/wire/` | Vitest 与 JUnit 共用的契约样本；用 `REASONIX_SERVE=... REASONIX_TOKEN=... npm run fixtures` 从真实内核刷新 |

## 改动规则

- 一个 PR 只做一件事；独立修复从 `main` 开分支，不同改动不要混在一个 PR。
- 先写会失败的测试，再改实现。UI 改动同时覆盖相邻行为，并跑完整相关测试。
- 优先修在拥有的层：不要在症状处加特殊分支或复制一条路径。
- 错误要有身份（code/sentinel），不要靠匹配错误文案。
- 不提交密钥、配对码、token、聊天内容或设备凭据。
- 不在功能 PR 里升版本、打 tag 或发 Release；发版按 `RELEASING.md`。

## UI PR 的截图

涉及 `src/` 下界面（或原生页面布局）的 PR，描述里必须附截图：

- **before / after** 各一组；新页面没有 before 可以写「新增」。
- **light / dark** 各一张。
- **手机竖屏（约 390 px）** 一张；布局在宽屏或横屏会变化时，再附一张宽屏/横屏（或平板）截图。
- 用真机截图；用 WebView/无头浏览器渲染代替时，在 PR 里注明。
- 列出移动过、隐藏或删除的可见控件；隐藏/删除一个可见控件需要关联 issue 和一条 release note。

## 提交与评审

- 提交信息用 Conventional Commits：`feat(scope): …`、`fix(scope): …`、`chore(release): …`。
- PR 基于 `main`；评审反馈优先 amend，不要叠加一串修正提交。
- 冲突用自己的分支 rebase 一次，不制造多轮 force-push。
- 只改界面时可用 `npm run dev:mock`（脚本化内核，不启动 Studio）；
- 改 `src/wire/` 或 fixtures 时，在 DeepSeek-Reasonix checkout 旁跑 `REASONIX_KERNEL=../DeepSeek-Reasonix npm run check:wire`；
- 本地至少跑过：`npm run lint`、`npm run typecheck`、`npm run test:coverage`、`./gradlew testDebugUnitTest`；
  改动涉及原生时再跑 `lintDebug`、`assembleDebug` 或 `connectedDebugAndroidTest`。

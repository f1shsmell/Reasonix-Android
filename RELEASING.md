# 发布流程

日常提交和发布分开，规则参照
[DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 的发布方式：
标签是明确的发版动作，不是每次修改的副产物。

## 日常

- 每个 push / PR 只跑 CI：Web 类型检查、全量测试、构建，Android 单测和 debug APK。
- CI 的 APK 是**测试产物**，14 天后过期，不是 Release。
- 修 bug、加小功能：只提交，不升版本、不打 tag、不发 Release。
- 多个改动攒到一次发版；发版由人明确决定。

## 发版

1. **升版本**：同时改三处，版本必须一致。
   - `package.json` / `package-lock.json`：`npm version X.Y.Z --no-git-tag-version`
   - `android/gradle.properties`：`reasonix.versionName=X.Y.Z`，`reasonix.versionCode` +1
2. **写发布说明**：新增 `release-notes/android/X.Y.Z.md`。
   - 分「新增 / 变更 / 修复」，写给用户看，不写实现流水账。
   - 关联 issue 或提交（如 `关联 #123`）。
3. **合并到 main**，CI 全绿。
4. **打标签**：在 main 的发布提交上 `git tag -a vX.Y.Z -m "Reasonix For Android X.Y.Z"`，推送 tag。
5. **release 工作流**会先校验，再构建并发布：
   - tag 必须是 `vX.Y.Z`（可带预发布后缀）；
   - tag 必须在 `main` 上；
   - 必须存在 `release-notes/android/X.Y.Z.md`；
   - `package.json` 与 `android/gradle.properties` 的版本必须等于 tag；
   - GitHub Release 的正文直接使用这份发布说明，不自动生成。
6. 发布失败可用 `workflow_dispatch` 输入**已存在的 tag** 重跑；重跑会替换同名资产，不会另起一个版本。
   勾选 `dry_run` 则只还原密钥、构建 `assembleRelease` 并验签，不发布、不碰已有资产。

## 签名

Release 用固定密钥签名，密钥不进仓库：

- GitHub Secrets：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、
  `ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。
- 本机备份在 `%USERPROFILE%\.reasonix-android\`（`release.jks` 与
  `keystore.properties`）。这两个文件丢了，后续版本就无法覆盖安装，只能换包名或让用户卸载。
- 证书 SHA-256：`73:46:91:F2:BE:AF:83:50:2F:E5:8A:E8:4A:9A:1A:A9:95:24:66:6B:B6:19:57:CD:10:FB:56:AE:D1:7C:24:6C`。
- 从 debug 包切到签名包的第一版，已装 debug 包的手机会因签名不同拒绝覆盖，需要卸载一次；
  配对 cookie 和 origin 会一起丢失，更新说明里要写明。
- release 工作流会还原密钥、构建 `assembleRelease`（含 R8）并用 `apksigner` 验签；
  CI 的 debug APK 仍然只是测试产物。

## 不要

- 不要为单个修复升版本或打 tag。
- 不要从功能分支发版。
- 不要在没有发布说明或版本号不一致时强行发版；工作流会拒绝。
- 不要手改已发布资产；出问题发下一个 patch。

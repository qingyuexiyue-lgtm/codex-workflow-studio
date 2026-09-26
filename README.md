# Workflow Studio

本机 Codex 工作流配置器，Windows 桌面初版 0.1。Electron 原生窗口与托盘承载 React Flow 画布，执行由本机 Codex App Server 完成，不需要打开浏览器，也不另接裸模型 API。

## 启动

打开 `release/win-unpacked/Workflow Studio.exe`。整个 `win-unpacked` 目录是程序分发包，不能只移动其中的 exe。

已验证的 Codex CLI 版本为 0.153.4。程序默认使用 `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe`；`STUDIO_CODEX_PATH` 可指定其他明确的可执行文件。仍需本机 Codex 的登录及模型配置。

关闭窗口收起到托盘，不结束执行。托盘菜单的“退出”会终止程序。关机、休眠、进程崩溃后的自动续跑未实现。

## 已实现

- 流程保存、复制、删除；自由节点拖拽、连接、复制及删除。
- 角色和节点分离；模型、思考深度、真实项目、已有对话或运行时新建对话、五层任务配置。
- 已有对话使用原 thread ID 续用，不以新会话代替。共享对话在本配置器内串行排队。
- 顺序、并行、条件路线、等待上游汇总、显式返工回边及返工上限。
- JSON 交接、成果正文、文件版本副本和 SHA-256 清单、运行配置快照、事件及用量记录。
- 分支级提问/失败等待、暂停调度、立即中断本运行的 Codex turn、问题回答后重跑、修改提示词后从节点重跑，下游使用新结果。
- 尝试记录及版本选择；并行返工请求保留来源、次数和意见，多目标回边不丢失。
- SQLite 持久化；运行记录不依赖窗口；中断后标记现场待核对，不自动重放。
- 独立任务记忆：用户决定与角色进度分开保存，保留修订和尝试来源；长材料与成果按版本文件交接。
- 超时保留归属、断连后手动重连、原 turn 历史核对、副作用确认，以及采用已完成成果后暂停调度。

默认模板是通用的规划、执行、审核流程。首次运行前，需要为角色选择模型和工作目录。默认只读，可在流程设置中明确改为工作区写入。

## 已知边界

- **桌面 Codex 持有旧对话写入锁时，外部 App Server 会拒绝续用。** `notLoaded` 仅表示在当前 App Server 中未加载，不代表其他客户端没有占用。配置器不释放别的客户端的锁，不篡改会话，也不替换选中的对话。
- 配置器接回的会话也会由自己的 App Server 持有；当前版本需要从托盘退出配置器才能可靠释放给其他客户端，单纯隐藏窗口不会释放。
- 部分桌面对话的项目归属仍存放于 `.codex-global-state.json`。本版本只读该文件中的明确归属及迁移 ID 映射，不依据 cwd 猜测项目。该部分不是稳定公共接口，目前只验证本机版本。
- 外部 App Server 的工具、连接器和权限与桌面会话不保证完全相同。当前不支持 Codex 原生审批/工具询问弹窗；此类请求会明确报告不支持，绝不自动授权。
- 一次执行一个流程，流程内可并行。模型返回 `question` 或节点失败时只阻塞其依赖分支；独立分支继续。无可推进步骤时显示“需要处理”。
- “暂停调度”不打断正在执行的 turn；“立即中断”只中断本配置器该运行拥有的 turn。中断不撤销副作用。自动重试仅限明确拒绝的前置 thread/resume 瞬时错误，最多两次；已派发 turn 或未知结果不自动重试。
- 运行中可以回答并重跑受阻分支，但受影响的下游仍在执行时必须先等待或中断。将角色改绑至正在使用的新会话会明确拒绝，不绕过串行队列。
- 并行返工按配置的总次数预算处理；预算不足时保留所有待处理请求。人工重跑仅消费覆盖子树内的请求，不删除无关分支的意见。
- 重跑允许修改提示词与角色配置；路线或节点集合修改须新建运行。重跑不撤销文件及外部操作。
- 只读运行的正文由程序保存；需要 Codex 生成文件时，使用工作区写入并在任务中指定可写的工作目录。程序的成果归档目录并非 Codex 的额外写入授权。
- 压缩事件后的下一次派发会补入原始约束；真实主动压缩恢复已验收，不能保证当前 turn 内不遗忘。实际系统休眠和自然阈值压缩尚未现场验收。
- 异常运行可在本地请求结束后选择“结束异常运行”，保留记录并允许其他会话启动新流程。这不保证服务端任务停止，不撤销副作用；原会话在核对确认前不可复用，已结束记录不能重新调度。
- 尚未实现独立后台服务、安装器/签名、节点独立会话模式、多流程并发、跨机器项目。
- 界面中的历史预览目前显示最近 10 个 turn；运行时 resume 使用原会话历史，不是只传这 10 个 turn。

## 本地数据

默认位于 Electron userData：`%APPDATA%/codex-workflow-studio`。准确路径显示在“流程设置”。`STUDIO_DATA_DIR` 可指定测试数据目录。

```text
studio.sqlite
artifacts/<run-id>/<node-id>/<attempt>/
  task.md
  response.txt
  handoff.json
  result.md
  manifest.json
  files/
```

程序不会保存密钥副本。任务、提示词、成果和运行历史属于本地敏感数据，按需保管。

## 开发与验证

```powershell
npm install
npm run build
npm start
npm test
node --test scripts/acceptance-controls.mjs
node --test scripts/acceptance-reliability.mjs scripts/acceptance-memory.mjs
node scripts/ui-test.mjs
node scripts/acceptance-ui-controls.mjs
node scripts/acceptance-ui-reliability.mjs
node scripts/acceptance-power-monitor.mjs
npm run pack
```

`npm start` 打开本地桌面窗口，不依赖 Vite 服务。`npm run dev` 仅为前端开发入口，不是用户交付方式。

`acceptance-controls` 使用受控 App Server 模拟器；`acceptance-ui-controls` 使用受控运行记录验证真实桌面渲染器与 IPC。二者都不会向模型发送任务，不能把它们当作真实 Codex 中断或并行的实测记录。

`npm run probe` 读取真实接口。`scripts/verify-session.mjs` 会创建明确标记的接入验收会话并发送测试任务；`scripts/live-engine.mjs` 会继续该测试会话验证角色及模型切换，均会消耗本机 Codex 额度。不要当作普通单元测试反复执行。

`scripts/live-reliability.mjs` 会创建专用测试会话，验证并行、双目标返工、中断及新进程核对采用成果，同样消耗模型额度。测试报告保存到本机，不随源码分发。

`scripts/live-compaction.mjs` 使用专用会话验证主动压缩和后续任务恢复，会消耗模型额度。`acceptance-power-monitor` 只合成唤醒事件，不让电脑实际休眠；支持 `STUDIO_TEST_EXE` 验证打包软件。

运行 `live-reliability` 和 `live-compaction` 前须通过 `STUDIO_TEST_PROJECT_ID` 指定专用测试项目。

当前限制见上文。官方协议参考：https://developers.openai.com/codex/app-server

## 开源与隐私

本项目采用 [MIT 许可证](LICENSE)。

这是独立的实验性项目，不是 OpenAI 官方产品。第三方软件及服务遵循各自的许可和使用条款。

仓库仅包含应用源码。个人流程、会话、凭据及运行数据应保留在本机，不应上传。

开发建议使用 Node.js 24 与 Windows；先 `npm ci`、`npm run build`，再 `npm start`。需要本机已配置且支持相应接口的 Codex，程序不提供账号或模型额度。模型目录来自本机配置，示例中的模型名不代表所有账号均可用。

普通 `npm test` 不发模型任务。真实界面验收 `scripts/ui-test.mjs` 必须显式设置 `STUDIO_TEST_PROJECT_NAME`、`STUDIO_TEST_THREAD_NAME`、`STUDIO_TEST_THREAD_ID`，使用专用测试对话。`scripts/verify-session.mjs` 必须设置 `STUDIO_TEST_THREAD_ID` 与 `STUDIO_TEST_PROJECT_ID`；它会读取/续用指定对话并新建一个测试对话发送任务。不要将真实业务聊天用作接入测试。

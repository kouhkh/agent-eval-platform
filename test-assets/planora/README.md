# Planora 验收资产

这里保存的是被测系统无关协议下的测试数据，不是 Planora adapter。browser-runner 只解释通用的 `navigate / act / assert` 和 setup fixture。

运行前由环境注入登录值：

```bash
export PLANORA_TEST_USERNAME='...'
export PLANORA_TEST_PASSWORD='...'
```

- `knowledge-overhaul-local-readonly.json`：登录后验证典型项目投标/施工正文、两项技术响应以及技术响应库统计。只读，可作为本地重复门禁。
- `knowledge-strategy-save-restore-local.json`：在已停用的专用测试策略上临时改名、刷新、恢复。它会写入业务数据库并增加审计与版本记录，因此不是默认门禁。若运行在恢复步骤前中断，应搜索 `培训test0819` 并确认名称已恢复后再结束运行。

本地基址可以在 run 请求中用 `baseUrl` 覆盖；账号值不写入资产、REST 请求、run 历史或证据。

这些是按通用 schema 编写的被测应用资产，可独立增删改查；它们不向 browser-runner 注册 Planora 代码、接口或执行分支。`approvedScope` 是对当前用例写动作的可审计授权边界，不是项目 adapter。

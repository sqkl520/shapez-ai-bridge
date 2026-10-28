# test/fixtures/llm — LLM 层夹具（阶段 2）

每个场景一个目录：

```
<scenario>/
  meta.json        场景说明 + 期望（goal / obs / expect）
  round-01.json    第 1 次 propose 的**原始输出**（mock 原样交出，不解析不修补）
  round-02.json    …（可选，按轮递增，两位补零）
```

## 硬规矩

1. **mock 不产生"完成"信号**。文件内容就是模型会说的全部内容；合法性与成功分别由
   `parseLlmPlan` 与 `verify` 判。把 `build_line` 写进夹具，mock 会照样交出去 ——
   这样测到的是"拒绝链真的存在"，不是"夹具帮我们挡住了"。
2. **文件耗尽 = `MockExhausted`**。loop 必须转成 `HALT: MOCK_EXHAUSTED`，退出码非 0。
3. `usage` 在 mock 模式恒为 `null`（契约 §Q1.4）。`run_end.mode` 不是 `live` 的 run
   **不构成阶段 2 达成**（§6 判据 3）。
4. `goal` / `obs` 用仓库内**相对路径**，且必须与 `obs.goal.requirement.shape` 一致
   —— 用错夹具会静默换关（契约 §0 F6）。

## 坐标的两层

`neg-literal-coord` 的 `at: [4, -13]` 在 `parseLlmPlan` 是**合法结构**：
同一形状在 `$bbox_of` 的参数里是合法的，只有知道「这个键是不是坐标容器」的
`assertNoHumanCoords`（`coords.mjs`）才能判它违规。所以这份夹具的 `expect` 同时写了
`parse_ok: true` 与 `coord_guard: "V1"` —— 它测的是**两层各司其职**，不是"parse 万能"。

## 场景

| 场景 | 期望 |
|---|---|
| `l4-coldstart` | 语法正确的 `replace_run` + `$bbox_of`；证明 mock 路径与 parser 接受合法计划 |
| `neg-empty-calls` | `LLM_EMPTY_PLAN`，0 次 tx，不得 success |
| `neg-literal-coord` | parse 通过；`assertNoHumanCoords` 判 V1；0 次 tx |
| `neg-unknown-macro` | `build_line` → `LLM_UNKNOWN_MACRO`，0 次 tx |

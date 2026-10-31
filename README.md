# 碎码镜 ShardLens — Byte-Level Erasure Recovery Studio

**P0002 · SPEC_VERSION 1.0.0 · slug `shardlens`**

碎码镜是一个纯前端纠删码实验台：输入真实字节，编成系统型 Reed–Solomon
分片，擦除其中若干片，再用剩余存活片**真正解码**，并对每一个恢复字节
给出系数行、存活分片字节、GF 乘积、逐步 XOR 累计的完整代数证据。
它演示的是**已知位置擦除**的恢复，不是未知损坏定位，也不是工业级存储。

## 快速开始

```sh
npm ci
npm run dev        # 开发服务器
npm run build      # 产出 dist/
npm run preview -- --host 127.0.0.1   # 本地 HTTP 预览 dist/
```

要求：Node.js >= 24（实测 Node v24.22.1、npm 10.9.4）。首次 `npm ci`
需要联网下载公开开源包；**产品运行时不联网**，不调用任何外部 API。

## 常用命令

| 命令 | 用途 | T024 复现结果 |
|---|---|---|
| `npm ci` | 按 lockfile 干净安装 | 0 |
| `npm run typecheck` | TypeScript 严格检查 | 0 |
| `npm test` | 全部测试（11 文件、104 项） | 0 |
| `npm run test:gf` / `test:matrix` / `test:core` / `test:proof` / `test:exhaustive` / `test:io` / `test:ui` | 分组测试 | 0 |
| `npm run build` | 类型检查 + Vite 构建 | 0 |
| `npm run bench` | 4KiB / 16KiB 基准（见下） | 0 |

技术栈：React 19.3.1、TypeScript 5.9.3（`strict:true`）、Vite 8.3.5、
Vitest 5.0.5。算法层为纯 TypeScript + `Uint8Array`，不使用任何
Reed–Solomon 运行库。

## 数学约定（P0，不可改）

- 有限域 `GF(2^8)`：本原多项式 `0x11D`，生成元 `2`，log/exp 表；
  加法即 XOR；`div` 零分母抛 `GF_DIV_ZERO`，`inv(0)` 抛 `GF_INV_ZERO`。
- 系统型生成矩阵 `G = V × V_top^{-1}`（实施计划记为 `G = V × T^{-1}`，
  其中 `T = V[0:k,:]`，同一公式两种记法）。前 `k` 行是单位阵，
  后 `m` 行是 Vandermonde 派生的系统型校验行，任意 `k` 行可逆。
- 参数：`1 ≤ k`，`1 ≤ m`，`n = k + m ≤ 16`，默认 `RS(6,4)`；
  输入 `0..16384` 字节；`shard_len = ceil(original_len / k)`（空输入为 0），
  尾部 `0x00` 填充至 `k × shard_len`。
- 解码：按升序取前 `k` 个有效存活片构成 `G_S`，GF 高斯-约当求逆得 `R`，
  逐列恢复源数据分片，去填充得到恢复字节。`decode()` **不接收原始字节**，
  只接收存活片；`verify()` 在恢复完成后才做逐字节 + SHA-256 双重比对。
- 失败语义：存活 `< k` → `INSUFFICIENT_SHARDS`（`recovered=null`、
  `recovery_matrix=null`、`byte_provenance=[]`，UI 不显示成功）；
  非法矩阵 → `SINGULAR_MATRIX`；非法实验 → `INVALID_EXPERIMENT`（导入拒绝）；
  字节不一致 → `BYTE_MISMATCH`；哈希不一致 → `HASH_MISMATCH`。
  人为污染的未擦除片只提示“标擦除”，**不自动纠错**。

## 固定样例（§12.1 / 计划 §5.3，测试硬断言）

`k=4, m=2`，输入 `ABC`，`shard_len=1, padding_len=1`：

```text
G = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1],[64,120,54,15],[231,210,87,99]]
D0=65 D1=66 D2=67 D3=0 P0=77 P1=2
Erased=[1,4], Selected=[0,2,3,5]
R = [[1,0,0,0],[234,46,13,200],[0,1,0,0],[0,0,1,0]]
byte offset 1: row=[234,46,13,200], source=[65,67,0,2],
  products=[242,61,0,141], XOR accumulators=[242,207,207,66] -> 66 (0x42)
SHA256('ABC') = b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78
```

`RS(6,4)` 全部 15 种“恰好保留 4 片”组合均已实际解码验证
（`npm run test:exhaustive`，15/15，逐字节相等、哈希相同）。

## 界面导览

- **分片墙**：D/P 标签、全局索引、字节长度、hex 预览、SHA-256，擦除/恢复开关。
- **矩阵工作台**：实时 `G`、存活行选择、高斯-约当逐步重放、`R` 对照。
- **逐字节检查器**：按偏移查看系数行、存活分片字节、GF 乘积、XOR 累计、
  结果与期望值；点击计算项可定位到分片墙或矩阵。
- **状态条**：存活数 / 最少需求 / 失败码 / 恢复与校验状态；失败时强制
  显示 `recovered=null`、`R=null`、`evidence=[]`，不残留旧成功数据。
- **反事实对比**：冻结 A 与当前 B 并排对比擦除集、存活集、选行、逆阵、
  可恢复性与首个差异；改原文后比较标记过期，需重新冻结。
- **导入/导出**：实验文件 `.shardlens.json`（完整字段见项目书 §9），
  导出前有隐私提示；导入时从存活片重新求解并逐项重算，篡改一律
  按字段路径拒绝，失败不破坏当前工作状态；文件上限 64 MiB。

## 隐私告知

- 实验全程在本地浏览器运行，不上传、不收集遥测、不写外部日志。
- 导出文件包含**原文与恢复字节的 base64**、分片快照与哈希——请勿把
  含敏感内容的导出文件随意转发；导出前界面会再次提示。
- SHA-256 使用 `crypto.subtle.digest`，需要安全上下文（`localhost` 或 HTTPS）；
  直接双击 `file://` 打开不保证哈希功能正常。

## 目录结构

```text
src/core/        gf256、rs_matrix、encode、decode、verify、evidence、types
src/state/       session.ts（实验状态机，与 React 无关）
src/components/  ShardWall、ExperimentControls、MatrixWorkbench、ByteInspector、
                 StatusBar、ComparisonPanel、ExperimentIOPanel
src/features/input/generators.ts   TextEncoder 输入与 LCG 确定性伪随机输入
src/fixtures/demo.ts
src/io/          experiment_io.ts（导出 / 严格导入）
scripts/benchmark.ts
tests/           11 个测试文件、104 项
```

## 许可证

本项目自写源码采用 MIT 许可证（见 `LICENSE`）。第三方依赖许可证清单见
`THIRD_PARTY_LICENSES.md`（99 个包，实测于 `node_modules`）。

## 已知边界

- 只处理**已知擦除位置**；未知字节损坏不在恢复范围内，污染片只建议标擦除。
- 输入上限 16 KiB、`n ≤ 16`；16 KiB 完整导出约 39 MB（`n=16` 时），
  属设计内体积，导入上限 64 MiB。
- `crypto.subtle` 不可用时哈希分支仅作界面提示，恢复本身不依赖它。

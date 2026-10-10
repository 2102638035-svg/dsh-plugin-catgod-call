# dsh-plugin-catgod-call

> 给 AI 一个"喊话"工具：把文字合成语音，用扬声器大声喊出来。
>
> 一个 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) 插件，让 AI
> 在需要你回来的时候**真的把你叫过来**。

---

## 它解决什么问题

AI 在对话里说"请回来看一下"——但你不在屏幕前，看不到。

这个插件给 AI 一个工具 `catgod_call`。当它觉得该叫你时，直接调用：
**合成语音 → 音量拉满 → 叮咚 → 大声播放 → 音量还给你**。

---

## 特性

- **双引擎**：在线（硅基流动 CosyVoice2）/ 离线（Windows SAPI，零成本兜底）
- **自动回退**：在线失败自动切离线，保证一定喊出声
- **叫醒模式**：叮咚提示音 + 强制音量 100% + 可循环重喊
- **音量三重保险**：用完必定还回去，详见下文
- **零依赖**：不需要 `@deepseek-ai/dsh-tools`，手写 `defineTool` 等价物

---

## 安装

### 1. 放置插件

把本目录放到任意位置，然后建链接到 profile 的 `node_modules`：

```bat
mklink /J "%DSH_HOME%\profiles\<profile>\node_modules\dsh-plugin-catgod-call" "<本目录>"
```

### 2. 注册到 profile

编辑 `$DSH_HOME/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-plugin-catgod-call": "link:<本目录绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-plugin-catgod-call"
      ]
    }
  }
}
```

### 3. 配置密钥

推荐用**环境变量**，别把密钥写进文件：

```powershell
$env:SILICONFLOW_API_KEY = "sk-..."
$env:CATGOD_TTS_PROXY     = "http://127.0.0.1:7890"   # 可选
```

也可以直接写在 `cordis.patch.yml` 的 `apiKey` / `proxy` 字段里。

### 4. 重启 DSH

插件改动**必须重启**才生效。

---

## 配置项

编辑 `cordis.patch.yml`：

| 配置 | 默认 | 说明 |
|---|---|---|
| `engine` | `online` | `online` = 在线合成；`offline` = 仅离线 SAPI |
| `fallbackToOffline` | `true` | 在线失败是否回退离线 |
| `apiUrl` | 硅基流动 | 兼容 OpenAI `/v1/audio/speech` 的服务 |
| `apiKey` | 空 | 留空则读 `SILICONFLOW_API_KEY` 环境变量 |
| `model` | `FunAudioLLM/CosyVoice2-0.5B` | 模型名 |
| `voice` | `...:alex` | 音色，见下方说明 |
| `proxy` | 空 | HTTP 代理，留空直连 |
| `speed` | `1.1` | 语速 0.25 ~ 4.0 |
| `sapiVoice` | `Microsoft Huihui Desktop` | 离线音色 |
| `sapiRate` | `2` | SAPI 语速 -10 ~ 10 |
| `wakeDingdong` | `true` | 叫醒模式是否播叮咚 |
| `forceMaxVolume` | `true` | 播放前拉满音量，播完恢复 |
| `repeatIntervalMs` | `0` | 循环重喊间隔（毫秒），0 = 不循环 |
| `repeatMax` | `3` | 最多喊几次 |
| `addressAs` | `主人` | 默认称呼 |
| `toolDescription` | — | 给 AI 看的工具说明 |

---

## 音色怎么填

### 官方内置音色

格式：`FunAudioLLM/CosyVoice2-0.5B:<name>`

可用的 `name`：`alex` `benjamin` `charles` `david` `anna` `bella` `claire` `diana`

```yaml
voice: "FunAudioLLM/CosyVoice2-0.5B:alex"
```

### 克隆音色

先上传参考音频，再查自己的音色列表：

```bash
curl -X POST https://api.siliconflow.cn/v1/audio/voice/list \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY"
```

返回的 `uri` 字段就是要填的值，格式为：

```
speech:<自定义名>:<音色ID>:<哈希>
```

> ⚠️ 这是**三段**结构，少一段会报 `20047 Invalid voice`。
> 这个 uri 与你的账号绑定，**不要公开分享**。

---

## AI 能传的参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `text` | string | **必填**，要喊的话 |
| `wake` | boolean | 叫醒模式（叮咚 + 音量拉满 + 循环） |
| `address` | string | 开头称呼 |
| `prefix_address` | boolean | 是否自动加称呼 |
| `engine` | enum | `default` / `online` / `offline` |
| `repeat_max` | number | 最多播几次 |
| `repeat_interval_ms` | number | 间隔毫秒 |

---

## 音量安全：三重保险

**播放前拉满音量，播放后必定恢复原值。** 三层保障：

| 保险 | 机制 | 应对场景 |
|---|---|---|
| 一 | PowerShell `try/finally` | 播放中途崩溃 |
| 二 | Node 侧超时兜底 | PowerShell 进程被强杀 |
| 三 | 崩溃看门狗 | 整个宿主被杀 |

原理：拉高前把原音量写进状态文件，正常恢复后删除。
下次启动若发现文件还在，说明上次没还成，立刻补还。

> `Restore-Volume` 函数**内部整体 try/catch 且绝不外抛**。
> 因为它在 `finally` 里调用，一旦抛出会覆盖真实错误、连结果输出都跳过。

---

## 开发笔记（踩过的坑）

### 1. 不要 import `@deepseek-ai/dsh-tools`

插件若放在 `DSH_HOME` 之外，Node 层解析够不着官方包。

好在 `defineTool` 只做纯数据加工：
- `parameters` DSL → JSON Schema
- 用 JSON Schema 校验参数
- 包一层 `execute`

这些都能手写（见 `lib/index.js` 的 `specToJsonSchema` / `validateJsonSchemaValue`）。
注册仍走官方 `ctx.tools.register()`，所以工具行为与内置工具一致。

### 2. 音量与播放必须合并在同一个 PowerShell 进程

`Add-Type` 编译 C# COM 定义要 1~3 秒。
若"设音量"和"播放"分两个进程，每个都要编译一次，用户会明显感到
**"声音先出来、音量后提高"**。合并后延迟从 6 秒降到 1 秒内。

### 3. Windows PowerShell 5.1 不支持 `||` 和 `&&`

这是**解析期错误**，整个脚本一行都不执行。而且 `-EncodedCommand` 下
错误只进 stderr、stdout 为空，会伪装成"执行了但没效果"。

```powershell
# ❌ PS 5.1 直接报错：The token '||' is not a valid statement separator
Add-Type -AssemblyName presentationCore || Add-Type -AssemblyName PresentationCore

# ✅ 用 try/catch
try { Add-Type -AssemblyName presentationCore -ErrorAction Stop }
catch { try { Add-Type -AssemblyName PresentationCore -ErrorAction Stop } catch {} }
```

### 4. `$script:` 前缀不能省

PowerShell 函数默认创建**局部作用域**。`Restore-Volume` 里若写
`$savedVolume` 而非 `$script:savedVolume`，读到的是 `$null`，**音量就还不回去**。

### 5. 用 `-EncodedCommand` 传脚本

避免中文与引号转义地狱。脚本前加 `$ProgressPreference='SilentlyContinue'`
抑制模块加载提示；输出用 `[Console]::Out.Write` 而非 `Write-Output`
（否则被 CLIXML 包裹）。

### 6. `Parser::ParseFile` 对无 BOM + 裸 LF + 中文会算错行列

若你把生成的 PowerShell 落盘做静态语法检查，**必须写 CRLF + UTF-8 BOM**，
否则会报出与真实位置完全不符的语法错误（假阳性）。

### 7. `IAudioEndpointVolume` 连续高频调用会失效

抛 `0xEE74E300`（`AUDCLNT_E_DEVICE_INVALIDATED`，设备被抢占）。
恢复音量的函数要**带重试**，且绝不外抛。

---

## 许可

MIT

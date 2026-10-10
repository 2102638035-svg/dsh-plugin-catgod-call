/**
 * 小猫之神 · 喊话插件（DSH host 半侧）
 *
 * 给 AI 一个工具：catgod_call —— 把文字合成语音，用系统扬声器大声播放。
 *
 * 设计要点：
 * 1. 不 import 任何 @deepseek-ai 官方包。defineTool 做的是纯数据加工
 *    （parameters DSL → JSON Schema、校验、包一层 execute），这里手写等价物，
 *    从而绕开"插件放在 DSH_HOME 之外解析不到官方包"的层解析问题。
 * 2. 工具注册用 ctx.tools.register()，与官方工具同一注册表。
 * 3. 双引擎：在线（硅基流动 CosyVoice2）/ 离线（Windows SAPI）。
 * 4. 播放一律走 PowerShell 子进程，因为插件宿主进程里没有音频输出能力。
 *
 * @module dsh-plugin-catgod-call
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Cordis 插件名。 */
export const name = 'catgod-call'

/** 依赖服务：只要 tools（工具注册表）。 */
export const inject = ['tools']

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const TOOL_NAME = 'catgod_call'

/** 音频临时目录（放在系统临时目录下，避免污染工作区）。 */
const AUDIO_DIR = join(tmpdir(), 'catgod-call-audio')

/**
 * 音量状态文件。拉高音量前写入"原音量"，正常恢复后删除。
 * 若插件启动时发现它还在，说明上次进程被强杀，需要补一次恢复。
 */
const STATE_FILE = join(tmpdir(), 'catgod-call-volume-state.json')

/** 默认配置。cordis.patch.yml 里的值会覆盖这些。 */
const DEFAULTS = {
  engine: 'online',
  fallbackToOffline: true,

  apiUrl: 'https://api.siliconflow.cn/v1/audio/speech',
  apiKey: '',
  model: 'FunAudioLLM/CosyVoice2-0.5B',
  voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
  proxy: '',
  speed: 1.1,
  timeoutMs: 60000,

  sapiVoice: 'Microsoft Huihui Desktop',
  sapiRate: 2,
  sapiVolume: 100,

  wakeDingdong: true,
  forceMaxVolume: true,
  repeatIntervalMs: 0,
  repeatMax: 3,

  addressAs: '主人',
  toolDescription:
    '小猫之神喊话：把一句话合成语音，用电脑扬声器大声播放出来，用于叫用户回来看消息/提醒用户。',
}

/**
 * 从环境变量补全密钥类配置。
 *
 * 优先级：显式配置 > 环境变量。
 * 这样开源版可以把密钥留在环境里，不写进代码/配置。
 */
function applyEnvOverrides(cfg) {
  const env = (k) => {
    const v = process.env[k]
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
  }
  if (String(cfg.apiKey).trim().length === 0) {
    const fromEnv = env('SILICONFLOW_API_KEY') ?? env('CATGOD_TTS_API_KEY')
    if (fromEnv) cfg.apiKey = fromEnv
  }
  if (String(cfg.proxy).trim().length === 0) {
    const fromEnv = env('CATGOD_TTS_PROXY') ?? env('HTTPS_PROXY') ?? env('HTTP_PROXY')
    if (fromEnv) cfg.proxy = fromEnv
  }
  if (String(cfg.voice).trim().length === 0) {
    const fromEnv = env('CATGOD_TTS_VOICE')
    if (fromEnv) cfg.voice = fromEnv
  }
  return cfg
}

// ---------------------------------------------------------------------------
// 手写的 defineTool 等价物
// ---------------------------------------------------------------------------

/**
 * 把 parameters DSL 递归转成 JSON Schema。
 *
 * 支持两种写法：
 *  - 简写 DSL：{ text: { type: 'string', required: true, description: '...' } }
 *  - 原生 JSON Schema：{ type: 'object', properties: {...}, required: [...] }
 */
function specToJsonSchema(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new Error('catgod-call: parameters must be an object')
  }

  // 原生 JSON Schema：有 type/properties 就直接透传（补 required 空数组）
  if (typeof spec.type === 'string' && spec.type !== 'object' && !spec.properties) {
    return spec
  }
  if (spec.type === 'object' && spec.properties) {
    return {
      type: 'object',
      properties: spec.properties,
      required: Array.isArray(spec.required) ? spec.required : [],
      ...(spec.additionalProperties !== undefined
        ? { additionalProperties: spec.additionalProperties }
        : {}),
    }
  }

  // DSL：{ 字段名: { type, required, description, ... } }
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec)) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`catgod-call: parameter "${key}" must be an object`)
    }
    const { required: isRequired, ...rest } = raw
    if (typeof rest.type !== 'string') {
      throw new Error(`catgod-call: parameter "${key}" must declare a type`)
    }
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * 极简 JSON Schema 校验。只覆盖本插件用到的类型与约束。
 * @returns 违规说明数组，空数组代表通过。
 */
function validateJsonSchemaValue(schema, value, path) {
  const violations = []
  const at = path.length > 0 ? path : '(root)'

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${at}: expected an object`]
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        violations.push(`${at}.${key}: required`)
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) {
        violations.push(...validateJsonSchemaValue(sub, value[key], `${at}.${key}`))
      }
    }
    return violations
  }

  if (value === undefined || value === null) return violations

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${at}: expected a string`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        violations.push(`${at}: expected a number`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${at}: expected a boolean`)
      break
    default:
      break
  }
  if (violations.length === 0 && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${at}: must be one of ${schema.enum.join(', ')}`)
  }
  return violations
}

/**
 * defineTool 的手写等价物：校验参数 + 包装 execute。
 *
 * 刻意不加 marker 属性（那是沙箱路径才需要的）。
 */
function defineTool(options) {
  const userExecute = options.execute
  const userRender = options.output.render
  const parameters = specToJsonSchema(options.parameters)
  const outputSchema =
    typeof options.output.schema === 'object' && options.output.schema?.type
      ? options.output.schema
      : { type: 'string' }

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length > 0) {
        throw new Error(`Invalid arguments for ${options.name}: ${violations.join('; ')}`)
      }
      return userExecute(args, exec)
    },
  }
  if (typeof options.presentCall === 'function') tool.presentCall = options.presentCall
  return tool
}

// ---------------------------------------------------------------------------
// PowerShell 执行
// ---------------------------------------------------------------------------

/**
 * 运行一段 PowerShell，返回 { code, stdout, stderr }。
 *
 * 用 -EncodedCommand 传脚本（Base64/UTF-16LE），彻底避开引号与中文转义地狱。
 */
function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    // 前面统一加环境设置：
    //  - ProgressPreference=SilentlyContinue 抑制 "Preparing modules for first use."
    //  - $OutputEncoding / [Console]::OutputEncoding 固定为 UTF-8，保证中文不乱码
    //  - Write-Output 走 stdout，避免 CLIXML 包裹
    const prelude = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$OutputEncoding = [System.Text.Encoding]::UTF8",
    ].join('\n')
    const encoded = Buffer.from(prelude + '\n' + script, 'utf16le').toString('base64')
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ]
    const child = spawn('powershell.exe', args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 进程可能已退出 */ }
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' })
    }, timeoutMs)

    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(err) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
// 音量控制
// ---------------------------------------------------------------------------

/**
 * 系统主音量控制的 COM 互操作定义（Core Audio API）。
 * Add-Type 每次进程都会重新编译，所以按需使用。
 */
const VOLUME_COM = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotImpl1(); int NotImpl2(); int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float f, ref Guid g); int SetMasterVolumeLevelScalar(float f, ref Guid g);
  int GetMasterVolumeLevel(out float f); int GetMasterVolumeLevelScalar(out float f);
  int NotImpl3(); int NotImpl4(); int NotImpl5(); int NotImpl6(); int NotImpl7();
  int NotImpl8(); int NotImpl9(); int NotImpl10(); int NotImpl11(); int NotImpl12();
  int NotImpl13(); int NotImpl14(); int NotImpl15();
  int SetMute(bool m, ref Guid g); int GetMute(out bool m);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr ap, out IAudioEndpointVolume ep); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int NotImpl0(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }
public class AudioVol {
  static IAudioEndpointVolume Vol() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    var iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume vol; dev.Activate(ref iid, 23, IntPtr.Zero, out vol);
    return vol;
  }
  public static float Get() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v; }
  public static void Set(float v) {
    var g = Guid.Empty;
    var vol = Vol();
    vol.SetMasterVolumeLevelScalar(v, ref g);
    vol.SetMute(false, ref g);
  }
}
"@
`

/** 把 0..1 的浮点格式化成 PowerShell 里安全的字面量。 */
function psFloat(value) {
  const n = Number(value)
  const safe = Number.isFinite(n) ? n : 0
  // 用 InvariantCulture 风格，避免出现逗号小数点
  return safe.toFixed(4).replace(',', '.')
}

/** 读取系统主音量（0-100）。失败返回 null。 */
async function getSystemVolume() {
  const script = `${VOLUME_COM}
try {
  [Console]::Out.Write([string]([int][Math]::Round([AudioVol]::Get() * 100)))
} catch {
  [Console]::Out.Write('ERR')
}
`
  const r = await runPowerShell(script, 30000)
  const out = r.stdout.trim()
  if (!out || out === 'ERR') return null
  const n = Number.parseInt(out, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * ★ 关键性能设计：音量 + 叮咚 + 播放 + 恢复音量，全部在【同一个 PowerShell 进程】里完成。
 *
 * 为什么必须这样：
 *   Add-Type 编译那段 C# COM 定义要 1~3 秒。如果设音量、播放各起一个进程，
 *   就会出现"声音先出来、音量后提高"的错乱时序。合并成一个进程后，
 *   顺序严格是：读原音量 → 拉到 100 → 叮咚 → 播放 → 恢复原音量。
 *
 * @returns {Promise<{played:boolean, restored:number|null, log:string[]}>}
 */
async function playWithWake({
  filePaths,
  gapMs = 0,
  wake = false,
  forceMaxVolume = true,
  dingdong = true,
  timeoutMs = 300000,
}) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths])
    .filter((f) => typeof f === 'string' && f.length > 0)
    .map((f) => f.replace(/'/g, "''"))
  if (files.length === 0) throw new Error('playWithWake: 没有可播放的文件')

  const fileList = files.map((f) => `'${f}'`).join(', ')
  const shouldMax = wake || forceMaxVolume
  const shouldDing = wake && dingdong

  // ★ 播放前先在 Node 侧读一次音量，作为"兜底恢复"的目标值。
  //   这样即使 PowerShell 进程被强杀（finally 跑不到），
  //   Node 侧也知道该还原到多少。仅 +1 次进程开销（约 0.3s）。
  const savedBeforePlay = shouldMax ? await getSystemVolume() : null

  // ★ 写状态文件：万一整个 DSH 进程被杀，下次启动时能自动补恢复
  if (shouldMax && savedBeforePlay !== null) {
    try {
      await mkdir(AUDIO_DIR, { recursive: true })
      await writeFile(
        STATE_FILE,
        JSON.stringify({ volumeBefore: savedBeforePlay, at: new Date().toISOString() }),
        'utf8',
      )
    } catch { /* 状态文件写不进去不影响主流程 */ }
  }

  const script = `
${shouldMax ? VOLUME_COM : ''}
# ★ 注意：本机是 Windows PowerShell 5.1，不支持 '||' 运算符（那是 PS7 语法）。
#   用 try/catch 代替，兼容 5.1。
try { Add-Type -AssemblyName presentationCore -ErrorAction Stop }
catch { try { Add-Type -AssemblyName PresentationCore -ErrorAction Stop } catch {} }
$log = New-Object System.Collections.ArrayList
$savedVolume = $null
$playedCount = 0

# ============================================================
# 恢复音量：抽成函数，finally 里必调
# 关键：即使播放中途抛异常，finally 也保证音量还回去
#
# 作用域说明：用 $script: 显式限定，确保函数内外访问的是同一变量。
# （PowerShell 函数默认新建局部作用域，不加前缀会读到 null）
# ============================================================
# ★ 这个函数绝对不允许抛异常。
#   它在 finally 里调用，一旦抛出会覆盖真正的错误、
#   甚至连结果输出都跳过，Node 侧什么都收不到。
#   常见异常 0xEE74E300 = AUDCLNT_E_DEVICE_INVALIDATED
#   （音频设备被抢占/重置，连续多次音频操作时容易出现）
function Restore-Volume {
  try {
    if ($null -eq $script:savedVolume) { return }
    for ($attempt = 1; $attempt -le 4; $attempt++) {
      $failed = $false
      try {
        [AudioVol]::Set($script:savedVolume / 100.0)
        $now = [int][Math]::Round([AudioVol]::Get() * 100)
        if ([Math]::Abs($now - $script:savedVolume) -le 1) {
          [void]$script:log.Add("volume: restored to " + $script:savedVolume)
          return
        }
        [void]$script:log.Add("volume: attempt " + $attempt + " ended at " + $now)
      } catch {
        $failed = $true
        [void]$script:log.Add("volume: attempt " + $attempt + " threw " + $_.Exception.Message)
      }
      if ($failed) { Start-Sleep -Milliseconds 400 } else { Start-Sleep -Milliseconds 200 }
    }
    [void]$script:log.Add("volume: RESTORE FAILED saved=" + $script:savedVolume)
  } catch {
    # 连日志都可能失败 —— 彻底放弃，但绝不往外抛
    try { [void]$script:log.Add("volume: restore crashed") } catch {}
  }
}

try {
  try {
    # —— 1. 记录原音量并拉满 ——
    if (${shouldMax ? '$true' : '$false'}) {
      try {
        # 优先用 Node 侧读到的值，读不到才现场读
        $fallback = ${savedBeforePlay === null ? '$null' : String(savedBeforePlay)}
        if ($fallback -ne $null) { $savedVolume = [int]$fallback }
        else { $savedVolume = [int][Math]::Round([AudioVol]::Get() * 100) }
        [AudioVol]::Set(1.0)
        [void]$log.Add("volume: " + $savedVolume + " -> 100")
      } catch {
        # 拉高失败不致命，继续播放（用户至少能听到声音）
        [void]$log.Add("volume: read/set failed " + $_.Exception.Message)
      }
    }

    # —— 2. 叮咚提示音（在音量拉满之后响） ——
    if (${shouldDing ? '$true' : '$false'}) {
      try {
        [System.Media.SystemSounds]::Asterisk.Play()
        Start-Sleep -Milliseconds 260
        [System.Media.SystemSounds]::Exclamation.Play()
        Start-Sleep -Milliseconds 560
        [void]$log.Add("dingdong: played")
      } catch {
        try { [console]::beep(1200, 180); Start-Sleep -Milliseconds 80; [console]::beep(1600, 260) } catch {}
        [void]$log.Add("dingdong: beep-fallback")
      }
    }

    # —— 3. 逐个播放（同一个 player 复用） ——
    # 播放器创建失败也不能让脚本崩，否则连结果都输出不了
    $player = $null
    try {
      $player = New-Object System.Windows.Media.MediaPlayer
      $player.Volume = 1.0
    } catch {
      [void]$log.Add("player: create failed " + $_.Exception.Message)
    }

    $fileList = @(${fileList})
    if ($null -ne $player) {
      for ($i = 0; $i -lt $fileList.Count; $i++) {
        $f = $fileList[$i]
        try {
          $player.Open([uri]$f)
          $waited = 0
          while ($player.NaturalDuration.HasTimeSpan -eq $false -and $waited -lt 50) {
            Start-Sleep -Milliseconds 100
            $waited++
          }
          $player.Position = [TimeSpan]::Zero
          $player.Play()
          if ($player.NaturalDuration.HasTimeSpan) {
            $sec = [Math]::Min($player.NaturalDuration.TimeSpan.TotalSeconds + 0.5, 120)
          } else {
            $sec = 6
          }
          Start-Sleep -Milliseconds ([int]($sec * 1000))
          $player.Stop()
          $playedCount++
          [void]$log.Add("play[" + $i + "]: ok " + [Math]::Round($sec,2) + "s")
        } catch {
          [void]$log.Add("play[" + $i + "]: fail " + $_.Exception.Message)
        }
        if ($i -lt $fileList.Count - 1 -and ${Math.max(0, Math.round(gapMs))} -gt 0) {
          Start-Sleep -Milliseconds ${Math.max(0, Math.round(gapMs))}
        }
      }
      try { $player.Close() } catch {}
    }
  } catch {
    # 主体任何意外都记下来，但不影响 finally 恢复音量与结果输出
    [void]$log.Add("body: unexpected " + $_.Exception.Message)
  }
}
finally {
  # ★ 无论前面发生什么，音量一定还回去（此函数自身绝不抛）
  Restore-Volume
}

# —— 4. 输出结构化结果 ——
[Console]::Out.Write("PLAYED=" + $playedCount + "|RESTORED=" + $(if ($savedVolume -ne $null) { $savedVolume } else { 'null' }) + "|LOG=" + ($log -join ' ;; '))
`
  const r = await runPowerShell(script, timeoutMs)
  const out = r.stdout
  const m = out.match(/PLAYED=(\d+)\|RESTORED=([^|]+)\|LOG=(.*)$/s)
  if (!m) {
    // ★ 兜底：PowerShell 被超时杀掉 / 脚本解析失败时，
    //   它的 finally 不会执行，音量会卡在 100。从 Node 侧再恢复一次。
    //   同时把 stderr 原文带回去，方便定位（不然只能看到 PLAYED=0）。
    const log = []
    if (out.trim().length > 0) log.push(`stdout: ${out.slice(0, 200)}`)
    const errText = (r.stderr || '').replace(/\s+/g, ' ').trim()
    if (errText.length > 0) log.push(`stderr: ${errText.slice(0, 400)}`)
    if (r.code !== 0) log.push(`exit code ${r.code}`)
    if (log.length === 0) log.push('PowerShell 无任何输出')

    if (shouldMax) {
      const recovered = await restoreVolumeFromNode(savedBeforePlay)
      log.push(recovered ? 'volume: 已由 Node 兜底恢复' : 'volume: Node 兜底恢复失败')
    }
    await unlink(STATE_FILE).catch(() => {})
    return { played: 0, restored: savedBeforePlay, log, failed: true }
  }

  // 正常路径：PowerShell 已经自己恢复了，清掉状态文件
  await unlink(STATE_FILE).catch(() => {})

  return {
    played: Number.parseInt(m[1], 10),
    restored: m[2] === 'null' ? null : Number.parseInt(m[2], 10),
    log: m[3].split(' ;; ').filter((s) => s.length > 0),
  }
}

/**
 * Node 侧的音量恢复兜底。
 *
 * 触发场景：PowerShell 进程被超时强杀 / fetch 超时 / 任何导致
 * 子进程没能跑完 finally 的情况。宁可多恢复一次，也不能让用户
 * 的音量卡在 100%。
 *
 * @param targetVolume - 想要恢复到的音量（0-100），null 表示不做
 * @returns 是否恢复成功
 */
async function restoreVolumeFromNode(targetVolume) {
  if (targetVolume === null || targetVolume === undefined) return false
  const clamped = Math.max(0, Math.min(100, Math.round(targetVolume)))
  const script = `${VOLUME_COM}
try {
  [AudioVol]::Set(${psFloat(clamped / 100)})
  $now = [int][Math]::Round([AudioVol]::Get() * 100)
  [Console]::Out.Write("OK=" + $now)
} catch {
  [Console]::Out.Write('ERR')
}
`
  try {
    const r = await runPowerShell(script, 25000)
    return r.stdout.includes('OK=')
  } catch {
    return false
  }
}

/**
 * 崩溃看门狗：插件启动时检查"上一次喊话是不是把音量留在了 100 没还"。
 *
 * 原理：每次拉高音量前把原值写进状态文件；正常恢复后删掉它。
 * 启动时如果发现状态文件还在，说明上次进程被杀了 —— 立刻恢复。
 *
 * @returns 恢复说明，无需恢复时返回 null
 */
async function recoverVolumeFromCrash() {
  try {
    if (!existsSync(STATE_FILE)) return null
    const raw = await readFile(STATE_FILE, 'utf8')
    const state = JSON.parse(raw)
    const target = Number(state?.volumeBefore)
    if (!Number.isFinite(target)) {
      await unlink(STATE_FILE).catch(() => {})
      return null
    }
    const ok = await restoreVolumeFromNode(target)
    await unlink(STATE_FILE).catch(() => {})
    return ok
      ? `已从上一次异常中恢复音量到 ${target}%`
      : `上次遗留音量 ${target}% 恢复失败（需手动调整）`
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// TTS 引擎
// ---------------------------------------------------------------------------

/**
 * 确保音频临时目录存在。
 *
 * ★ 必须在使用前调用：合成阶段就要往这个目录写文件，
 *   而系统清理临时目录后它可能已经不存在了。
 */
async function ensureAudioDir() {
  await mkdir(AUDIO_DIR, { recursive: true })
}

/**
 * 在线合成（硅基流动）：返回 mp3/wav 字节。
 *
 * 用全局 fetch（Node 18+ 自带）。代理通过 undici 的 ProxyAgent 走，
 * 因为本机代理没进环境变量。
 */
async function synthesizeOnline(cfg, text, outFile, ext) {
  await ensureAudioDir()
  let dispatcher
  if (cfg.proxy && cfg.proxy.trim().length > 0) {
    try {
      const undici = await import('undici')
      dispatcher = new undici.ProxyAgent(cfg.proxy.trim())
    } catch {
      // 拿不到 undici 就直连
      dispatcher = undefined
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

  try {
    const res = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        input: text,
        voice: cfg.voice,
        response_format: ext,
        speed: cfg.speed,
      }),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`在线合成失败 HTTP ${res.status}: ${detail.slice(0, 300)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 256) throw new Error('在线合成返回的音频过小，可能失败')
    await writeFile(outFile, buf)
    return { file: outFile, bytes: buf.length, engine: 'online' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 离线合成（Windows SAPI）：直接生成 wav 文件。
 */
async function synthesizeOffline(cfg, text, outFile) {
  await ensureAudioDir()
  const safeText = text.replace(/'/g, "''")
  const safeVoice = String(cfg.sapiVoice).replace(/'/g, "''")
  const safeFile = outFile.replace(/'/g, "''")
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice('${safeVoice}')
} catch {
  # 指定音色不存在就用系统默认
}
$synth.Rate = ${Math.max(-10, Math.min(10, Math.round(cfg.sapiRate)))}
$synth.Volume = ${Math.max(0, Math.min(100, Math.round(cfg.sapiVolume)))}
$synth.SetOutputToWaveFile('${safeFile}')
$synth.Speak('${safeText}')
$synth.SetOutputToNull()
$synth.Dispose()
[Console]::Out.Write('OK')
`
  const r = await runPowerShell(script, 90000)
  if (!r.stdout.includes('OK')) {
    throw new Error(`离线合成失败: ${(r.stderr || r.stdout).slice(0, 300)}`)
  }
  const buf = await readFile(outFile)
  return { file: outFile, bytes: buf.length, engine: 'offline' }
}

// ---------------------------------------------------------------------------
// 文案处理
// ---------------------------------------------------------------------------

/**
 * 把 AI 给的内容整理成"要念出来的一句话"。
 *
 * 规则：
 *  - 已含称呼就不重复加；
 *  - 强制以句末标点收尾（SAPI 念起来更自然）。
 */
function composeSpeech(cfg, raw, opts) {
  let text = String(raw ?? '').trim()
  if (text.length === 0) throw new Error('text 不能为空')

  const addr = String(opts.address ?? cfg.addressAs ?? '').trim()
  const shouldPrefix = opts.prefixAddress === true
  if (shouldPrefix && addr.length > 0 && !text.includes(addr)) {
    text = `${addr}，${text}`
  }
  if (!/[。！？!?…~～]$/.test(text)) text += '！'
  return text
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * @param ctx - Cordis 上下文（已注入 tools）
 * @param config - cordis.patch.yml 里的 config
 */
export function apply(ctx, config) {
  const cfg = applyEnvOverrides({ ...DEFAULTS, ...(config ?? {}) })

  if (typeof cfg.engine !== 'string' || !['online', 'offline'].includes(cfg.engine)) {
    throw new Error("catgod-call: engine 必须是 'online' 或 'offline'")
  }
  if (cfg.engine === 'online' && String(cfg.apiKey).trim().length === 0) {
    ctx.logger?.warn?.('[catgod-call] engine=online 但 apiKey 为空，将只能依赖离线回退')
  }

  // ★ 崩溃看门狗：如果上次喊话把音量留在了 100 没还（进程被强杀），
  //   插件一启动就补恢复。不阻塞主流程。
  void recoverVolumeFromCrash().then((msg) => {
    if (msg) ctx.logger?.warn?.(`[catgod-call] ${msg}`)
  }).catch(() => {})

  // ★ 提前建好音频目录，避免首次调用时目录不存在导致合成失败
  void ensureAudioDir().catch(() => {})

  // 记录最近一次喊话，便于调试
  let lastCall = null

  /**
   * 核心流程：文案 → 合成 → （可选）叮咚 + 拉音量 → 播放 → 恢复音量。
   */
  const doCall = async (args) => {
    const speech = composeSpeech(cfg, args.text, {
      address: args.address,
      prefixAddress: args.prefix_address === true,
    })

    const wantWake = args.wake === true

    const id = randomUUID()
    let synthesized = null
    const errors = []

    // —— 合成 ——
    const engine = args.engine && args.engine !== 'default' ? args.engine : cfg.engine
    if (engine === 'online') {
      const ext = 'mp3'
      const outFile = join(AUDIO_DIR, `${id}.${ext}`)
      try {
        synthesized = await synthesizeOnline(cfg, speech, outFile, ext)
      } catch (err) {
        errors.push(`online: ${err?.message ?? err}`)
        if (cfg.fallbackToOffline !== false) {
          const wavFile = join(AUDIO_DIR, `${id}.wav`)
          try {
            synthesized = await synthesizeOffline(cfg, speech, wavFile)
            errors.push('已回退到离线 SAPI')
          } catch (err2) {
            errors.push(`offline: ${err2?.message ?? err2}`)
          }
        }
      }
    } else {
      const wavFile = join(AUDIO_DIR, `${id}.wav`)
      try {
        synthesized = await synthesizeOffline(cfg, speech, wavFile)
      } catch (err) {
        errors.push(`offline: ${err?.message ?? err}`)
        if (cfg.fallbackToOffline !== false && String(cfg.apiKey).trim().length > 0) {
          const outFile = join(AUDIO_DIR, `${id}.mp3`)
          try {
            synthesized = await synthesizeOnline(cfg, speech, outFile, 'mp3')
            errors.push('已回退到在线合成')
          } catch (err2) {
            errors.push(`online: ${err2?.message ?? err2}`)
          }
        }
      }
    }

    if (synthesized === null) {
      throw new Error(`catgod-call 合成失败：${errors.join(' | ')}`)
    }

    // —— 播放（音量 + 叮咚 + 循环播放 + 恢复音量，全在同一个 PowerShell 进程里做） ——
    const repeatMax = Math.max(
      1,
      Math.min(20, Math.round(args.repeat_max ?? (wantWake ? cfg.repeatMax : 1))),
    )
    const gapMs = Math.max(
      0,
      Math.min(600000, Math.round(args.repeat_interval_ms ?? (wantWake ? cfg.repeatIntervalMs : 0))),
    )

    // 需要播放几遍就把文件列几遍（同一进程顺序播，不重复起进程）
    const playList = Array.from({ length: repeatMax }, () => synthesized.file)

    const playback = await playWithWake({
      filePaths: playList,
      gapMs,
      wake: wantWake,
      forceMaxVolume: cfg.forceMaxVolume === true,
      dingdong: cfg.wakeDingdong !== false,
    })

    // —— 清理临时音频 ——
    try { await unlink(synthesized.file) } catch { /* 忽略 */ }

    // ★ 如果播放环节整体失败（脚本没跑起来），必须如实报错，
    //   不能假装成功 —— 否则 AI 以为喊过了，用户却什么都没听到。
    if (playback.failed === true) {
      throw new Error(
        `catgod-call 合成成功（${synthesized.engine}）但播放失败，用户没听到声音。` +
        `诊断：${playback.log.join(' | ')}`,
      )
    }

    lastCall = {
      at: new Date().toISOString(),
      speech,
      engine: synthesized.engine,
      bytes: synthesized.bytes,
      played: playback.played,
      wake: wantWake,
      errors,
      playbackLog: playback.log,
    }

    return {
      ok: true,
      spoken: speech,
      engine: synthesized.engine,
      bytes: synthesized.bytes,
      played: playback.played,
      wake: wantWake,
      volumeForced: wantWake || cfg.forceMaxVolume === true,
      volumeRestored: playback.restored,
      warnings: [...errors, ...playback.log],
    }
  }

  // —— 注册工具 ——
  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description: cfg.toolDescription,
      parameters: {
        text: {
          type: 'string',
          required: true,
          description:
            '要喊出来的话（口语化、简短有力，像叫人一样）。不要带引号和表情符号。',
        },
        wake: {
          type: 'boolean',
          description:
            '叫醒模式：先播"叮咚"提示音、强制把系统音量拉到 100、并可按配置循环重喊。适合用户可能戴耳机或离开座位时。',
        },
        address: {
          type: 'string',
          description: `开头称呼，默认"${cfg.addressAs}"。`,
        },
        prefix_address: {
          type: 'boolean',
          description: '是否在句首自动加上称呼。默认不加。',
        },
        engine: {
          type: 'string',
          enum: ['default', 'online', 'offline'],
          description:
            'default=用插件配置的引擎；online=硅基流动在线音色（音质好）；offline=Windows SAPI 离线（零成本、兜底）。',
        },
        repeat_max: {
          type: 'number',
          description: '最多播放几次（含第一次），默认 1。叫醒模式下默认取插件配置。',
        },
        repeat_interval_ms: {
          type: 'number',
          description: '每次播放之间隔多少毫秒，默认 0（不间隔）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            spoken: { type: 'string' },
            engine: { type: 'string' },
            bytes: { type: 'number' },
            played: { type: 'number' },
            wake: { type: 'boolean' },
            volumeForced: { type: 'boolean' },
            volumeRestored: { type: 'number' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
          required: ['ok', 'spoken', 'engine'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `🔊 已喊话（${value.engine === 'online' ? '在线 CosyVoice2' : '离线 SAPI'}）：` +
              `「${value.spoken}」\n` +
              `播放 ${value.played} 次` +
              (value.wake ? '，叫醒模式（叮咚 + 音量拉满）' : '') +
              (value.volumeRestored !== null && value.volumeRestored !== undefined
                ? `，音量已恢复至 ${value.volumeRestored}%`
                : '') +
              (value.warnings?.length ? `\n提示：${value.warnings.join(' | ')}` : ''),
          },
        ],
      },
      async execute(args) {
        return await doCall(args)
      },
      presentCall: (args) => ({
        title: args.text,
      }),
    }),
  )

  ctx.logger?.info?.(
    `[catgod-call] 已注册工具 ${TOOL_NAME}（引擎=${cfg.engine}，音色=${cfg.voice}，称呼=${cfg.addressAs}）`,
  )
}

export default { name, inject, apply }

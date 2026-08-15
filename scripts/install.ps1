# install.ps1 — dsh-profile-plugin-session-delete 一键安装（幂等）。
# 步骤：复制包 → 打补丁（幂等）→ cordis.patch.yml 注册条目（幂等）→ 提示重启。
param(
  [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

if ($DshHome -eq "") {
  $DshHome = $env:DSH_HOME
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE ".dsh"
}

$src = Split-Path -Parent $MyInvocation.MyCommand.Path   # 插件包根（含 scripts）
$profile = Join-Path $DshHome "profiles\web"
$pkgDir = Join-Path $profile "node_modules\dsh-profile-plugin-session-delete"
$patchYml = Join-Path $profile "cordis.patch.yml"

Write-Host "== plugin-session-delete install =="
Write-Host "  DSH_HOME : $DshHome"
Write-Host "  pkg dir  : $pkgDir"

if (-not (Test-Path $profile)) { throw "profile dir not found: $profile" }

# 1) 复制包文件
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
foreach ($name in @("package.json", "index.js", "client.js")) {
  Copy-Item (Join-Path $src $name) (Join-Path $pkgDir $name) -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $pkgDir "scripts") | Out-Null
Copy-Item (Join-Path $src "scripts\patch-workspace-menu.mjs") (Join-Path $pkgDir "scripts") -Force
Write-Host "  copied package files"

# 2) 打补丁（幂等；锚点不匹配会明确报错，不写坏文件）
$patchCli = Join-Path $pkgDir "scripts\patch-workspace-menu.mjs"
$out = & node $patchCli apply 2>&1
$out | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { throw "patch apply failed" }

# 3) cordis.patch.yml 注册条目（幂等；通用锚点：插在顶层 `- insert:` 之后）
if (-not (Test-Path $patchYml)) { throw "cordis.patch.yml not found: $patchYml" }
$content = Get-Content $patchYml -Raw
$eol = if ($content -match "`r`n") { "`r`n" } else { "`n" }
$entry = "    - id: plugin-session-delete$eol      name: dsh-profile-plugin-session-delete$eol      disabled: false"
if ($content -match "(?m)^\s*- id:\s*plugin-session-delete\s*$") {
  Write-Host "  cordis.patch.yml: entry already present"
} else {
  if ($content -match "(?m)^- insert:") {
    $content = $content -replace "(?m)^(- insert:[^\r\n]*)$", "`$1$eol$entry"
    Set-Content -Path $patchYml -Value $content -NoNewline -Encoding utf8
    Write-Host "  cordis.patch.yml: entry added"
  } else {
    Write-Host "  cordis.patch.yml: no top-level `"- insert:`" list; add manually:"
    Write-Host $entry
  }
}

Write-Host "== done =="
Write-Host "  1) 重启 dsh（host 半加载需要重启）；"
Write-Host "  2) 刷新页面，标题栏应出现 [垃圾桶] 删除按钮。"

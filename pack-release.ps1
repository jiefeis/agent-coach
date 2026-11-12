# 一键生成 WorkBuddy v1.13 安装包与 SHA256SUMS.txt（在本地 agent-coach 仓库根目录运行）
$ErrorActionPreference = "Stop"
$Ver = "v1.13"
$Date = "20261112"
$OutDir = "releases\$Ver"
$ZipPath = "$OutDir\agent-coach-$Ver-$Date.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

$Include = @("AGENTS.md", "CLAUDE.md", "README.md", "SKILL.md", "LICENSE", "做法", "工具", "模板", "讲解")
Compress-Archive -Path $Include -DestinationPath $ZipPath -CompressionLevel Optimal

$Hash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLower()
"$Hash  agent-coach-$Ver-$Date.zip" | Out-File -Encoding utf8 "$OutDir\SHA256SUMS.txt"

Write-Host "已生成: $ZipPath"
Write-Host "SHA256: $Hash"

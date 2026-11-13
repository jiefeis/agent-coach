# 从任意目录运行脚本，生成仓库 releases\v1.20 下的安装包与校验清单。
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $RepoRoot 'releases\v1.20'
$ZipName = 'agent-coach-v1.20-20261112.zip'
$ZipPath = Join-Path $OutDir $ZipName
$SumPath = Join-Path $OutDir 'SHA256SUMS.txt'
$Include = @('AGENTS.md', 'CLAUDE.md', 'README.md', 'SKILL.md', 'LICENSE', '做法', '工具', '模板', '讲解')

Add-Type -AssemblyName System.IO.Compression.FileSystem
[void][IO.Directory]::CreateDirectory($OutDir)
$TempZip = Join-Path $OutDir ([Guid]::NewGuid().ToString('N') + '.zip')
$TempSum = "$TempZip.sha256"
try {
    $Archive = [IO.Compression.ZipFile]::Open($TempZip, 'Create')
    try {
        foreach ($Name in $Include) {
            $Item = Get-Item -LiteralPath (Join-Path $RepoRoot $Name)
            $Files = if ($Item.PSIsContainer) { Get-ChildItem -LiteralPath $Item.FullName -Recurse -File } else { $Item }
            foreach ($File in $Files) {
                # 打包工具用于维护仓库，技能包只带运行时文件。
                if ($File.FullName -eq $PSCommandPath) { continue }
                $Entry = $File.FullName.Substring($RepoRoot.Length + 1).Replace('\', '/')
                if ($Entry -eq 'LICENSE') { $Entry = 'LICENSE.md' }
                if ($Entry -eq 'README.md') {
                    # 仓库许可证叫 LICENSE，安装包使用 SkillHub 接受的 Markdown 文件名。
                    $Readme = [IO.File]::ReadAllText($File.FullName).Replace("`r`n", "`n").Replace('](LICENSE)', '](LICENSE.md)')
                    $Member = $Archive.CreateEntry($Entry, 'Optimal')
                    $Member.LastWriteTime = $File.LastWriteTime
                    $Writer = [IO.StreamWriter]::new($Member.Open(), [Text.UTF8Encoding]::new($false))
                    try { $Writer.Write($Readme) } finally { $Writer.Dispose() }
                    continue
                }
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $File.FullName, $Entry, 'Optimal')
            }
        }
    } finally {
        $Archive.Dispose()
    }

    $Hash = (Get-FileHash -LiteralPath $TempZip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($TempSum, "$Hash  $ZipName" + [char]10, [Text.Encoding]::ASCII)
    Move-Item -LiteralPath $TempZip -Destination $ZipPath -Force
    Move-Item -LiteralPath $TempSum -Destination $SumPath -Force
    Write-Host "已生成 $ZipPath"
    Write-Host "SHA256 $Hash"
} finally {
    foreach ($TempFile in @($TempZip, $TempSum)) {
        if (Test-Path -LiteralPath $TempFile -PathType Leaf) { Remove-Item -LiteralPath $TempFile }
    }
}

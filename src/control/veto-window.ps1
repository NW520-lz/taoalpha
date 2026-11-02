# ADR-012 local veto window. Reads one card view as JSON on stdin and writes one JSON event per line:
# shown (on screen), then rejected (button), closed (window closed by the user) or elapsed (countdown ended).
# The countdown is display only; the backend's recorded display time decides when the window ends.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Send-Event([string]$name) { [Console]::Out.WriteLine('{"event":"' + $name + '"}'); [Console]::Out.Flush() }

$card = [Console]::In.ReadToEnd() | ConvertFrom-Json
$seconds = [int]$card.seconds
if ($seconds -lt 1 -or $seconds -gt 86400) { exit 2 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'TaoAlpha 交易卡否决窗'
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(560, 420)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = [string]$card.title
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$title.SetBounds(16, 12, 520, 30)
$form.Controls.Add($title)

$body = New-Object System.Windows.Forms.Label
$body.Text = (@($card.lines) -join "`r`n")
$body.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$body.SetBounds(16, 48, 520, 220)
$form.Controls.Add($body)

$countdown = New-Object System.Windows.Forms.Label
$countdown.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$countdown.SetBounds(16, 280, 520, 26)
$form.Controls.Add($countdown)

$reject = New-Object System.Windows.Forms.Button
$reject.Text = '拒绝执行'
$reject.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$reject.SetBounds(16, 316, 160, 44)
$form.Controls.Add($reject)

$script:remaining = $seconds
$script:decided = $false
function Update-Countdown { $countdown.Text = "不操作将于 $([math]::Floor($script:remaining / 60)) 分 $($script:remaining % 60) 秒后按常设授权执行（以后端记录为准）" }
Update-Countdown

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:remaining -= 1
  if ($script:remaining -le 0) { $timer.Stop(); $script:decided = $true; Send-Event 'elapsed'; $form.Close() } else { Update-Countdown }
})
$reject.Add_Click({ if (-not $script:decided) { $script:decided = $true; $timer.Stop(); Send-Event 'rejected'; $form.Close() } })
$form.Add_Shown({ $form.Activate(); Send-Event 'shown'; $timer.Start() })
$form.Add_FormClosing({ if (-not $script:decided) { $script:decided = $true; $timer.Stop(); Send-Event 'closed' } })
[System.Windows.Forms.Application]::Run($form)

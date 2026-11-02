# ADR-012 local veto window. ASCII only: every visible text arrives as UTF-8 JSON on stdin, so the file encoding
# PowerShell assumes cannot garble it. Writes one JSON event per line: shown (with the SHA-256 of the exact text
# put on screen), then rejected (button), closed (window closed by the user) or elapsed (countdown ended).
# The countdown is display only; the backend's recorded display time decides when the window ends.
$ErrorActionPreference = 'Stop'
function Send-Event([string]$json) { [Console]::Out.WriteLine($json); [Console]::Out.Flush() }

$stdin = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$stdin.CopyTo($buffer)
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$card = $utf8.GetString($buffer.ToArray()) | ConvertFrom-Json
$seconds = [int]$card.seconds
if ($seconds -lt 1 -or $seconds -gt 86400) { exit 2 }
$lines = @($card.lines | ForEach-Object { [string]$_ })
$texts = @([string]$card.title) + $lines + @([string]$card.labels.window, [string]$card.labels.reject, [string]$card.labels.countdown)
$sha = [System.Security.Cryptography.SHA256]::Create()
$digest = ($sha.ComputeHash($utf8.GetBytes(($texts -join "`n"))) | ForEach-Object { $_.ToString('x2') }) -join ''

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$font = 'Microsoft YaHei UI'
$form = New-Object System.Windows.Forms.Form
$form.Text = [string]$card.labels.window
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(580, 430)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = [string]$card.title
$title.Font = New-Object System.Drawing.Font($font, 12, [System.Drawing.FontStyle]::Bold)
$title.SetBounds(16, 12, 540, 30)
$form.Controls.Add($title)

$body = New-Object System.Windows.Forms.Label
$body.Text = ($lines -join "`r`n")
$body.Font = New-Object System.Drawing.Font($font, 10)
$body.SetBounds(16, 48, 540, 220)
$form.Controls.Add($body)

$countdown = New-Object System.Windows.Forms.Label
$countdown.Font = New-Object System.Drawing.Font($font, 11)
$countdown.SetBounds(16, 280, 540, 26)
$form.Controls.Add($countdown)

$reject = New-Object System.Windows.Forms.Button
$reject.Text = [string]$card.labels.reject
$reject.Font = New-Object System.Drawing.Font($font, 11, [System.Drawing.FontStyle]::Bold)
$reject.SetBounds(16, 316, 160, 44)
$form.Controls.Add($reject)

$script:remaining = $seconds
$script:decided = $false
function Update-Countdown {
  $countdown.Text = ([string]$card.labels.countdown).Replace('{m}', [string][math]::Floor($script:remaining / 60)).Replace('{s}', [string]($script:remaining % 60))
}
Update-Countdown

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:remaining -= 1
  if ($script:remaining -le 0) { $timer.Stop(); $script:decided = $true; Send-Event '{"event":"elapsed"}'; $form.Close() } else { Update-Countdown }
})
$reject.Add_Click({ if (-not $script:decided) { $script:decided = $true; $timer.Stop(); Send-Event '{"event":"rejected"}'; $form.Close() } })
$form.Add_Shown({ $form.Activate(); Send-Event ('{"event":"shown","textSha256":"' + $digest + '"}'); $timer.Start() })
$form.Add_FormClosing({ if (-not $script:decided) { $script:decided = $true; $timer.Stop(); Send-Event '{"event":"closed"}' } })
[System.Windows.Forms.Application]::Run($form)

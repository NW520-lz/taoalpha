param([ValidateSet('Check', 'Review')][string]$Mode = 'Check')

# This fixed local helper owns the review window and Windows verification call.
# Never print the incoming content, user identity, system diagnostics, or exceptions.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$taskChallenge = ''

function Write-SafeResult([string]$Status) {
    if ($Mode -eq 'Review') {
        [Console]::WriteLine((@{ status = $Status; challenge = $taskChallenge } | ConvertTo-Json -Compress))
    } else {
        [Console]::WriteLine((@{ status = $Status } | ConvertTo-Json -Compress))
    }
}

function Wait-WinRt($Operation, [Type]$ResultType) {
    $taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
    $taskAwaitable = $taskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $taskAwaitable.Wait()
    return $taskAwaitable.Result
}

try {
    if ($Mode -eq 'Review') {
        [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
        $taskInput = [Console]::In.ReadToEnd()
        if ([Text.Encoding]::UTF8.GetByteCount($taskInput) -gt 131072) { throw 'Invalid request' }
        $taskRequest = $taskInput | ConvertFrom-Json
        if (($taskRequest.PSObject.Properties.Name | Sort-Object) -join ',' -ne 'challenge,displayText,expiresAt,subjectHash') { throw 'Invalid request' }
        if ($taskRequest.challenge -cnotmatch '^[a-f0-9]{64}$' -or $taskRequest.subjectHash -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid request' }
        $taskChallenge = $taskRequest.challenge
        if ($taskRequest.displayText -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($taskRequest.displayText) -gt 65536) { throw 'Invalid request' }
        $taskDeadline = [DateTimeOffset]::Parse($taskRequest.expiresAt)
        if ($taskDeadline -le [DateTimeOffset]::UtcNow) { Write-SafeResult 'timeout'; exit 0 }
    }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $taskVerifier = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
    $taskAvailableType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
    $taskAvailable = Wait-WinRt ($taskVerifier::CheckAvailabilityAsync()) $taskAvailableType
    if ($taskAvailable.ToString() -ne 'Available') { Write-SafeResult 'unavailable'; exit 0 }
    if ($Mode -eq 'Check') { Write-SafeResult 'available'; exit 0 }

    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    $taskWindow = New-Object Windows.Window
    $taskWindow.Title = 'TaoAlpha - Review and confirm'
    $taskWindow.Width = 850
    $taskWindow.Height = 680
    $taskWindow.WindowStartupLocation = 'CenterScreen'
    $taskWindow.Topmost = $true
    $taskPanel = New-Object Windows.Controls.DockPanel
    $taskPanel.Margin = '16'
    $taskWindow.Content = $taskPanel
    $taskHeader = New-Object Windows.Controls.TextBlock
    $taskHeader.Text = "Review the complete frozen content below. Confirming also requires Windows verification.`nSHA-256: $($taskRequest.subjectHash)`nExpires: $($taskRequest.expiresAt)"
    $taskHeader.TextWrapping = 'Wrap'
    $taskHeader.Margin = '0,0,0,12'
    [Windows.Controls.DockPanel]::SetDock($taskHeader, 'Top')
    [void]$taskPanel.Children.Add($taskHeader)
    $taskButtons = New-Object Windows.Controls.StackPanel
    $taskButtons.Orientation = 'Horizontal'
    $taskButtons.HorizontalAlignment = 'Right'
    [Windows.Controls.DockPanel]::SetDock($taskButtons, 'Bottom')
    [void]$taskPanel.Children.Add($taskButtons)
    $taskReject = New-Object Windows.Controls.Button
    $taskReject.Content = 'Reject'
    $taskReject.Width = 110
    $taskReject.Margin = '8'
    $taskApprove = New-Object Windows.Controls.Button
    $taskApprove.Content = 'Confirm with Windows'
    $taskApprove.Width = 200
    $taskApprove.Margin = '8'
    [void]$taskButtons.Children.Add($taskReject)
    [void]$taskButtons.Children.Add($taskApprove)
    $taskText = New-Object Windows.Controls.TextBox
    $taskText.IsReadOnly = $true
    $taskText.TextWrapping = 'Wrap'
    $taskText.VerticalScrollBarVisibility = 'Auto'
    $taskText.FontFamily = 'Consolas'
    $taskText.FontSize = 14
    $taskText.Text = $taskRequest.displayText
    [void]$taskPanel.Children.Add($taskText)
    $script:taskDecision = 'denied'
    $taskReject.Add_Click({ $script:taskDecision = 'denied'; $taskWindow.Close() })
    $taskApprove.Add_Click({ $script:taskDecision = 'reviewed'; $taskWindow.Close() })
    [void]$taskWindow.ShowDialog()
    if ($taskDeadline -le [DateTimeOffset]::UtcNow) { Write-SafeResult 'timeout'; exit 0 }
    if ($script:taskDecision -ne 'reviewed') { Write-SafeResult 'denied'; exit 0 }
    $taskVerificationType = [Windows.Security.Credentials.UI.UserConsentVerificationResult,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
    $taskResult = Wait-WinRt ($taskVerifier::RequestVerificationAsync("TaoAlpha confirmation SHA-256: $($taskRequest.subjectHash)")) $taskVerificationType
    if ($taskDeadline -le [DateTimeOffset]::UtcNow) { Write-SafeResult 'timeout'; exit 0 }
    if ($taskResult.ToString() -eq 'Verified') { Write-SafeResult 'verified' } else { Write-SafeResult 'denied' }
} catch {
    Write-SafeResult 'unavailable'
}

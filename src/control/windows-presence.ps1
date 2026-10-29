param([ValidateSet('Check', 'Review', 'Probe')][string]$Mode = 'Check')

# This fixed local helper owns the review window and Windows verification call.
# Never print the incoming content, user identity, system diagnostics, or exceptions.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$taskChallenge = ''
$taskDesktop = $null
$taskTimer = $null
$taskWindow = $null
$script:taskWindowClosed = $false
$script:taskOperation = $null
$script:taskPending = $null

function Write-SafeResult([string]$Status) {
    if ($Mode -eq 'Review') {
        [Console]::WriteLine((@{ status = $Status; challenge = $taskChallenge } | ConvertTo-Json -Compress))
    } else {
        [Console]::WriteLine((@{ status = $Status } | ConvertTo-Json -Compress))
    }
}

function Convert-WinRtTask($Operation, [Type]$ResultType) {
    $taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
    return $taskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
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
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-consent-interop.cs')
    $taskDesktop = New-Object TaoAlpha.Native.DesktopConsent
    $taskVerificationType = [Windows.Security.Credentials.UI.UserConsentVerificationResult,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
    $taskOperationType = [Windows.Foundation.IAsyncOperation``1,Windows.Foundation,ContentType=WindowsRuntime].MakeGenericType($taskVerificationType)
    if ($taskOperationType.GUID -ne [TaoAlpha.Native.DesktopConsent]::ResultInterfaceId) { throw 'Unsupported result interface' }
    if ($Mode -eq 'Probe') {
        # Only a zero HWND is passed: the production guard rejects it before any
        # native consent request. Never create a window or request user presence.
        $taskInvalidRejected = $false
        try { [void]$taskDesktop.RequestVerification([IntPtr]::Zero, 'TaoAlpha noninteractive probe') }
        catch { $taskInvalidRejected = $_.Exception.InnerException -is [ArgumentException] }
        if (-not $taskInvalidRejected) { throw 'Invalid owner was not rejected' }
        [Console]::WriteLine('{"status":"ready","factoryActivated":true,"invalidWindowRejected":true}')
        exit 0
    }
    $taskVerifier = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
    $taskAvailableType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
    $taskAvailability = Convert-WinRtTask ($taskVerifier::CheckAvailabilityAsync()) $taskAvailableType
    $taskAvailability.Wait()
    $taskAvailable = $taskAvailability.Result
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
    $taskApprove.Add_Click({
        try {
            if ($taskDeadline -le [DateTimeOffset]::UtcNow) { $script:taskDecision = 'timeout'; $taskWindow.Close(); return }
            $taskApprove.IsEnabled = $false
            $taskOwner = (New-Object Windows.Interop.WindowInteropHelper($taskWindow)).Handle
            $script:taskOperation = $taskDesktop.RequestVerification($taskOwner, "TaoAlpha confirmation SHA-256: $($taskRequest.subjectHash)")
            $script:taskPending = Convert-WinRtTask $script:taskOperation $taskVerificationType
        } catch { $script:taskDecision = 'unavailable'; $taskWindow.Close() }
    })
    # ShowDialog runs the dispatcher. Poll completed work instead of blocking the
    # STA thread on Task.Wait/Result; the owner remains alive during native UI.
    $taskTimer = New-Object Windows.Threading.DispatcherTimer
    $taskTimer.Interval = [TimeSpan]::FromMilliseconds(100)
    $taskTimer.Add_Tick({
        if ($taskDeadline -le [DateTimeOffset]::UtcNow) { $script:taskDecision = 'timeout'; $taskWindow.Close(); return }
        if ($null -ne $script:taskPending -and $script:taskPending.IsCompleted) {
            try {
                if ($script:taskPending.IsCanceled -or $script:taskPending.IsFaulted) { $script:taskDecision = 'unavailable' }
                elseif ($script:taskPending.Result.ToString() -eq 'Verified') { $script:taskDecision = 'verified' }
                else { $script:taskDecision = 'denied' }
            } catch { $script:taskDecision = 'unavailable' }
            $taskWindow.Close()
        }
    })
    $taskWindow.Add_Closed({
        $script:taskWindowClosed = $true
        $taskTimer.Stop()
        if ($null -ne $script:taskOperation) {
            try { ([Windows.Foundation.IAsyncInfo,Windows.Foundation,ContentType=WindowsRuntime]$script:taskOperation).Cancel() } catch { }
        }
    })
    $taskTimer.Start()
    [void]$taskWindow.ShowDialog()
    if ($taskDeadline -le [DateTimeOffset]::UtcNow) { Write-SafeResult 'timeout'; exit 0 }
    Write-SafeResult $script:taskDecision
} catch {
    Write-SafeResult 'unavailable'
} finally {
    if ($null -ne $taskTimer) { $taskTimer.Stop() }
    if ($null -ne $taskWindow -and -not $script:taskWindowClosed) { try { $taskWindow.Close() } catch { } }
    if ($null -ne $script:taskOperation) {
        try { ([Windows.Foundation.IAsyncInfo,Windows.Foundation,ContentType=WindowsRuntime]$script:taskOperation).Close() } catch { }
    }
    if ($null -ne $taskDesktop) { $taskDesktop.Dispose() }
}

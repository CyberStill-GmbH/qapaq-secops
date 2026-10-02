[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$collector = [Uri]'http://127.0.0.1:4318'
$loki = [Uri]'http://127.0.0.1:3100'
$prometheus = [Uri]'http://127.0.0.1:9090'
$grafana = [Uri]'http://127.0.0.1:3001'
$endpoints = @($collector, $loki, $prometheus, $grafana)
if ($endpoints | Where-Object { -not $_.IsLoopback -or $_.Scheme -ne 'http' }) {
    throw 'C15_SMOKE_REQUIRES_HTTP_LOOPBACK_ENDPOINTS'
}

$serviceName = 'qapaq-c15-smoke'
$nowUnixNano = [string]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000)
$resource = @{
    attributes = @(@{ key = 'service.name'; value = @{ stringValue = $serviceName } })
}
$logPayload = @{
    resourceLogs = @(@{
        resource = $resource
        scopeLogs = @(@{
            scope = @{ name = 'qapaq-c15-smoke' }
            logRecords = @(@{
                timeUnixNano = $nowUnixNano
                severityNumber = 9
                severityText = 'INFO'
                body = @{ stringValue = 'synthetic local observability smoke event' }
            })
        })
    })
} | ConvertTo-Json -Depth 20 -Compress
$metricPayload = @{
    resourceMetrics = @(@{
        resource = $resource
        scopeMetrics = @(@{
            scope = @{ name = 'qapaq-c15-smoke' }
            metrics = @(@{
                name = 'qapaq_c15_smoke_check'
                unit = '1'
                gauge = @{ dataPoints = @(@{ timeUnixNano = $nowUnixNano; asDouble = 1 }) }
            })
        })
    })
} | ConvertTo-Json -Depth 20 -Compress

try {
    # Compose may report Loki as started before its single-node ingester ring is
    # ready. Wait for Loki's own readiness endpoint before sending OTLP data.
    $stage = 'loki-readiness'
    $lokiReadyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    $lokiReady = $false
    do {
        try {
            $readiness = Invoke-WebRequest -Uri "$($loki.AbsoluteUri)ready" -TimeoutSec 3
            if ($readiness.StatusCode -eq 200 -and $readiness.Content.Trim() -eq 'ready') {
                $lokiReady = $true
                break
            }
        } catch {
            # Startup commonly returns HTTP 503 until the in-memory ring forms.
        }
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $lokiReadyDeadline)
    if (-not $lokiReady) {
        throw 'C15_LOKI_READINESS_TIMEOUT endpoint=/ready timeoutSeconds=60'
    }

    $stage = 'otlp-logs'
    Invoke-RestMethod -Method Post -Uri "$($collector.AbsoluteUri)v1/logs" `
        -ContentType 'application/json' -Body $logPayload -TimeoutSec 10 | Out-Null
    $stage = 'otlp-metrics'
    Invoke-RestMethod -Method Post -Uri "$($collector.AbsoluteUri)v1/metrics" `
        -ContentType 'application/json' -Body $metricPayload -TimeoutSec 10 | Out-Null

    $lokiQuery = [Uri]::EscapeDataString("{service_name=`"$serviceName`"}")
    $lokiHeaders = @{ 'X-Scope-OrgID' = 'qapaq-local' }
    $prometheusQuery = [Uri]::EscapeDataString('qapaq_c15_smoke_check_ratio')
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    $lokiResult = $null
    $metricResult = $null
    do {
        $stage = 'query-loki'
        $lokiResult = Invoke-RestMethod -Uri "$($loki.AbsoluteUri)loki/api/v1/query_range?query=$lokiQuery&since=5m&limit=5" `
            -Headers $lokiHeaders -TimeoutSec 10
        $stage = 'query-prometheus'
        $metricResult = Invoke-RestMethod -Uri "$($prometheus.AbsoluteUri)api/v1/query?query=$prometheusQuery" `
            -TimeoutSec 10
        if (@($lokiResult.data.result).Count -gt 0 -and @($metricResult.data.result).Count -gt 0) { break }
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    $stage = 'prometheus-targets'
    $targets = Invoke-RestMethod -Uri "$($prometheus.AbsoluteUri)api/v1/targets" -TimeoutSec 10
    $activeTargets = @($targets.data.activeTargets)
    $healthyTargets = @($activeTargets | Where-Object { $_.health -eq 'up' }).Count
    $stage = 'grafana-health'
    $grafanaHealth = Invoke-RestMethod -Uri "$($grafana.AbsoluteUri)api/health" -TimeoutSec 10
    $stage = 'assertions'
    if (
        @($lokiResult.data.result).Count -lt 1 -or
        @($metricResult.data.result).Count -lt 1 -or
        $activeTargets.Count -lt 2 -or
        $healthyTargets -ne $activeTargets.Count -or
        $grafanaHealth.database -ne 'ok'
    ) {
        $lokiCount = @($lokiResult.data.result).Count
        $metricCount = @($metricResult.data.result).Count
        $grafanaState = [string]$grafanaHealth.database
        throw "C15_SMOKE_ASSERTION_FAILED lokiStreams=$lokiCount metricSeries=$metricCount targets=$healthyTargets/$($activeTargets.Count) grafana=$grafanaState"
    }

    [pscustomobject]@{
        result = 'PASS'
        grafana = 'healthy'
        prometheusTargets = "$healthyTargets/$($activeTargets.Count) up"
        otlpLogsToLoki = "PASS ($(@($lokiResult.data.result).Count) stream)"
        otlpMetricsToPrometheus = "PASS ($(@($metricResult.data.result).Count) series)"
        payload = 'synthetic; no provider data, secrets, or PII'
    } | ConvertTo-Json -Compress
} catch {
    $errorType = $_.Exception.GetType().Name
    $safeMessage = $_.Exception.Message -replace '(?i)(token|password|secret|authorization)([=:\s]+)[^\s,;]+', '$1$2[REDACTED]'
    if ($safeMessage.Length -gt 200) { $safeMessage = $safeMessage.Substring(0, 200) }
    throw "C15_OBSERVABILITY_SMOKE_FAILED stage=$stage errorType=$errorType message=$safeMessage"
}

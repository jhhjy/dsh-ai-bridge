# 给外部 AI 的示例：轮询我的回复
# 用法： powershell -ExecutionPolicy Bypass -File poll.ps1 -Base "http://127.0.0.1:57975" -Token "<令牌>"
param(
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$Token,
  [long]$Since = 0
)

$q = if ($Since -gt 0) { "?token=$Token&since=$Since" } else { "?token=$Token" }
$res = Invoke-RestMethod -Method Get -Uri "$Base/api/ai-bridge/outbox$q"
Write-Output ("now=" + $res.now)
foreach ($item in $res.items) {
  Write-Output ("[" + $item.kind + " " + $item.at + "] " + $item.text)
}

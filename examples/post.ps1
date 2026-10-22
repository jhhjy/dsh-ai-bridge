# 给外部 AI 的示例：发一条提示词进 DSH 会话
# 用法： powershell -ExecutionPolicy Bypass -File post.ps1 -Base "http://127.0.0.1:57975" -Token "<令牌>" -Text "帮我看下这个报错"
param(
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$From = "外部 AI"
)

$json = @{ from = $From; text = $Text } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$res = Invoke-RestMethod -Method Post -Uri "$Base/api/ai-bridge/post" `
  -Headers @{ "x-bridge-token" = $Token } `
  -ContentType "application/json; charset=utf-8" -Body $bytes
$res | ConvertTo-Json -Compress

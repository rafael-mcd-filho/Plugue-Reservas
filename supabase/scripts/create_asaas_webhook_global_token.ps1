param(
  [string]$ProjectRef = "hdpxqqiudiotanrybvcf",
  [string]$Token = "",
  [int]$Bytes = 32,
  [switch]$SetSecret,
  [switch]$DeploySystemHealth
)

$ErrorActionPreference = "Stop"

if ($Bytes -lt 16) {
  throw "Bytes must be at least 16."
}

function New-HexToken {
  param([int]$Size)

  $buffer = [byte[]]::new($Size)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
    return [System.BitConverter]::ToString($buffer).Replace("-", "").ToLowerInvariant()
  } finally {
    $rng.Dispose()
  }
}

function Invoke-SupabaseCli {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  $supabaseCommand = Get-Command supabase -ErrorAction SilentlyContinue
  if ($supabaseCommand) {
    & supabase @Arguments
    return
  }

  $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
  if ($npxCommand) {
    & npx supabase@latest @Arguments
    return
  }

  throw "Supabase CLI was not found. Install Supabase CLI or Node.js/npm so this script can run npx supabase@latest."
}

if ([string]::IsNullOrWhiteSpace($Token)) {
  $Token = New-HexToken -Size $Bytes
}

Write-Host ""
Write-Host "ASAAS_WEBHOOK_AUTH_TOKEN:"
Write-Host $Token
Write-Host ""
Write-Host "Use this URL in the shared Asaas account webhook:"
Write-Host "https://$ProjectRef.supabase.co/functions/v1/asaas-webhook"
Write-Host ""
Write-Host "Use this header/token in Asaas:"
Write-Host "Header: asaas-access-token"
Write-Host "Token:  $Token"
Write-Host ""

if ($SetSecret) {
  Write-Host "Setting Supabase secret ASAAS_WEBHOOK_AUTH_TOKEN for project $ProjectRef..."
  Invoke-SupabaseCli secrets set "ASAAS_WEBHOOK_AUTH_TOKEN=$Token" --project-ref $ProjectRef

  if ($DeploySystemHealth) {
    Write-Host "Deploying system-health so the superadmin panel can show the token..."
    Invoke-SupabaseCli functions deploy system-health --project-ref $ProjectRef
  }
} else {
  Write-Host "To save it in Supabase, run:"
  Write-Host "npx supabase@latest secrets set `"ASAAS_WEBHOOK_AUTH_TOKEN=$Token`" --project-ref $ProjectRef"
  Write-Host ""
  Write-Host "Then deploy the superadmin health function:"
  Write-Host "npx supabase@latest functions deploy system-health --project-ref $ProjectRef"
}

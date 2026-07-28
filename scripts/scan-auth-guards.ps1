# Scan all HTML pages for auth protection and missing auth-guard.js
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$missingAuthGuard = @()
$missingRoleGuard = @()
Get-ChildItem -Path $root\.. -Recurse -Filter '*.html' | Where-Object { $_.FullName -notmatch '\\\.' } | ForEach-Object {
    $content = Get-Content -Path $_.FullName -Raw
    $hasAuthRequire = $content -match 'data-require-auth="true"'
    $hasRoleRequire = $content -match 'data-require-role="[^"]+"'
    $hasAuthGuard = $content -match 'src="auth-guard\.js"'
    if ($hasAuthRequire -and -not $hasAuthGuard) {
        $missingAuthGuard += $_.FullName
    }
    if ($hasRoleRequire -and -not $hasAuthGuard) {
        $missingRoleGuard += $_.FullName
    }
}
Write-Output '=== Missing auth-guard.js for data-require-auth=true ==='
if ($missingAuthGuard.Count -eq 0) { Write-Output 'NONE' } else { $missingAuthGuard | ForEach-Object { Write-Output $_ } }
Write-Output ''
Write-Output '=== Missing auth-guard.js for data-require-role=* ==='
if ($missingRoleGuard.Count -eq 0) { Write-Output 'NONE' } else { $missingRoleGuard | ForEach-Object { Write-Output $_ } }

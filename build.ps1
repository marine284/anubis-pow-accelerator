[CmdletBinding()]
param([string] $WslDistribution = 'NixOS')

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath($PSScriptRoot)
$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
$deno = (Get-Command deno -ErrorAction Stop).Source
$wslRoot = [string] (& $wsl -d $WslDistribution -- wslpath -a -u $root.Replace('\', '/'))
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($wslRoot)) {
    throw "Could not translate '$root' for WSL distribution '$WslDistribution'."
}
$wslRoot = $wslRoot.Trim()

Write-Host 'Building WebAssembly SIMD kernel...'
& $wsl -d $WslDistribution -- nix shell `
    nixpkgs#llvmPackages.clang-unwrapped `
    nixpkgs#llvmPackages.lld --command `
    clang --target=wasm32 -std=c11 -O3 -flto -msimd128 `
    -Wall -Wextra -Wpedantic -Werror -fno-exceptions -nostdlib `
    "$wslRoot/sha256_wasm.c" `
    '-Wl,--no-entry' '-Wl,--export-memory' `
    '-Wl,--export=input' '-Wl,--export=hash' `
    '-Wl,--export=prepare' '-Wl,--export=hash_nonce' `
    '-Wl,--export=search' '-Wl,--initial-memory=131072' `
    '-Wl,--max-memory=131072' '-Wl,--stack-first' '-Wl,--strip-all' `
    -o "$wslRoot/extension/sha256_wasm.wasm"
if ($LASTEXITCODE -ne 0) {
    throw "WebAssembly build failed with exit code $LASTEXITCODE."
}

Write-Host 'Running correctness tests...'
& $deno test --allow-read "$root\tests"
if ($LASTEXITCODE -ne 0) {
    throw "Tests failed with exit code $LASTEXITCODE."
}

Write-Host 'WebAssembly extension verified.'

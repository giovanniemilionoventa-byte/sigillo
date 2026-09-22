#!/usr/bin/env pwsh
# Runs the CV-screening demo on Windows via Docker Desktop — the same
# containers PROVA-LOCALE.md uses, in their own disposable project so this
# does not disturb a PROVA-LOCALE.md trial you may already have running.
# Leaves signer and server running afterwards so you can follow ISPEZIONE.md
# against them.

$ErrorActionPreference = "Stop"

$Demo = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $Demo "..\..")).Path
$Compose = Join-Path $Root "deploy\docker-compose.local.yml"
$Project = "sigillo-selezione-cv"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker Desktop non trovato nel PATH. Installalo da https://www.docker.com/products/docker-desktop/ e riprova."
    exit 1
}

$env:SIGILLO_LOCAL_PORT = if ($env:SIGILLO_DEMO_PORT) { $env:SIGILLO_DEMO_PORT } else { "8099" }
$env:SIGILLO_ADMIN_PASSWORD = if ($env:SIGILLO_ADMIN_PASSWORD) { $env:SIGILLO_ADMIN_PASSWORD } else { "demo-locale-non-usare-in-produzione" }
$env:SIGILLO_CHECKPOINT_MINUTES = "1000"
$Port = $env:SIGILLO_LOCAL_PORT
$BaseUrl = "http://127.0.0.1:$Port"

function Invoke-Compose {
    docker compose -p $Project -f $Compose @args
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($args -join ' ') è fallito (codice $LASTEXITCODE)"
    }
}

# A clean slate every time: this project name is used by nothing else, so
# there is nothing to lose, and it means the demo behaves the same way on a
# second run as on the first.
docker compose -p $Project -f $Compose down -v 2>$null | Out-Null

Write-Host "Costruisco le immagini (la prima volta richiede qualche minuto)..."
Invoke-Compose build signer server

Write-Host "Genero la chiave di firma..."
Invoke-Compose run --rm signer keygen --key /var/lib/sigillo-key/signer.key

Write-Host "Avvio firmatario e server..."
Invoke-Compose up -d signer server

Write-Host "Attendo che il server risponda su $BaseUrl ..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "$BaseUrl/healthz" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    Write-Error "Il server non ha risposto entro 30 secondi. Log:"
    docker compose -p $Project -f $Compose logs server
    exit 1
}

Write-Host "Creo il sistema e la chiave di accesso..."
Invoke-Compose exec -T server node dist/cli.js system create selezione-cv
$token = (Invoke-Compose exec -T server node dist/cli.js key create selezione-cv | Select-Object -Last 1).Trim()
if (-not $token) {
    throw "la creazione della chiave non ha restituito un codice"
}

Write-Host "Eseguo l'agente sulle 20 candidature..."
Invoke-Compose run --rm -e SIGILLO_API_KEY=$token selezione-cv

Write-Host "Genero un checkpoint con marca temporale..."
try {
    Invoke-Compose exec -T server node dist/cli.js checkpoint --tsa-url https://freetsa.org/tsr
} catch {
    Write-Warning "Non sono riuscito a raggiungere la marca temporale (freetsa.org); riprova più tardi con:"
    Write-Warning "  docker compose -p $Project -f `"$Compose`" exec server node dist/cli.js checkpoint --tsa-url https://freetsa.org/tsr"
}

Write-Host ""
Write-Host "Fatto: 20 candidature registrate nel sistema `"selezione-cv`"."
Write-Host ""
Write-Host "  Interfaccia:             $BaseUrl/ui"
Write-Host "  Password amministratore: $($env:SIGILLO_ADMIN_PASSWORD)"
Write-Host ""
Write-Host "Per fermare tutto quando hai finito:"
Write-Host "  docker compose -p $Project -f `"$Compose`" down -v"
Write-Host ""
Write-Host "Ora puoi seguire demo\selezione-cv\ISPEZIONE.md."

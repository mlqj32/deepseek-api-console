param(
    [string]$Prompt = "Say hello in Chinese.",
    [string]$Model = "deepseek-v4-pro"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

if (!(Test-Path ".\.venv\Scripts\python.exe")) {
    python -m venv .venv
}

.\.venv\Scripts\python.exe -c "import openai, dotenv" 2>$null
if ($LASTEXITCODE -ne 0) {
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

.\.venv\Scripts\python.exe .\src\chat.py $Prompt --model $Model
exit $LASTEXITCODE

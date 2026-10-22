param(
    [string]$DiscoRoot = 'E:\Disco',
    [string]$OpenVikingConfig = 'E:\Disco\data\openviking-config\ov.conf'
)

$ErrorActionPreference = 'Stop'
$knowledgeRoot = [System.IO.Path]::GetFullPath($DiscoRoot)
$knowledgeLogs = Join-Path $knowledgeRoot 'logs\knowledge'
$knowledgeCache = Join-Path $knowledgeRoot 'cache'
$ollamaExecutable = Join-Path $knowledgeRoot 'runtimes\ollama\ollama.exe'
$openVikingExecutable = Join-Path $knowledgeRoot 'runtimes\openviking\Scripts\openviking-server.exe'
foreach ($requiredFile in @($ollamaExecutable, $openVikingExecutable, $OpenVikingConfig)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Knowledge service file does not exist: $requiredFile"
    }
}
# OpenViking filesystem maintenance otherwise invokes its per-file LLM queue.
# Give the index process no VLM; the separately scheduled summary helper reads
# the operator's original config and makes one approved subscription completion.
$indexConfiguration = Get-Content -LiteralPath $OpenVikingConfig -Raw | ConvertFrom-Json
$indexConfiguration.vlm = [pscustomobject]@{}
$indexConfigurationPath = Join-Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($OpenVikingConfig))) 'index-only.conf'
if ([System.IO.Path]::GetFullPath($OpenVikingConfig) -eq $indexConfigurationPath) {
    throw 'The operator configuration must be separate from index-only.conf.'
}
[System.IO.File]::WriteAllText($indexConfigurationPath, ($indexConfiguration | ConvertTo-Json -Depth 64), [System.Text.UTF8Encoding]::new($false))
foreach ($directory in @($knowledgeLogs, (Join-Path $knowledgeRoot 'models\ollama'), (Join-Path $knowledgeCache 'tmp'), (Join-Path $knowledgeCache 'huggingface'), (Join-Path $knowledgeCache 'tiktoken'))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

function Start-KnowledgeService {
    param([int]$Port, [string]$Executable, [string[]]$Arguments, [string]$Name, [hashtable]$Environment)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $existingProcess = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
        $expectedDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Executable))
        $sameExecutableDirectory = $existingProcess.Path -and ([System.IO.Path]::GetFullPath($existingProcess.Path).StartsWith($expectedDirectory + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))
        # Windows venv console launchers start the base Python executable. Verify
        # its exact quoted launcher argument instead of assuming Scripts/python.
        $existingDetails = Get-CimInstance Win32_Process -Filter "ProcessId=$($existingProcess.Id)"
        $expectedLauncherArgument = '"' + [System.IO.Path]::GetFullPath($Executable) + '"'
        $samePythonLauncher = $existingProcess.ProcessName -eq 'python' -and $existingDetails.CommandLine -and $existingDetails.CommandLine.Contains($expectedLauncherArgument)
        if (-not $sameExecutableDirectory -and -not $samePythonLauncher) {
            throw "Port $Port belongs to a different process; refusing to replace it."
        }
        return [pscustomobject]@{ Service = $Name; ProcessId = $existingProcess.Id; Started = $false }
    }
    $previousEnvironment = @{}
    try {
        foreach ($entry in $Environment.GetEnumerator()) {
            $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
        $launchedProcess = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $knowledgeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $knowledgeLogs "$Name.stdout.log") -RedirectStandardError (Join-Path $knowledgeLogs "$Name.stderr.log") -PassThru
        return [pscustomobject]@{ Service = $Name; ProcessId = $launchedProcess.Id; Started = $true }
    } finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    }
}

Start-KnowledgeService -Port 11434 -Executable $ollamaExecutable -Arguments @('serve') -Name 'ollama' -Environment @{
    OLLAMA_HOST = '127.0.0.1:11434'
    OLLAMA_MODELS = (Join-Path $knowledgeRoot 'models\ollama')
    OLLAMA_NO_CLOUD = '1'
    OLLAMA_NUM_PARALLEL = '1'
    OLLAMA_MAX_LOADED_MODELS = '1'
    TEMP = (Join-Path $knowledgeCache 'tmp')
    TMP = (Join-Path $knowledgeCache 'tmp')
}

Start-KnowledgeService -Port 1933 -Executable $openVikingExecutable -Arguments @('--host', '127.0.0.1', '--port', '1933') -Name 'openviking' -Environment @{
    OPENVIKING_CONFIG_FILE = $indexConfigurationPath
    HF_HOME = (Join-Path $knowledgeCache 'huggingface')
    TIKTOKEN_CACHE_DIR = (Join-Path $knowledgeCache 'tiktoken')
    TEMP = (Join-Path $knowledgeCache 'tmp')
    TMP = (Join-Path $knowledgeCache 'tmp')
    PYTHONIOENCODING = 'utf-8'
    NO_PROXY = '127.0.0.1,localhost,::1'
}

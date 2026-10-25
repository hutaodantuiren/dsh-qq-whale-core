param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Language = 'zh-CN'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$culture = [System.Globalization.CultureInfo]::GetCultureInfo($Language)
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
try {
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToWaveFile($Path)
  $result = $engine.Recognize()
  if ($null -ne $result) { [Console]::WriteLine($result.Text) }
} finally {
  $engine.Dispose()
}

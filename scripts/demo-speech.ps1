param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice.Rate = -1
    $voice.SetOutputToWaveFile($OutputPath)
    $voice.Speak('Welcome to your independent clip studio. Here is a simple way to save time. Start with one clear idea, remove the long pauses, and add readable captions. Why does this matter? People watching without sound can still understand your story. Review every clip before sharing it. Your video and transcript stay on this computer unless you explicitly choose a connected provider.')
} finally {
    $voice.Dispose()
}

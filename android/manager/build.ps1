# Builds the FreshCart Manager app (com.freshcart.manager) — a WebView wrapper around
# https://daqa.me/admin. Same no-Gradle pipeline as the customer app.
# Run:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Continue"
$apk = $PSScriptRoot
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$jbr = "C:\Program Files\Android\Android Studio\jbr"
$bt  = "$sdk\build-tools\36.0.0"
$aj  = "$sdk\platforms\android-37.0\android.jar"
$env:JAVA_HOME = $jbr

Remove-Item "$apk\obj","$apk\stage" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$apk\obj","$apk\stage" | Out-Null

Write-Host "compile..."
& "$jbr\bin\javac.exe" --release 21 -classpath $aj -d "$apk\obj" "$apk\src\com\freshcart\manager\MainActivity.java"
Write-Host "dex..."
# dex EVERY .class (incl. the WebView's MainActivity$1 inner class) or the app crashes on launch
$classes = Get-ChildItem "$apk\obj" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$bt\d8.bat" --min-api 24 --lib $aj --output "$apk\stage" @classes
Write-Host "resources..."
& "$bt\aapt2.exe" compile --dir "$apk\res" -o "$apk\res-compiled.zip"
& "$bt\aapt2.exe" link -I $aj --manifest "$apk\AndroidManifest.xml" --min-sdk-version 24 --target-sdk-version 36 -o "$apk\base.apk" "$apk\res-compiled.zip"
Copy-Item "$apk\base.apk" "$apk\unsigned.apk" -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::Open("$apk\unsigned.apk","Update")
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,"$apk\stage\classes.dex","classes.dex") | Out-Null
$z.Dispose()
Write-Host "align + sign..."
& "$bt\zipalign.exe" -f 4 "$apk\unsigned.apk" "$apk\aligned.apk"
if (-not (Test-Path "$apk\debug.keystore")) {
  & "$jbr\bin\keytool.exe" -genkeypair -keystore "$apk\debug.keystore" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=FreshCart Manager,O=FreshCart,C=US" 2>&1 | Out-Null
}
& "$bt\apksigner.bat" sign --ks "$apk\debug.keystore" --ks-pass pass:android --key-pass pass:android --min-sdk-version 24 --out "$apk\manager.apk" "$apk\aligned.apk" 2>$null
Write-Host ("BUILT manager.apk  " + [math]::Round((Get-Item "$apk\manager.apk").Length/1KB,1) + " KB")

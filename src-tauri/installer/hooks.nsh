
!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec 'taskkill /F /IM jutil.exe'
  IfFileExists "$APPDATA\com.overclip.app\settings.json" +3 0
    IfFileExists "$APPDATA\com.jutil.app\*.*" 0 +2
      CopyFiles /SILENT "$APPDATA\com.jutil.app\*.*" "$APPDATA\com.overclip.app"
  IfFileExists "$LOCALAPPDATA\com.overclip.app\*.*" +3 0
    IfFileExists "$LOCALAPPDATA\com.jutil.app\*.*" 0 +2
      CopyFiles /SILENT "$LOCALAPPDATA\com.jutil.app\*.*" "$LOCALAPPDATA\com.overclip.app"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "jUtil"
  IfFileExists "$LOCALAPPDATA\jUtil\uninstall.exe" 0 +2
    ExecWait '"$LOCALAPPDATA\jUtil\uninstall.exe" /S'

  CreateDirectory "$APPDATA\com.overclip.app"
  FileOpen $0 "$APPDATA\com.overclip.app\run-setup" w
  FileWrite $0 "1"
  FileClose $0
!macroend

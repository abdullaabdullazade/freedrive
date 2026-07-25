; FreeDrive NSIS installer hooks — My Drive / CfAPI + AppData cleanup on uninstall.
; MAINBINARYNAME is defined by Tauri's installer.nsi (cargo binary name by default).
; App data lives in %APPDATA%\FreeDrive (not com.freedrive.desktop / BUNDLEID).
;
; $UpdateMode is 1 only when run with /UPDATE. Tauri also runs this uninstaller without
; /UPDATE when the user picks "Uninstall before installing" on the reinstall page, so
; deleting files additionally requires the explicit "Delete application data" choice.

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop a running client so CfAPI disconnect and file deletes can succeed.
  ExecWait 'taskkill /F /IM "${MAINBINARYNAME}.exe" /T'

  ; Exe still exists in $INSTDIR during PREUNINSTALL.
  ${If} $UpdateMode <> 1
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; Drop the Explorer sync root / nav pane entry; keeps user files and app data.
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-cleanup'
    ${If} $DeleteAppDataCheckboxState = 1
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-purge'
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; When "Delete application data" is checked, also remove FreeDrive AppData.
  ; (Tauri only deletes %APPDATA%\<BUNDLEID>; our data_dir is FreeDrive.)
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RmDir /r "$APPDATA\FreeDrive"
    RmDir /r "$LOCALAPPDATA\FreeDrive"
  ${EndIf}
!macroend

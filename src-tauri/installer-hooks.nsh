;; src-tauri/installer-hooks.nsh — Tauri 2 NSIS preinstall/postinstall hooks.
;;
;; #393 fix: the default Tauri 2 installer doesn't terminate a
;; running shellX before extracting the new shellx.exe. The uninstall step
;; removes the Start Menu shortcut (so the icon disappears mid-install)
;; but Windows file-lock skips the overwrite of shellx.exe because the
;; live process still holds it. The installer then reports "Install
;; Complete" while the on-disk binary stays at the previous build -
;; user reopens shellX and runs the SAME OLD binary again. This burned
;; multiple test cycles.
;;
;; The preinstall hook calls `taskkill /F /IM shellx.exe` and waits a
;; moment for handles to drop. The legacy `app.exe` name is still killed
;; because older local builds used it. Same for the preuninstall path so
;; that even a standalone uninstall doesn't trip the lock.
;;
;; `nsExec::ExecToLog` returns a non-zero exit code when no matching
;; process is found, which is harmless and expected on a first install —
;; we deliberately don't propagate that code.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "shellX: stopping any running shellx.exe before extract..."
  nsExec::ExecToLog 'taskkill /F /IM shellx.exe /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM app.exe /T'
  Pop $0
  ; 500 ms is enough for Windows to release the file handles after a
  ; forced taskkill; we've never seen the lock persist past this.
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfSilent shellx_file_handoff_done 0
  MessageBox MB_YESNO|MB_ICONQUESTION "Add 'Send to shellX' to Windows Explorer? This adds a right-click menu item and a SendTo shortcut so selected files can be attached to shellX." IDNO shellx_file_handoff_done
  DetailPrint "shellX: installing Windows Explorer file handoff..."
  WriteRegStr HKCU "Software\Classes\*\shell\shellX" "" "Send to shellX"
  WriteRegStr HKCU "Software\Classes\*\shell\shellX" "Icon" "$INSTDIR\shellx.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\shellX\command" "" '"$INSTDIR\shellx.exe" --attach "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\shellX" "" "Send to shellX"
  WriteRegStr HKCU "Software\Classes\Directory\shell\shellX" "Icon" "$INSTDIR\shellx.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\shellX\command" "" '"$INSTDIR\shellx.exe" --attach "%1"'
  CreateShortCut "$SENDTO\shellX.lnk" "$INSTDIR\shellx.exe" "--attach" "$INSTDIR\shellx.exe" 0 SW_SHOWNORMAL "" "Send selected file(s) to shellX"
  shellx_file_handoff_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "shellX: stopping any running shellx.exe before uninstall..."
  nsExec::ExecToLog 'taskkill /F /IM shellx.exe /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM app.exe /T'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "shellX: removing Windows Explorer file handoff..."
  DeleteRegKey HKCU "Software\Classes\*\shell\shellX"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\shellX"
  Delete "$SENDTO\shellX.lnk"
!macroend

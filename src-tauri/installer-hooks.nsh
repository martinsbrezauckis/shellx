;; src-tauri/installer-hooks.nsh — Tauri 2 NSIS preinstall/postinstall hooks.
;;
;; #393 fix: the default Tauri 2 installer doesn't terminate a
;; running shellX before extracting the new app.exe. The uninstall step
;; removes the Start Menu shortcut (so the icon disappears mid-install)
;; but Windows file-lock skips the overwrite of app.exe because the
;; live process still holds it. The installer then reports "Install
;; Complete" while the on-disk binary stays at the previous build —
;; user reopens shellX and runs the SAME OLD app.exe again. This burned
;; multiple test cycles.
;;
;; The preinstall hook calls `taskkill /F /IM app.exe` and waits a
;; moment for handles to drop. Same for the preuninstall path so that
;; even a standalone uninstall doesn't trip the lock.
;;
;; `nsExec::ExecToLog` returns a non-zero exit code when no matching
;; process is found, which is harmless and expected on a first install —
;; we deliberately don't propagate that code.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "shellX: stopping any running app.exe before extract..."
  nsExec::ExecToLog 'taskkill /F /IM app.exe /T'
  Pop $0
  ; 500 ms is enough for Windows to release the file handles after a
  ; forced taskkill; we've never seen the lock persist past this.
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "shellX: stopping any running app.exe before uninstall..."
  nsExec::ExecToLog 'taskkill /F /IM app.exe /T'
  Pop $0
  Sleep 500
!macroend

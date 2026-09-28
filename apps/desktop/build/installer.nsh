; AirDesk NSIS customisation.
; Creates the shared data folder and lets local users write to it (one company
; database shared by all Windows users of this PC). Uninstall never touches it:
; company data must survive uninstall/reinstall.

!macro customInstall
  ; With the "all users" shell context, $APPDATA is C:\ProgramData.
  SetShellVarContext all
  CreateDirectory "$APPDATA\AirDesk"
  nsExec::ExecToLog 'icacls "$APPDATA\AirDesk" /grant *S-1-5-32-545:(OI)(CI)M /T'
!macroend

!macro customUnInstall
  ; Intentionally empty: %ProgramData%\AirDesk (database + backups) is preserved.
!macroend

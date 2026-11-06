!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LocalSendPlus"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LocalSendPlus" dir=in action=allow protocol=TCP localport=53317 profile=any program="$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LocalSendPlus" dir=in action=allow protocol=UDP localport=53317 profile=any program="$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LocalSendPlus"'
!macroend

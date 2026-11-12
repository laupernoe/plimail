!macro customInstall
  WriteRegStr SHCTX "Software\RegisteredApplications" "Plimail" "Software\Clients\Mail\Plimail\Capabilities"

  WriteRegStr SHCTX "Software\Clients\Mail\Plimail" "" "Plimail"
  WriteRegStr SHCTX "Software\Clients\Mail\Plimail\Capabilities" "ApplicationName" "Plimail"
  WriteRegStr SHCTX "Software\Clients\Mail\Plimail\Capabilities" "ApplicationDescription" "A self-hosted, unified webmail client."
  WriteRegStr SHCTX "Software\Clients\Mail\Plimail\Capabilities\URLAssociations" "mailto" "Plimail.mailto"

  WriteRegStr SHCTX "Software\Classes\Plimail.mailto" "" "URL:Plimail MailTo Protocol"
  WriteRegStr SHCTX "Software\Classes\Plimail.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\Plimail.mailto\DefaultIcon" "" "$INSTDIR\Plimail.exe,0"
  WriteRegStr SHCTX "Software\Classes\Plimail.mailto\shell\open\command" "" '"$INSTDIR\Plimail.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Plimail"
  DeleteRegKey SHCTX "Software\Clients\Mail\Plimail"
  DeleteRegKey SHCTX "Software\Classes\Plimail.mailto"
!macroend

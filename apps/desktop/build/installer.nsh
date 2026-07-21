!macro customInstall
  CopyFiles /SILENT "$INSTDIR\TK Ads Automation.exe" "$INSTDIR\tk自动化后台程序.exe"
!macroend

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本机数据？选择是会删除文档和 AppData 中的 TK Ads Automation 数据、凭据与本机登录账户。" /SD IDNO IDYES removeLocalData
  Goto done

  removeLocalData:
    RMDir /r "$DOCUMENTS\TK Ads Automation"
    RMDir /r "$APPDATA\TK Ads Automation"

  done:
!macroend

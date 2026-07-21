Function .onVerifyInstDir
  StrCmp "$INSTDIR" "$LOCALAPPDATA\Programs\TK Ads Automation" done
  IfFileExists "$LOCALAPPDATA\Programs\TK Ads Automation\Uninstall TK Ads Automation.exe" 0 done
  MessageBox MB_YESNO|MB_ICONQUESTION "检测到原安装目录中的 TK Ads Automation。当前选择的是其他目录，是否先同步卸载原程序？选择“否”将返回安装目录页面。" /SD IDYES IDYES uninstallPrevious
  Abort

  uninstallPrevious:
    ExecWait '"$LOCALAPPDATA\Programs\TK Ads Automation\Uninstall TK Ads Automation.exe" /currentuser /S' $0
    StrCmp $0 0 done
    MessageBox MB_OK|MB_ICONEXCLAMATION "原程序未能自动卸载（退出码 $0）。请关闭原程序后重试。"
    Abort

  done:
FunctionEnd

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

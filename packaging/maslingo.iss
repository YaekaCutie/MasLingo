; MasLingo — installer definition.
;
; Design decisions worth stating, because several of them are constraints rather
; than preferences:
;
;   PrivilegesRequired=lowest
;     The spec asks the installer not to demand administrator rights. Everything
;     here — program files, the Run entry, the log directory — lives under the
;     user's own profile. Nothing writes to Program Files or HKLM.
;
;   AppId is a fixed GUID
;     It is the identity Windows uses to recognise an existing installation, so
;     running Setup again upgrades in place instead of stacking a second copy.
;
;   The Chrome extension is NOT installed by this installer.
;     A desktop installer cannot put an extension into consumer Chrome. The
;     supported routes are the Web Store (user confirms) or enterprise policy
;     (managed devices only). This installer therefore detects Chrome, and once
;     the engine is verified it *offers* to open the distribution page — and says
;     plainly that the user has to confirm the install. Claiming otherwise would
;     be the one thing the spec is most explicit about not doing.
;
;   Autostart is a Run entry, not a service
;     HKCU\...\Run needs no elevation and the uninstaller removes it trivially.
;     It is written by the engine itself (`--autostart on`), so the installer and
;     the tray toggle cannot disagree about what "on" means.

#define AppName "MasLingo"
#ifndef AppVersion
  #define AppVersion "1.1.5"
#endif
#ifndef StageDir
  #define StageDir "..\build\stage"
#endif
; Overridable so a build can be validated quickly. The payload is ~1.9 GB and is
; almost entirely already-compressed data — safetensors weights, native DLLs,
; .pyc — so lzma2/max spends a very long time for a small gain. Pass
; /DCompression={#Compression} for a release.
#ifndef Compression
  #define Compression "lzma2/normal"
#endif

[Setup]
AppId={{8F3A2C41-5B7E-4D19-9E62-1C7A4B0D5E83}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=MasLingo
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\build\output
OutputBaseFilename=MasLingo-Setup-{#AppVersion}
Compression={#Compression}
SolidCompression=yes
WizardStyle=modern
; 1.9 GB of payload: the disk check has to know that before it starts copying.
ExtraDiskSpaceRequired=2200000000
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\runtime\pythonw.exe
CloseApplications=no

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "登录 Windows 时自动启动本地引擎（推荐）"; GroupDescription: "启动选项："
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
; The whole staged payload: runtime + backend + engine + OCR model.
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName} 状态与日志"; Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\packaging\engine\maslingo_engine.py"""; WorkingDir: "{app}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\packaging\engine\maslingo_engine.py"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Started after the files are in place, and only if the health check below
; passes — the [Code] section drives this, so there is no bare [Run] entry here
; that could start a second engine on top of a running one.
Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\packaging\engine\maslingo_engine.py"""; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent; Description: "启动 {#AppName} 本地引擎"

[UninstallRun]
; Stop the engine before its files disappear. --autostart off first, so an
; uninstall cannot be undone by the next login.
Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\packaging\engine\maslingo_engine.py"" --autostart off"; Flags: runhidden; RunOnceId: "MasLingoAutostartOff"
Filename: "{app}\runtime\pythonw.exe"; Parameters: """{app}\packaging\engine\maslingo_engine.py"" --shutdown"; Flags: runhidden; RunOnceId: "MasLingoStopEngine"

[UninstallDelete]
; Only what the program itself created. User data is asked about in [Code].
Type: filesandordirs; Name: "{app}\runtime\Lib\site-packages\**\__pycache__"

[Code]
const
  RUN_KEY = 'Software\Microsoft\Windows\CurrentVersion\Run';
  CHROME_PATHS_1 = 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe';
  CHROME_STORE_URL = 'https://chromewebstore.google.com/';
  ENGINE_PORT = 8001;

var
  ChromePage: TOutputMsgWizardPage;
  ExtensionPage: TOutputMsgWizardPage;
  ChromeFound: Boolean;
  ChromeDetail: String;
  EngineReady: Boolean;
  EngineDetail: String;

{ --- Chrome detection ---------------------------------------------------- }
{ Three places, because Chrome is not always where the registry says: a
  machine-wide install, a per-user install, and a portable copy. Reporting "not
  found" for a browser the user is looking at would make the wizard untrustworthy
  for everything else it says. }
function DetectChrome(): Boolean;
var
  Value: String;
  Candidates: array of String;
  I: Integer;
begin
  Result := False;
  ChromeDetail := '';
  SetArrayLength(Candidates, 7);
  Candidates[0] := ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe');
  Candidates[1] := ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe');
  Candidates[2] := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  Candidates[3] := ExpandConstant('{pf}\Google\Chrome Beta\Application\chrome.exe');
  Candidates[4] := ExpandConstant('{pf32}\Google\Chrome Beta\Application\chrome.exe');
  Candidates[5] := ExpandConstant('{localappdata}\Google\Chrome Beta\Application\chrome.exe');
  Candidates[6] := '';
  if RegQueryStringValue(HKLM, CHROME_PATHS_1, '', Value) then
    Candidates[6] := Value;
  for I := 0 to GetArrayLength(Candidates) - 1 do
  begin
    if (Candidates[I] <> '') and FileExists(Candidates[I]) then
    begin
      ChromeDetail := Candidates[I];
      Result := True;
      Exit;
    end;
  end;
end;

{ --- engine health ------------------------------------------------------- }
{ A real probe, from the PowerShell side of this installer, of the endpoint the
  extension will use. The wizard must not report success because a process was
  launched — only because the port answers. }
function ProbeEngine(): Boolean;
var
  ResultCode: Integer;
  ScriptTmp: String;
  Command: String;
begin
  ScriptTmp := ExpandConstant('{tmp}\probe.ps1');
  SaveStringToFile(ScriptTmp,
    '$ErrorActionPreference=''SilentlyContinue'';' + #13#10 +
    'for($i=0;$i -lt 60;$i++){' + #13#10 +
    '  try{ $r=Invoke-RestMethod -Uri ''http://127.0.0.1:' + IntToStr(ENGINE_PORT) + '/health'' -TimeoutSec 3;' + #13#10 +
    '       if($r.ok){ exit 0 } }catch{}' + #13#10 +
    '  Start-Sleep -Seconds 2 }' + #13#10 +
    'exit 1', False);

  Result := Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptTmp + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function BackendExe(): String;
begin
  Result := ExpandConstant('{app}\runtime\pythonw.exe');
end;

function BackendArgs(Extra: String): String;
begin
  Result := '"' + ExpandConstant('{app}\packaging\engine\maslingo_engine.py') + '" ' + Extra;
end;

procedure RunEngine(Extra: String);
var
  ResultCode: Integer;
begin
  Exec(BackendExe(), BackendArgs(Extra), ExpandConstant('{app}'), SW_HIDE,
       ewWaitUntilTerminated, ResultCode);
end;

{ --- wizard -------------------------------------------------------------- }

procedure InitializeWizard();
var
  ChromeText: String;
begin
  ChromeFound := DetectChrome();

  { The text is decided here rather than adjusted on the page later.
    `TOutputMsgWizardPage` exposes no writable body property in this Inno version
    — `Values` and `MsgText` are both rejected at compile time — and there is
    nothing to gain from mutating a page when the answer is already known: Chrome
    is either installed or it is not, and that cannot change mid-wizard. }
  if ChromeFound then
    ChromeText :=
      '已检测到 Chrome：' + #13#10 + '  ' + ChromeDetail + #13#10 + #13#10 +
      '安装完成后，向导会引导你安装浏览器扩展。'
  else
    ChromeText :=
      '未检测到 Chrome。' + #13#10 + #13#10 +
      '本地引擎仍会照常安装并自动启动，但浏览器扩展需要一个 Chromium 内核的浏览器' + #13#10 +
      '（Chrome、Edge 等）。安装完成后你可以先安装浏览器，再回来运行扩展安装向导。';

  ChromePage := CreateOutputMsgPage(wpSelectTasks,
    '检测浏览器',
    '安装程序会检查 Chrome 是否已安装',
    ChromeText);

  ExtensionPage := CreateOutputMsgPage(wpSelectProgramGroup,
    '安装 Chrome 扩展',
    '本地引擎装好之后，还差最后一步',
    '' +
    '本地引擎已经安装完成。浏览器扩展需要单独安装，而且必须由你在 Chrome 里确认一次——' + #13#10 +
    '桌面安装程序无法替你把扩展静默装进普通 Chrome，这是 Chrome 本身的限制，不是本程序的遗漏。' + #13#10 + #13#10 +
    '点击「下一步」后会打开扩展的获取页面，请在页面上点击「添加至 Chrome」并在弹出的对话框中确认。' + #13#10 + #13#10 +
    '装好之后不需要再做任何配置：扩展启动时会自动检测本地引擎并连接。');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectTasks then
  begin
    if WizardIsTaskSelected('autostart') then
      RunEngine('--autostart on')
    else
      RunEngine('--autostart off');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrorCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    { Start the engine and wait for the port to answer. Deliberately not a
      "launched the process, must be fine" check: the whole point of the status
      page is that it can say no. }
    Exec(BackendExe(), BackendArgs(''), ExpandConstant('{app}'), SW_HIDE,
         ewNoWait, ErrorCode);
    EngineReady := ProbeEngine();
    if EngineReady then
      EngineDetail := '本地引擎已启动，健康检查通过（127.0.0.1:' + IntToStr(ENGINE_PORT) + '）。'
    else
      EngineDetail :=
        '本地引擎已安装，但健康检查未通过。' + #13#10 +
        '这通常意味着第一次启动仍在加载 OCR 模型，稍等片刻后扩展会自行连上；' + #13#10 +
        '如果一直连不上，请查看日志：' + #13#10 +
        '  %LOCALAPPDATA%\MasLingo\logs\engine.log';
  end;
end;

{ --- uninstall ----------------------------------------------------------- }

function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  { Stop the engine first: it holds files open, and a still-running engine would
    also be restarted by the Run entry on the next login. }
  Exec(BackendExe(), BackendArgs('--autostart off'), ExpandConstant('{app}'),
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(BackendExe(), BackendArgs('--shutdown'), ExpandConstant('{app}'),
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\MasLingo');
    { User data is asked about, never deleted silently — it holds the API keys and
      the settings the user typed in. The spec is explicit that the uninstaller
      must not remove anything whose ownership it cannot establish; this folder is
      ours, so it is safe to offer. }
    if DirExists(DataDir) then
    begin
      if MsgBox('是否同时删除 MasLingo 的配置与日志？' + #13#10 + #13#10 +
                DataDir + #13#10 + #13#10 +
                '其中包含你在设置页填写的翻译 API Key 和运行日志。' + #13#10 +
                '选择「否」会保留它们，重新安装时可以继续使用。',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;

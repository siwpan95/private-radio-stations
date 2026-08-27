; private-radio-stations 整合版安装包（2026-08-27，评估文档 A 级第 2 项）
; 核心包：便携 Node v26.7.0 + 运行时依赖 + video/audio/portal 三应用 + 配置与启动脚本。
; 重依赖 ffmpeg/MediaMTX 走独立 zip（private-radio-stations-deps-4.0.0.zip），
; 解压到安装目录即可（启动脚本缺依赖时只警告、面板仍可用）。
; 编译：ISCC.exe private-radio-stations.iss → installer\private-radio-stations-setup-4.0.0.exe
#define MyAppName "本地转播站（整合版）"
#define MyAppVersion "4.0.0"
#define MyAppPublisher "siwpan"

[Setup]
AppId={{C4E1D2B0-9A51-4F8E-A3D7-RADIOCLUST01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\private-radio-stations
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer
OutputBaseFilename=private-radio-stations-setup-4.0.0
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\node\node.exe
UninstallDisplayName={#MyAppName}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "开机自启动音频电台（端口 8000）"; GroupDescription: "系统集成:"; Flags: unchecked

[Dirs]
Name: "{app}\data"

[Files]
; 核心包不含 ffmpeg/MediaMTX 重二进制（约 150MB），它们走独立 deps zip（<100MB 可上 gitee Release）
Source: "_installer-src\stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "ffmpeg\*,mediamtx\*"
Source: "_installer-src\stage\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion uninsrestartdelete

[Icons]
Name: "{group}\启动音频电台"; Filename: "{app}\start-radio.bat"; WorkingDir: "{app}"
Name: "{group}\启动视频转播"; Filename: "{app}\start-video.bat"; WorkingDir: "{app}"
Name: "{group}\停止音频电台"; Filename: "{app}\stop-radio.bat"; WorkingDir: "{app}"
Name: "{group}\停止视频转播"; Filename: "{app}\stop-video.bat"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName} 电台"; Filename: "{app}\start-radio.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: """{app}\start-radio.bat"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\start-radio.bat"; WorkingDir: "{app}"; Description: "立即启动音频电台"; Flags: nowait postinstall skipifsilent

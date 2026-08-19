# Gives gitc its own icon and identity in the Windows taskbar.
#
#   .\scripts\install-shortcut.ps1
#   .\scripts\install-shortcut.ps1 -Remove
#
# Why this is needed at all: gitc's window is a Chromium browser started with
# --app=, and Windows does not take a taskbar icon from the window (the page
# favicon only sets the title-bar icon). It takes it from the Start Menu
# shortcut whose System.AppUserModel.ID matches the window's AUMID. With no
# such shortcut, Windows falls back to the host process and you get the
# browser's icon.
#
# Chromium derives that AUMID from the browser brand, the URL host and path,
# and the --user-data-dir basename with non-alphanumerics stripped - for gitc,
# "MSEdge.127.0.0.1_/.gitcwindow.Default". This writes a shortcut claiming
# exactly that id, pointing at the gitc binary, carrying gitc's icon.
#
# Run it once. It is not required to use gitc; it only fixes the icon.

param(
    [string]$Exe,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$linkPath = Join-Path $startMenu "gitc.lnk"
$appDir = Join-Path $env:APPDATA "gitc"
$icoPath = Join-Path $appDir "gitc.ico"

if ($Remove) {
    if (Test-Path $linkPath) { Remove-Item $linkPath -Force; Write-Host "Removed $linkPath" }
    else { Write-Host "Nothing to remove." }
    exit 0
}

if (-not $Exe) { $Exe = Join-Path $root "dist\gitc.exe" }
if (-not (Test-Path $Exe)) {
    Write-Host "gitc.exe not found at $Exe - build first, or pass -Exe <path>" -ForegroundColor Red
    exit 1
}
$Exe = (Resolve-Path $Exe).Path

# The icon has to live somewhere permanent: the shortcut points at the file,
# it does not copy the image into itself.
$icoSource = Join-Path $root "icons\gitc.ico"
if (-not (Test-Path $icoSource)) {
    Write-Host "icons\gitc.ico missing - run: node scripts/make-icons.mjs" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $appDir)) { New-Item -ItemType Directory $appDir -Force | Out-Null }
Copy-Item $icoSource $icoPath -Force

# --- which browser will gitc use, and so which AUMID prefix ----------------

$browsers = @(
    @{ Path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"; Brand = "MSEdge" },
    @{ Path = "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe";      Brand = "MSEdge" },
    @{ Path = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe";       Brand = "Chrome" },
    @{ Path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe";  Brand = "Chrome" }
)
$browser = $browsers | Where-Object { Test-Path $_.Path } | Select-Object -First 1
if (-not $browser) {
    Write-Host "No Chromium browser found; gitc cannot open a window either." -ForegroundColor Red
    exit 1
}

# Mirrors gitc's own launch: --user-data-dir=%TEMP%\gitc-window on 127.0.0.1.
$profileId = "gitc-window" -replace "[^a-zA-Z0-9]", ""
$aumid = "$($browser.Brand).127.0.0.1_/.$profileId.Default"

Write-Host "  browser  $($browser.Brand)"
Write-Host "  target   $Exe"
Write-Host "  icon     $icoPath"
Write-Host "  aumid    $aumid"

# --- write the shortcut ----------------------------------------------------
#
# WScript.Shell can create a shortcut but cannot set an AppUserModelID, which
# is the whole point here - that needs IShellLink's IPropertyStore.

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Lnk {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink { }

  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr d, int fl);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
    void GetHotkey(out short h);
    void SetHotkey(short h);
    void GetShowCmd(out int c);
    void SetShowCmd(int c);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r);
    void Resolve(IntPtr hwnd, int fl);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
  }

  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFile {
    void GetClassID(out Guid id);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint mode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, out PROPERTYKEY key);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  // Passed BY REF as a struct. A class marshals as a pointer-to-pointer here
  // and the value never reaches the store, which is the bug this replaces.
  [StructLayout(LayoutKind.Sequential)]
  public struct PROPVARIANT {
    public ushort vt;
    public ushort r1, r2, r3;
    public IntPtr p;
    public IntPtr p2;
  }

  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(
    string path, IntPtr bind, int flags, ref Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

  static PROPERTYKEY AppUserModelId() {
    var k = new PROPERTYKEY();
    k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    k.pid = 5;
    return k;
  }

  public static void Create(string linkPath, string target, string icon, string aumid, string desc) {
    var link = (IShellLinkW)new ShellLink();
    link.SetPath(target);
    link.SetIconLocation(icon, 0);
    link.SetDescription(desc);
    link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(target));

    var store = (IPropertyStore)link;
    var key = AppUserModelId();
    var pv = new PROPVARIANT();
    pv.vt = 31;                                   // VT_LPWSTR
    pv.p = Marshal.StringToCoTaskMemUni(aumid);
    try {
      store.SetValue(ref key, ref pv);
      store.Commit();
    } finally {
      PropVariantClear(ref pv);
    }

    ((IPersistFile)link).Save(linkPath, true);
    Marshal.ReleaseComObject(link);
  }

  /** Reads the id back off the saved file - the only proof that matters. */
  public static string Read(string linkPath) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(linkPath, IntPtr.Zero, 0, ref iid, out store);
    var key = AppUserModelId();
    PROPVARIANT pv;
    store.GetValue(ref key, out pv);
    string value = pv.vt == 31 ? Marshal.PtrToStringUni(pv.p) : null;
    PropVariantClear(ref pv);
    Marshal.ReleaseComObject(store);
    return value ?? "(unset)";
  }
}
'@

Add-Type -TypeDefinition $code -ErrorAction Stop

[Lnk]::Create($linkPath, $Exe, $icoPath, $aumid, "A fast, minimal git client")

# Read it back off disk. Setting the property silently does nothing if the
# marshalling is wrong, and a shortcut without the id fixes no icon at all.
$written = [Lnk]::Read($linkPath)
if ($written -ne $aumid) {
    Write-Host "Shortcut was written but its AppUserModelID is '$written'" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Wrote $linkPath" -ForegroundColor Green
Write-Host "  verified AppUserModelID: $written" -ForegroundColor Green
Write-Host "Close the gitc window and reopen it - the taskbar reads the icon at window creation."

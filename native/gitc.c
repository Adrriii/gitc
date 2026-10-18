#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32

#include <stdlib.h>
#include <wchar.h>
#include <windows.h>

static WCHAR *widen(const uint8_t *s, size_t n);

struct find {
  const WCHAR *title;
  HWND hwnd;
};

static BOOL CALLBACK match(HWND h, LPARAM p) {
  struct find *f = (struct find *)p;
  WCHAR cls[64];
  WCHAR title[256];
  if (!IsWindowVisible(h)) return TRUE;
  if (GetClassNameW(h, cls, 64) == 0 || wcscmp(cls, L"Chrome_WidgetWin_1") != 0) return TRUE;
  if (GetWindowTextW(h, title, 256) == 0 || wcscmp(title, f->title) != 0) return TRUE;
  f->hwnd = h;
  return FALSE;
}

int32_t gitc_raise_window(const uint8_t *title, size_t n) {
  WCHAR *t = widen(title, n);
  if (t == NULL) return 0;
  struct find f = {t, NULL};
  EnumWindows(match, (LPARAM)&f);
  free(t);
  if (f.hwnd == NULL) return 0;
  if (IsIconic(f.hwnd)) ShowWindow(f.hwnd, SW_RESTORE);
  return SetForegroundWindow(f.hwnd) ? 1 : 0;
}

int32_t gitc_run_hidden(const uint8_t *cmd, size_t n) {
  WCHAR *c = widen(cmd, n);
  if (c == NULL) return -1;
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si);
  si.cb = sizeof si;
  BOOL ok = CreateProcessW(NULL, c, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
  free(c);
  if (!ok) return -1;
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return (int32_t)code;
}

static WCHAR *widen(const uint8_t *s, size_t n) {
  int len = MultiByteToWideChar(CP_UTF8, 0, (const char *)s, (int)n, NULL, 0);
  WCHAR *w = malloc(((size_t)len + 1) * sizeof(WCHAR));
  if (w == NULL) return NULL;
  MultiByteToWideChar(CP_UTF8, 0, (const char *)s, (int)n, w, len);
  w[len] = 0;
  return w;
}

#else

int32_t gitc_raise_window(const uint8_t *title, size_t n) {
  (void)title;
  (void)n;
  return 0;
}

int32_t gitc_run_hidden(const uint8_t *cmd, size_t n) {
  (void)cmd;
  (void)n;
  return -1;
}

#endif

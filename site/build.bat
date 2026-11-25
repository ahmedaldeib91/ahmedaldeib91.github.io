@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo خطأ: برنامج Node.js غير مثبت على هذا الجهاز أو غير موجود في مسار النظام.
  echo Node.js is not installed or not found in PATH.
  echo.
  echo اضغط أي مفتاح للإغلاق...
  pause >nul
  exit /b 1
)
node build.mjs %*
set "BUILD_ERR=%errorlevel%"
if not "%BUILD_ERR%"=="0" (
  echo.
  echo ==== فشل البناء. اقرأ الرسالة أعلاه لمعرفة السبب وإصلاحه ثم أعد التشغيل ====
  echo BUILD FAILED
) else (
  echo.
  echo ==== تم البناء بنجاح. ملفات الموقع الجاهزة في مجلد dist ====
  echo BUILD OK
)
echo.
echo اضغط أي مفتاح للإغلاق...
pause >nul
exit /b %BUILD_ERR%

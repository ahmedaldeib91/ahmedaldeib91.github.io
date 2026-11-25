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
echo جارٍ تشغيل معاينة الموقع. إن لم تكن قد شغّلت build.bat فشغّله أولًا.
echo.
node serve.mjs
echo.
echo توقفت المعاينة. اضغط أي مفتاح للإغلاق...
pause >nul

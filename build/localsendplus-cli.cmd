@echo off
rem LocalSendPlus command-line client. Run "localsendplus-cli --help" for usage.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0localsendplus.exe" "%~dp0resources\app.asar\bin\localsendplus.js" %*
exit /b %ERRORLEVEL%

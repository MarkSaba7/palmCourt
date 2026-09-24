@echo off
rem Starts Palm Court: the game on this PC plus the phone racket page on your Wi-Fi.
rem Close this window to stop. Extra options go to serve.py, e.g.  play.cmd --ip 192.168.1.20
cd /d "%~dp0"
set "PY="
rem "python" can be the Microsoft Store placeholder that only opens the Store, so check it really runs.
python -c "import ssl" >nul 2>nul && set "PY=python"
if not defined PY (py -3 -c "import ssl" >nul 2>nul && set "PY=py -3")
if not defined PY (
  echo Palm Court needs Python 3. Install it from https://www.python.org/downloads/ and run play.cmd again.
  pause
  exit /b 1
)
%PY% serve.py %*
pause

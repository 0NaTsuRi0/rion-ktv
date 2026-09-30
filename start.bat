@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js not found
    pause
    exit /b 1
)

node --version

if not exist "server\node_modules" (
    echo Installing dependencies...
    cd server
    call npm install
    cd /d "%~dp0"
)

if not exist "data" mkdir data 2>nul
if not exist "mv" mkdir mv 2>nul

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo ffmpeg not found in PATH
)

if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
    )
)

echo.
echo TV:  http://localhost:8080/tv/
echo Mob: http://localhost:8080/mobile/
echo Adm: http://localhost:8080/admin/
echo.
node server/index.js
pause

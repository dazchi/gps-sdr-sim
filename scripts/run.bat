@echo off
setlocal

:: Resolve repo root by navigating up from this script's directory
cd /d "%~dp0"
cd ..
set "ROOT=%CD%"

set "FRONTEND=%ROOT%\frontend"
set "SIMEXE=%ROOT%\gps-sdr-sim\x64\Release\gps-sdr-sim.exe"
set "NAVFILE=%ROOT%\scripts\brdc2010.26n"

:: Optional: capture fresh ephemeris before starting.
:: Requires pyrtcm (pip install pyrtcm) or use the venv at scripts\.venv
::
:: echo [*] Capturing live ephemeris...
:: "%ROOT%\scripts\.venv\Scripts\python.exe" "%ROOT%\scripts\rtcm_to_rinex.py"
:: if errorlevel 1 ( echo [-] Ephemeris capture failed. ^& pause ^& exit /b 1 )

:: Validate paths
if not exist "%SIMEXE%" (
    echo [-] gps-sdr-sim.exe not found at:
    echo     %SIMEXE%
    echo     Build the project in Visual Studio first - Release x64 configuration.
    pause
    exit /b 1
)

if not exist "%NAVFILE%" (
    echo [-] Navigation file not found:
    echo     %NAVFILE%
    echo     Run scripts\rtcm_to_rinex.py to generate live.n first.
    pause
    exit /b 1
)

if not exist "%FRONTEND%\node_modules" (
    echo [*] node_modules missing - running npm install...
    pushd "%FRONTEND%"
    call npm install
    popd
)

:: Launch frontend using /d to set working directory
echo [*] Starting web route planner on http://localhost:3000 ...
start "GPS Route Planner" /d "%FRONTEND%" cmd /k node server.js

:: Give the server a moment to bind
timeout /t 2 /nobreak >nul

:: Launch gps-sdr-sim
:: Flags: -H direct HackRF transmit, -b 8 signed 8-bit I/Q, -S TCP socket input port 6000
echo [*] Starting gps-sdr-sim ...
start "gps-sdr-sim" cmd /k "%SIMEXE% -e %NAVFILE% -b 8 -s 4000000 -p 128 -H -S"

echo.
echo [+] Both processes launched in separate windows.
echo     Open http://localhost:3000 in your browser, then click Connect to Simulator.
echo.
pause

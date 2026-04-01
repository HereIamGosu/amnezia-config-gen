@echo off
REM AmneziaWG 2.0 — конфиг из генератора: AmneziaWarp-AWG2.conf
set "TASKNAME=AmneziaWG WARP (AWG 2.0)"

set "PROGRAM=C:\Program Files\AmneziaWG\amneziawg.exe"

set "CONFIG_FILE=AmneziaWarp-AWG2.conf"
set "CONFIG_PATH=%USERPROFILE%\Downloads\%CONFIG_FILE%"

set "ARGUMENTS=/connect /config \"%CONFIG_PATH%\""

schtasks /create /tn "%TASKNAME%" /tr "\"%PROGRAM%\" %ARGUMENTS%" /sc onlogon /rl highest /f

if %errorlevel% equ 0 (
    echo Задача "%TASKNAME%" успешно создана. Конфиг: %CONFIG_FILE%
) else (
    echo Ошибка при создании задачи.
)

pause

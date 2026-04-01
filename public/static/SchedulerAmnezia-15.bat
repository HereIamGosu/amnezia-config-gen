@echo off
REM AmneziaWG 1.5 (Legacy) — конфиг из генератора: AmneziaWarp.conf
set "TASKNAME=AmneziaWG WARP (Legacy 1.5)"

set "PROGRAM=C:\Program Files\AmneziaWG\amneziawg.exe"

set "CONFIG_FILE=AmneziaWarp.conf"
set "CONFIG_PATH=%USERPROFILE%\Downloads\%CONFIG_FILE%"

set "ARGUMENTS=/connect /config \"%CONFIG_PATH%\""

schtasks /create /tn "%TASKNAME%" /tr "\"%PROGRAM%\" %ARGUMENTS%" /sc onlogon /rl highest /f

if %errorlevel% equ 0 (
    echo Задача "%TASKNAME%" успешно создана. Конфиг: %CONFIG_FILE%
) else (
    echo Ошибка при создании задачи.
)

pause

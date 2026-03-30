@echo off
REM Название задачи
set "TASKNAME=AmneziaWG for Discord"

REM Путь к исполняемому файлу
set "PROGRAM=C:\Program Files\AmneziaWG\amneziawg.exe"

REM Имя конфига в «Загрузках»: AmneziaWarp-AWG2.conf (AmneziaWG 2.0) или AmneziaWarp.conf (Legacy)
set "CONFIG_FILE=AmneziaWarp-AWG2.conf"
set "CONFIG_PATH=%USERPROFILE%\Downloads\%CONFIG_FILE%"

REM Аргументы для запуска программы
set "ARGUMENTS=/connect /config \"%CONFIG_PATH%\""

REM Создание триггера при входе любого пользователя
schtasks /create /tn "%TASKNAME%" /tr "\"%PROGRAM%\" %ARGUMENTS%" /sc onlogon /rl highest /f

REM Проверка успешности выполнения команд
if %errorlevel% equ 0 (
    echo Задача "%TASKNAME%" успешно создана. Конфиг: %CONFIG_FILE%
) else (
    echo Ошибка при создании задачи.
)

pause

@echo off
REM Название задачи
set "TASKNAME=AmneziaWG for Discord"

REM Путь к исполняемому файлу
set "PROGRAM=C:\Program Files\AmneziaWG\amneziawg.exe"

REM Путь к конфигурационному файлу с использованием переменной среды %USERPROFILE%
set "CONFIG_PATH=%USERPROFILE%\Downloads\AmneziaWarp.conf"

REM Аргументы для запуска программы
set "ARGUMENTS=/connect /config \"%CONFIG_PATH%\""

REM Создание триггера при входе любого пользователя
schtasks /create /tn "%TASKNAME%" /tr "\"%PROGRAM%\" %ARGUMENTS%" /sc onlogon /rl highest /f

REM Проверка успешности выполнения команд
if %errorlevel% equ 0 (
    echo Задача "%TASKNAME%" успешно создана с двумя триггерами.
) else (
    echo Ошибка при создании задачи.
)

pause

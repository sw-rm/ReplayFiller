@echo off
setlocal

set "CACHE_PATH=%appdata%\.minecraft\npm-cache"

if exist "%CACHE_PATH%" (
    echo Deleting contents of: %CACHE_PATH%
    del /s /q "%CACHE_PATH%\*"
    for /d %%x in ("%CACHE_PATH%\*") do rd /s /q "%%x"
    echo Done.
) else (
    echo The folder "%CACHE_PATH%" does not exist.
)

endlocal
pause
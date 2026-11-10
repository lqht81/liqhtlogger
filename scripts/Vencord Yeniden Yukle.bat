@echo off
title Vencord Yeniden Yukle
cd /d "%USERPROFILE%\Vencord" || (echo Vencord klasoru bulunamadi. & pause & exit /b 1)

echo Discord guncellendikten sonra Vencord kaybolduysa bunu calistir.
echo Acilan menude kullandigin Discord'u sec ve Enter'a bas.
echo.
call pnpm.cmd inject

echo.
echo Discord'u sistem tepsisinden de kapatip (Quit) tekrar ac.
pause

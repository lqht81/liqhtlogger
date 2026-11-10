@echo off
title LiqhtLogger Guncelle
cd /d "%USERPROFILE%\Vencord" || (echo Vencord klasoru bulunamadi. & pause & exit /b 1)

echo == Vencord guncelleniyor ==
git pull || goto :hata

echo.
echo == LiqhtLogger guncelleniyor ==
git -C "src\userplugins\LiqhtLogger" pull || goto :hata

echo.
echo == Derleniyor ==
call pnpm.cmd install --frozen-lockfile || goto :hata
call pnpm.cmd build || goto :hata

echo.
echo Bitti! Discord'u sistem tepsisinden de kapatip (Quit) tekrar ac.
pause
exit /b 0

:hata
echo.
echo Bir hata olustu. Yukaridaki kirmizi satirlari kontrol et.
pause
exit /b 1

# LiqhtLogger

Discord için bir [Vencord](https://github.com/Vendicated/Vencord) eklentisi. Silinen ve düzenlenen mesajları bilgisayarına kaydeder.

- Silinen mesajlar kanalda kırmızı kalır, altında silinme saati yazar
- Düzenlenen mesajların eski hali mesajın üstünde soluk görünür
- Kayıtlar diskte tutulur (varsayılan 30 gün). Discord'u yeniden başlatsan da kaybolmaz.
- Silinen resim, video ve dosyalar kaydedilir (varsayılan 7 gün)
- Sağ üstte, Gelen Kutusu'nun yanında tüm kayıtları filtreleyebileceğin bir panel
- Silinme bildirimleri ve 👻 hayalet etiket uyarısı
- Sunucu, kanal ve kullanıcı yoksayma

## Kurulum (Windows)

1. [`LiqhtLogger Kur.bat`](./LiqhtLogger%20Kur.bat) dosyasını indir ve çift tıkla.
   - Git, Node.js ve pnpm yoksa otomatik kurulur. Kurulum ekranları çıkarsa onay ver.
   - Vencord `%USERPROFILE%\Vencord` klasörüne indirilir ve derlenir.
2. Sonunda açılan menüden kullandığın Discord'u seçip Enter'a bas.
3. Discord'u **sistem tepsisinden de kapatıp (Quit)** tekrar aç.
4. **Ayarlar → Vencord → Plugins → LiqhtLogger** eklentisini aç.

> Daha önce Vencord'u resmi kurulum programıyla kurduysan sorun değil. Bu kurulum onun yerine geçer, ayarların korunur.

## Güncelleme

Masaüstündeki **LiqhtLogger Guncelle** dosyasını çalıştır, ardından Discord'u kapatıp aç.

Discord güncellendikten sonra Vencord kaybolduysa masaüstündeki **Vencord Yeniden Yukle** dosyasını çalıştır.

## Kaldırma

PowerShell'de:

```powershell
cd $env:USERPROFILE\Vencord
pnpm uninject
```

Kayıtlar `%APPDATA%\Vencord\LiqhtLogger` klasöründe. İstersen bu klasörü de silebilirsin.

## Bilmen gerekenler

- Vencord gibi client mod'lar Discord'un kullanım şartlarına teknik olarak aykırıdır. Kullanmak kendi sorumluluğundadır.
- Kayıtlar sadece senin bilgisayarında tutulur, hiçbir yere gönderilmez. Başkalarının sildiği mesajları paylaşmak insanlarla aranı bozabilir. Kayıtları kendine sakla.

## Lisans

GPL-3.0-or-later. Vencord'un MessageLogger eklentisinden uyarlanmıştır (Copyright (c) 2022 Vendicated and contributors).

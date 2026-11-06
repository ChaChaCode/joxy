# JOXY

**English:** JOXY is a minimal VPN client for Windows built on [Xray-core](https://github.com/XTLS/Xray-core). Add a VLESS subscription, pick a location on a dotted Equal Earth world map, press one button, and watch a train of lights run from where you are to the server's country. It supports system proxy, local proxy and TUN mode with a kill switch and DNS leak protection, has a tray panel with a live speed graph, updates itself from GitHub releases, keeps your profiles encrypted with Windows DPAPI and hides server addresses on screen by default. Download the portable `.exe` from [Releases](https://github.com/ChaChaCode/joxy/releases). MIT licensed.

---

Простой VPN-клиент для Windows на ядре Xray. Добавьте подписку, выберите локацию на карте и нажмите одну кнопку.

<p align="center">
  <img src="docs/screenshots/map-light.png" width="49%" alt="JOXY: главный экран">
  <img src="docs/screenshots/map-connected-dark.png" width="49%" alt="JOXY: подключено, тёмная тема">
</p>

## Скачать

Последняя версия — на странице [Releases](https://github.com/ChaChaCode/joxy/releases): файл `JOXY-<версия>-Windows-x64.exe`. Это переносимая программа, установка не нужна. Рядом лежит `SHA256SUMS.txt` для проверки файла.

Требования: Windows 10 или 11, 64-бит.

> Файл не подписан сертификатом издателя, поэтому при первом запуске Windows SmartScreen может предупредить о неизвестном издателе. Нажмите «Подробнее» → «Выполнить в любом случае», если скачали файл отсюда и контрольная сумма совпадает.

Дальше JOXY обновляется сам: когда на GitHub выходит новая версия, появляется плашка «Вышла версия…». По кнопке «Обновить» JOXY скачивает файл, сверяет его SHA256 с опубликованной суммой и перезапускается.

## Как пользоваться

1. Запустите JOXY и вставьте ссылку на подписку (`https://…`), ссылку `vless://` или Xray JSON.
2. Слева вверху выберите локацию или оставьте «Автовыбор».
3. Нажмите кнопку подключения. От синей точки — того места, где вы находитесь, — к стране сервера побегут зелёные огоньки, а после подключения страна загорится зелёным.

<p align="center">
  <img src="docs/screenshots/connecting-session.webp" width="720" alt="JOXY: выбор Токио, подключение из Москвы — огоньки бегут к Японии, затем отключение">
</p>

Карта в проекции Equal Earth: страны в настоящем соотношении площадей. Её можно перетаскивать и приближать колесом мыши, двойным щелчком или клавишами `+`/`−`; `0` возвращает вид. Страны, где у вас есть серверы, отмечены более тёмными точками.

<p align="center">
  <img src="docs/screenshots/connecting-light.png" width="49%" alt="JOXY: подключение, огоньки бегут к стране сервера">
  <img src="docs/screenshots/locations-light.png" width="49%" alt="JOXY: выбор локации">
</p>

## Возможности

- **Три режима:** системный прокси Windows, локальный HTTP/SOCKS-прокси и **TUN** — весь трафик приложений, включая UDP, через виртуальный адаптер.
- **Kill switch** в режиме TUN: если VPN пропадёт, интернет блокируется до переподключения. Правила Windows Filtering Platform живут ровно столько, сколько работает JOXY, поэтому оставить систему без интернета он не может.
- **Защита от утечек DNS и IPv6** в TUN: запросы DNS мимо VPN блокируются, DNS идёт по DNS over HTTPS через VPN.
- **Переподключение** при потере связи, смене Wi‑Fi/кабеля и после сна; резервный сервер, если основной недоступен.
- **Протоколы:** VLESS с REALITY или TLS; транспорты Vision, XHTTP (в том числе с несколькими соединениями, XMUX), gRPC, WebSocket, HTTPUpgrade; TLS-фрагментация.
- **Серверы и подписки:** срок действия, трафик и лимит подписки; задержка и уровень сигнала у каждого сервера; правая кнопка или «⋯» — подключиться, проверить задержку, поделиться ссылкой `vless://`, удалить.
- **Мини-панель в трее:** правый клик по значку — сервер, кнопка подключения, время, задержка и график скорости; левый клик открывает приложение.
- **Маршрутизация:** российские сайты (.ru, .su, .рф, .москва) напрямую одним переключателем; свои домены и подсети без VPN.
- **Приватность:** профили зашифрованы Windows DPAPI; адреса серверов и внешний IP скрыты на экране. JOXY не обращается к GeoIP и аналитике: ваше место на карте берётся из часового пояса Windows, а страна выхода у серверов без страны — из встроенной базы прямо на компьютере.
- Светлая, тёмная и системная тема; шрифт Inter; автоподключение при запуске; сворачивание в трей.

<p align="center">
  <img src="docs/screenshots/servers-light.png" width="58%" alt="JOXY: серверы и подписки">
  <img src="docs/screenshots/tray-light.png" width="20%" alt="JOXY: мини-панель в трее">
  <img src="docs/screenshots/tray-dark.png" width="20%" alt="JOXY: мини-панель в трее, тёмная тема">
</p>

## Режим TUN и права администратора

Чтобы создать сетевой адаптер, Windows требует права администратора. Когда выбран TUN, JOXY сам перезапускается с правами при запуске — Windows покажет обычный запрос UAC. Если отказаться, JOXY запомнит это и предложит снова только при нажатии кнопки подключения.

Если на компьютере работает другой VPN в режиме TUN, JOXY сообщит об этом и назовёт его: два TUN одновременно конфликтуют, поэтому другой VPN нужно отключить.

## Сборка из исходников

Нужны Node.js 24, Go 1.25 и PowerShell.

```powershell
npm ci
npm run fetch:core   # скачивает Xray-core и Wintun и сверяет их SHA256
npm test
npm run pack         # собирает интерфейс, помощник kill switch (Go) и portable .exe
```

Готовый файл появится в `release-joxy-<версия>/`. Скрипт `build.ps1` делает то же самое и при необходимости скачивает отдельный Node.js 24, не трогая установленный.

Полезные команды: `npm run dev` — интерфейс в браузере, `npm run verify:ui` — проверка интерфейса через Playwright, `npm run shots:readme` и `npm run video:readme` — скриншоты и анимация подключения (60 кадров в секунду) для этого файла, на выдуманных серверах; для анимации нужен ffmpeg.

## Устройство

- `electron/` — главный процесс: подписки и профили, управление Xray, системный прокси, TUN, kill switch и защита от утечек, переподключение, обновления, поиск страны по IP.
- `src/` — интерфейс на React: карта (`WorldMap.tsx`), главный экран (`App.tsx`), настройки (`SettingsView.tsx`), серверы (`ServerGroup.tsx`), панель в трее (`TrayView.tsx`).
- `guard/` — `joxy-guard`, помощник на Go для kill switch и защиты от утечек (Windows Filtering Platform, динамическая сессия).
- `resources/` — скрипты Windows для прокси и восстановления TUN, база «IP → страна»; сюда же `fetch:core` кладёт Xray и Wintun.
- `scripts/build-world-dots.mjs` — сборка точечной карты в проекции Equal Earth из данных Natural Earth и координат часовых поясов IANA.
- `scripts/build-ip-country.mjs` — сборка встроенной базы «IP → страна» из DB-IP IP to Country Lite.
- `docs/` — заметки по архитектуре и скриншоты; `CHANGELOG.md` — история версий; `DESIGN.md` — принципы оформления.

## Лицензия

JOXY распространяется по лицензии [MIT](LICENSE). Сторонние компоненты — Xray-core (MPL-2.0), Wintun, Electron, React, шрифт Inter (OFL), иконки Phosphor и флаги flag-icons (MIT), данные Natural Earth и базы часовых поясов IANA (общественное достояние), IP Geolocation by [DB-IP](https://db-ip.com) (CC BY 4.0) — используются по своим лицензиям, см. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

JOXY — независимый проект. Он не содержит кода Throne или nekoray и не связан с XTLS.

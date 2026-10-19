# WATplan Server

Serwer bez interfejsu graficznego. Co 15 minut pobiera JSON-y wszystkich semestrów, generuje kalendarze ICS dla wszystkich grup i zapisuje pliki na 15 minut.

## Uruchomienie

Wymagany jest Node.js 18 lub nowszy. Serwer nie wymaga zewnętrznych pakietów.

```sh
npm start
```

Domyślnie nasłuchuje na `0.0.0.0:3000`. Adres można zmienić zmiennymi `PORT` i `HOST`.

## Endpointy

- `GET /health` — status serwera.
- `GET /api/schedule?group=WCY23IB4aS6&year=2026` — plik ICS grupy dla wskazanego roku kalendarzowego.

Źródłem jest `/data/semesters.json` oraz `entries-{id}.json` i `subjects-{id}.json` pod `DATA_BASE_URL` (domyślnie `https://watplan.coobie.dev/data`). Pliki kalendarzy są przechowywane w `./data/ics`; można zmienić katalog przez `CALENDAR_DIRECTORY`.

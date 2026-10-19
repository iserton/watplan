# WATplan Server

Serwer bez interfejsu graficznego. Co 15 minut pobiera pliki JSON z danymi wszystkich semestrów, generuje osobny plik ICS dla każdej grupy i semestru oraz zapisuje je lokalnie na 15 minut.

## Uruchomienie

Wymagany jest Node.js 18 lub nowszy. Serwer nie wymaga zewnętrznych pakietów.

```sh
npm start
```

Domyślnie nasłuchuje na `0.0.0.0:3000`. Port i adres można zmienić zmiennymi `PORT` i `HOST`.

## Endpointy

- `GET /health` — status serwera w JSON.
- `GET /api/schedule?group=WCY23IB4aS6&semester=20261` — plik ICS grupy dla semestru o ID `20261`.

Identyfikatory i nazwy semestrów pochodzą z `semesters.json`. Przykładowo `20261` oznacza semestr zimowy roku akademickiego 2026/2027, a `20262` — letni.

Źródłem danych jest `/data/semesters.json` oraz pliki `entries-{id}.json` i `subjects-{id}.json` pod `DATA_BASE_URL`. Domyślna wartość to `https://watplan.coobie.dev/data`; można ją zmienić w konfiguracji środowiska.

Serwer synchronizuje wszystkie semestry i tworzy kalendarz na podstawie wpisów z JSON-a danego semestru dla każdej znalezionej grupy. Endpoint zwraca gotowy plik z katalogu `./data/ics` — nie pobiera danych podczas żądania. Podczas pierwszej synchronizacji odpowiedź może mieć status `503`; po wygenerowaniu pliku odpowiedź ma typ `text/calendar` i nazwę `{grupa}-{id-semestru}.ics`.

`CALENDAR_DIRECTORY` pozwala zmienić katalog plików, a `PORT` i `HOST` adres nasłuchiwania. Katalog z wygenerowanymi kalendarzami powinien być trwałym zapisem na serwerze.

# WATplan Server

Minimalny serwer bez interfejsu graficznego. Pobiera HTML publicznego planu wybranej grupy ze strony WCY WAT.

## Uruchomienie

Wymagany jest Node.js 18 lub nowszy. Serwer nie wymaga dodatkowych pakietów.

```sh
npm start
```

Domyślnie serwer nasłuchuje na `0.0.0.0:3000`. Port i adres można ustawić zmiennymi `PORT` i `HOST`.

## Endpointy

- `GET /health` — status serwera w JSON.
- `GET /api/schedule?group=WCY23IB4aS6` — HTML planu grupy pobrany ze strony WCY.

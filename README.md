# Plan — plan zajęć Polsl z USOS

Apka na Androida, która pobiera plan zajęć z USOSweb (link iCal) i sama go aktualizuje.

- kilka planów naraz (swój, kolegi, innej grupy) i przełączanie u góry ekranu
- widok dnia (z okienkami i tym, co jest „teraz”) i tygodnia
- zakładka **Zmiany**: po odświeżeniu pokazuje, co się zmieniło w planie (sala, godzina, nowe i odwołane zajęcia)
- działa offline na ostatnio pobranej wersji

## Instalacja
Wejdź w **Releases → Plan — najnowsza wersja** i pobierz `Plan.apk` na telefonie.
Każdy push na `main` buduje nową wersję automatycznie (GitHub Actions).

## Skąd link do planu
USOSweb → Mój USOSweb → Plan zajęć → **eksportuj** → skopiuj link do kalendarza.

## Technicznie
Strona w `www/` (HTML/JS bez frameworka) opakowana w Capacitor. Parser `.ics` w `www/ics.js`, testy: `npm test`.

# Target Practice

Web app (PWA) per analizzare il tiro al bersaglio con la fotocamera del telefono o del PC.
Funziona interamente nel browser: nessun server, nessun upload, i dati restano sul dispositivo.

## Come funziona

1. **Scatto** – inquadra il bersaglio con la fotocamera (o carica una foto dalla galleria).
   C'è anche un *bersaglio di prova* generato al volo per provare l'app senza foto.
2. **Bersaglio** – il programma trova da solo il cerchio del bersaglio (trasformata di Hough
   circolare guidata dal gradiente). Se sbaglia, lo correggi con le dita: trascini il centro, trascini un
   punto del bordo, oppure usi i pulsanti di regolazione fine. Due dita per lo zoom.
   Poi indichi a cosa corrisponde il cerchio (anello esterno, zona nera, un anello qualsiasi o un
   diametro a piacere): da lì l'app ricava la scala in px/mm.
3. **Colpi** – tocchi i fori per segnarli, li trascini per spostarli (con lente d'ingrandimento),
   li selezioni per eliminarli. Il pulsante *Rileva fori* prova a trovarli da solo
   (sperimentale: confronta ogni pixel con il profilo radiale mediano del bersaglio, che è simmetrico
   per rotazione, e separa i fori che si toccano con la trasformata distanza).
4. **Risultati** – statistiche, punteggio, correzione delle mire, esportazione.
5. **Storico** – sessioni salvate sul dispositivo con andamento nel tempo di raggio medio e punteggio;
   esporta/importa in JSON.

## Statistiche calcolate

| Statistica | Significato |
|---|---|
| Rosata (extreme spread) | distanza massima centro-centro fra due colpi; anche bordo-bordo (+ calibro) |
| Raggio medio | distanza media dei colpi dal centro del gruppo |
| Deviazione standard radiale | √ media(d²) dal centro del gruppo |
| Cerchio minimo | diametro del cerchio più piccolo che contiene tutti i colpi |
| CEP 50% / 90% | raggio che contiene il 50% / 90% dei colpi |
| Larghezza × altezza | ingombro del gruppo |
| Scarto dal centro | distanza del centro del gruppo dal centro del bersaglio |
| Punteggio | anelli ISSF con regola del bordo (il foro che tocca l'anello prende il valore maggiore), totale, media, accuratezza %, decimale approssimato |
| Correzione mire | click orizzontali/verticali da applicare (1/8, 1/4, 1/2, 1 MOA o 0,1 mil) |

Tutte le misure lineari sono anche in MOA alla distanza impostata.

Bersagli predefiniti: carabina 10 m, pistola 10 m, carabina 50 m, pistola 25/50 m precisione,
pistola 25 m celere (ISSF) e bersaglio personalizzato (diametro del 10 e larghezza anello).

## Avvio

È un sito statico: basta servire la cartella con HTTPS (la fotocamera richiede HTTPS o `localhost`).

```bash
npm start          # http://localhost:8080 (python3 -m http.server)
npm test           # test unitari delle statistiche (node --test)
```

Per pubblicarla su GitHub Pages: *Settings → Pages → Source: GitHub Actions*; il workflow in
`.github/workflows/pages.yml` pubblica il contenuto del repository a ogni push sul ramo principale.
Una volta aperta da telefono si può "aggiungere alla schermata Home" e funziona anche offline.

## Struttura

```
index.html        pagina unica con le cinque viste
css/style.css     stile (tema chiaro/scuro automatico)
js/app.js         interfaccia, fotocamera, canvas, storico, esportazioni
js/detect.js      rilevamento bersaglio (Hough circolare) e fori
js/stats.js       statistiche e punteggio (modulo puro, testato)
tests/            test node:test
sw.js, manifest.json, icons/   PWA
```

## Consigli per la foto

- bersaglio tutto dentro l'inquadratura, fotocamera il più possibile perpendicolare al foglio
  (una foto obliqua trasforma i cerchi in ellissi e falsa le misure);
- luce uniforme, senza ombre dure;
- i fori devono essere ben visibili: su carta bianca appaiono scuri, sulla zona nera appaiono chiari.

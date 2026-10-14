# Model Index

Een gratis tool van [Werkplaats Marc](https://www.werkplaatsmarc.be) · A free tool by [Werkplaats Marc](https://www.werkplaatsmarc.be)

**NL** · [English below](#english)

Een gratis, volledig lokale bibliotheek voor je 3D-printbestanden (**STL, 3MF, OBJ**). Voeg je bestanden toe, zie meteen thumbnails, bekijk ze in 3D en geef ze een naam, tags en notities, zodat je weer weet wat wat is. Werkt op telefoon, tablet en pc en kan als app geïnstalleerd worden.

- **Niets wordt geüpload.** Alles draait in je browser; er is geen server of account.
- **Je originelen blijven ongemoeid.** De app bewaart een kopie in de browser en voegt enkel een eigen catalogus toe.
- **Selecteren:** vink modellen aan (rechtsboven op de kaart) en verplaats ze samen naar een map, geef ze tags of verwijder ze uit de bibliotheek. Mappen bestaan enkel binnen de app; je bestanden op schijf blijven staan.
- **Schijf-koppeling (optioneel, Chrome/Edge op pc):** koppel een map in Instellingen en laat hernoemen en verplaatsen ook echt op schijf gebeuren. Verwijderen van schijf vraagt altijd een extra bevestiging en is niet ongedaan te maken. Op telefoon en tablet kan een webpagina dit niet.
- **Dubbelen zoeken:** vind identieke bestanden onder verschillende namen en ruim ze op.
- **Back-up:** exporteer alles als `.zip` (ook om van toestel te wisselen) of enkel de catalogus. Waar de browser het ondersteunt, deel je de back-up direct via het deelmenu (WhatsApp, e-mail, Drive, Bestanden); anders wordt ze gedownload.
- Nederlands en Engels.

## Gebruiken

1. Open de site (bv. via GitHub Pages) en kies *Toevoegen*, of sleep bestanden/mappen in het venster.
2. Tik op een model om te draaien, in te zoomen en een naam, tags en notitie in te vullen.
3. Maak af en toe een back-up via ⚙ Instellingen. Je bibliotheek staat enkel in deze browser; die kan opslag opruimen als er ruimte tekort is (vooral Safari op iPhone/iPad).

Installeren als app: *Toevoegen aan beginscherm* (iOS/Android) of het installatie-icoon in de adresbalk (Chrome/Edge).

## Zelf draaien / hosten

Het is een statische site zonder build-stap.

```bash
python -m http.server 5173
# open http://localhost:5173
```

Voor GitHub Pages: zet de inhoud van deze map op een branch en activeer Pages. Verhoog `VERSION` in `sw.js` na elke wijziging, anders blijven bezoekers de oude offline-cache zien.

## Beperkingen v1

- Mapkeuze werkt niet overal (iOS kiest enkel losse bestanden).
- Bestanden boven 150 MB krijgen geen automatische preview.
- OBJ-kleuren: kies het `.mtl`-bestand samen met de `.obj` (kleuren per materiaal en per hoekpunt worden getoond, texturen niet). 3MF-kleuren van Bambu Studio/OrcaSlicer (filamentkleur per object of onderdeel en met de verfkwast geschilderde vlakken) worden getoond; geschilderde randen zijn op driehoeksniveau benaderd. PrusaSlicer-kleuren per extruder worden nog niet getoond.
- Een back-up met alle bestanden wordt in het geheugen opgebouwd: bij een zeer grote bibliotheek kan dat zwaar zijn.

## English

A free, fully local library for your 3D-printing files (**STL, 3MF, OBJ**): add files, get instant thumbnails, inspect them in 3D and give them a name, tags and notes so you always know what is what. Works on phone, tablet and desktop and can be installed as an app.

- **Nothing is uploaded.** Everything runs in your browser; no server, no account.
- **Your originals are never touched.** A copy is stored in the browser, plus your own catalog on top.
- **Select:** tick models (top right of the card) to move them to a folder, tag them or remove them together. Folders only exist inside the app; your files on disk are left alone.
- **Disk link (optional, Chrome/Edge on desktop):** link a folder in Settings and let renaming and moving really happen on disk. Deleting from disk always asks an extra confirmation and cannot be undone. A web page cannot do this on phones and tablets.
- **Find duplicates:** spot identical files under different names and clear them out.
- **Backup:** export everything as a `.zip` (also to switch devices) or just the catalog. Where the browser supports it, share the backup straight from the share sheet (WhatsApp, email, Drive, Files); otherwise it is downloaded.
- Dutch and English.

Run it yourself: it is a static site, no build step (`python -m http.server`). For GitHub Pages, publish this folder and bump `VERSION` in `sw.js` after every change.

## Credits

Made by [Werkplaats Marc](https://www.werkplaatsmarc.be).

Built with [three.js](https://threejs.org/) (MIT) and [fflate](https://github.com/101arrowz/fflate) (MIT), bundled in `vendor/`.

## License

MIT, see [LICENSE](LICENSE).

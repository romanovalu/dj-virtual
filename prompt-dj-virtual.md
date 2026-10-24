Hablá conmigo en español (rioplatense). Quiero un **DJ virtual con IA** que corra en esta PC y que se maneje con mi controlador **Numark DJ2GO2**. Construilo en ESTA carpeta (`dj-virtual`), con `git init`, usando **Vite + TypeScript**.

## Qué construir (MVP)
1. **Dos decks** (A y B) con Web Audio API: play/pausa, cue, pitch/tempo (con time-stretch que preserve el tono, por ejemplo SoundTouchJS), nivel por canal, EQ de 3 bandas, crossfader, forma de onda y preescucha si se puede (setSinkId).
2. **Fuentes de música**:
   - Archivos locales (MP3/WAV/FLAC) con arrastrar y soltar. Es el modo completo.
   - Links de YouTube con la **IFrame Player API** oficial. Es un "modo básico": crossfade con setVolume, tempo solo en pasos fijos, sin EQ y sin análisis de BPM. No implementes descarga de audio de YouTube.
3. **IA / Auto-DJ** (con archivos locales): BPM, beatgrid y tonalidad con essentia.js; orden del set por BPM, energía y Camelot; mezclas en frases de 16 o 32 compases; transiciones automáticas (beatmatch, bajar los graves del tema saliente, crossfade, filtro). Modo híbrido: si toco el controlador, la IA me cede el control de ese deck.
4. **DJ2GO2 por Web MIDI** (Chrome/Edge): mapeo por defecto (abajo) más un modo **MIDI Learn** guardado en localStorage. LEDs: mandar la misma nota de vuelta (velocity 127 encendido, 0 apagado). Avisar en la interfaz que Serato DJ Lite tiene que estar cerrado.

## Mapeo DJ2GO2 (extraído de mi archivo de Traktor "Numark DJ2GO2 Performance Map.tsi")
Los canales MIDI se cuentan de 1 en adelante y las notas son números MIDI. Lo marcado con "?" es inferido: confirmalo con MIDI Learn.

**Deck A = canal 1, Deck B = canal 2:**
- Nota 0: Play/Pausa (LED)
- Nota 1: Cue (LED)
- Nota 2: Sync (LED)
- Nota 27: cue de auriculares / PFL (LED)
- CC 6: jog wheel, relativo
- CC 9: pitch fader
- CC 22: nivel del canal?

**Pads: Deck A = canal 5, Deck B = canal 6:**
- Notas 1–4: hot cues 1–4 (LED)
- Notas 17, 18: loop/beatjump?
- Notas 19, 20, 35, 36: tamaño de loop / mitad / doble?
- Notas 33, 34: sampler o loop in/out?
- Notas 49–52: FX?

**Master = canal 16:**
- CC 0: perilla Browse (encoder relativo)
- Nota 6: botón Browse (push)
- Nota 2: Load en el Deck A; Nota 3: Load en el Deck B
- CC 8: crossfader?; CC 10 y CC 12: master / cue mix / volumen de auriculares?

Bytes de estado: Note On = 0x90 + (canal − 1), CC = 0xB0 + (canal − 1). Por ejemplo, Play en el Deck A = `90 00 7F`.

## Pasos
1. Primero, una página de **Monitor MIDI** para validar el mapeo conmigo tocando el controlador.
2. Después, los decks y el Auto-DJ.

Terminado = `npm run dev` abre la app, el DJ2GO2 controla ambos decks y el Auto-DJ mezcla una cola de temas locales con beatmatching.

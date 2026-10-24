# DJ Virtual IA

DJ virtual en el navegador (Vite + TypeScript + Web Audio) controlado con un **Numark DJ2GO2** por Web MIDI, con Auto-DJ que analiza y mezcla temas locales con beatmatching.

## Online

La app se publica sola en **GitHub Pages** con cada push (`.github/workflows/pages.yml`: tests → build → deploy). Es instalable (PWA): en Chrome/Edge aparece **📲 Instalar** y queda como programa con ícono, que abre sin internet (salvo YouTube). Tu música nunca se sube: se lee de tu PC.

## Arrancar

```bash
npm install
npm run dev
```

Abrí la app en **Chrome o Edge** (Web MIDI). **Cerrá Serato DJ Lite** antes: en Windows el DJ2GO2 sólo puede estar conectado a un programa a la vez.

- `index.html`: la app (decks, mixer, biblioteca, Auto-DJ).
- `midi-monitor.html`: el **Monitor MIDI**, para confirmar el mapeo tocando cada control. "Copiar reporte" copia un JSON con lo confirmado, lo que falta y los controles sin mapear.

## Tres modos

- **🎉 Fácil**: para alguien que no sabe de DJ. Elegís el tipo de fiesta (previa, cumple, cena, boliche) y ajustás la curva de energía; la IA arma el set y hace toda la técnica. En vivo hay botones de intención: *Pasar ya*, *Que dure*, *Más energía*, *Bajar un cambio*, *Pedidos*, momentos cuantizados (*Drop*, *Break*, *Salida con eco*, *Rebobinar*, *Roll*) y el sampler que siempre caen en el compás. "Mezclá vos" es un crossfader asistido: lo movés y la IA iguala el tempo y cambia los graves al ritmo de tu mano. Cada pasaje tiene un semáforo (verde/amarillo/rojo).
- **🎓 Aprender**: lecciones sobre mezclas reales. La IA te avisa qué tocar y cuándo (resaltado en pantalla, LED titilando en el DJ2GO2 y cuenta regresiva en compases), te cede sólo ese control y, si no llegás, lo hace ella. Al final hay una devolución. Niveles: 1 preescuchar, 2 entrar en el compás 1, 3 crossfader, 4 igualar el tempo, 5 cambio de graves, 6 efectos (roll, sampler, eco de salida). Cada nivel se desbloquea con 2 mezclas sin ayuda.
- **🎛 Pro**: todos los controles (lo que se describe abajo).

En Modo Fácil el DJ2GO2 cambia de mapeo: crossfader = mezcla asistida, pads 1-4 = Pasar ya / Que dure / Drop / Salida con eco, Sync A/B = bajar/subir energía, jog = filtro, Load = pedir el tema elegido.

## Qué hace

- **Dos decks** con AudioWorklet: play/pausa, cue estilo CDJ, hot cues, loops, beatjump, pitch ±8/16/50 % con **keylock** (SoundTouch / WSOLA), nudge, eco y filtros, freno.
- **Mixer**: EQ de 3 bandas con kill, filtro bipolar, fader, crossfader de potencia constante, master con limitador.
- **Efectos al ritmo** por deck: eco (¾ de tiempo), reverb, flanger (ciclo de 2 compases), gate (corcheas), beat roll ½ · ¼ · ⅛ con *slip* (al soltar, el tema sigue donde hubiera estado), filtros, freno y backspin.
- **Sampler** de 8 pads: sirena, bocina, riser, impacto, láser y platillo sintetizados (sin audios con derechos) + pads libres para tus propios sonidos (arrastrá un audio encima; quedan guardados en el navegador). Caen en el próximo tiempo, y el riser termina justo en el compás 1 de la frase. En el DJ2GO2: modo sampler de los pads (notas 33-36, inferido).
- **Preescucha** (PFL): en "Salidas de audio" elegís otro dispositivo para auriculares (`setSinkId`) o, si la placa expone 4 canales, master en 1-2 y auriculares en 3-4.
- **Análisis** con essentia.js en un Web Worker: BPM, beatgrid (afinada a ~1 ms), downbeat, tonalidad (perfil EDMA) → Camelot, energía 1-10. Se guarda en caché en `localStorage`.
- **Auto-DJ**: ordena el set por BPM, Camelot y energía; mezcla en frases de 16 o 32 compases con arranque sincronizado al reloj de audio, corrección de fase continua, bass swap, crossfade y filtro pasa altos; después vuelve de a poco al BPM original del tema.
- **Modo híbrido**: con el Auto-DJ prendido, tocar un deck (en el controlador o en pantalla) se lo saca a la IA; "Devolver a la IA" lo devuelve. Lo mismo para el crossfader.
- **YouTube (modo básico)**: links con la IFrame Player API oficial. Volumen y crossfade con `setVolume`, tempo en los pasos que da YouTube, sin EQ, sin preescucha y sin BPM. En el Auto-DJ se mezclan con un crossfade de 12 s antes del final, sin beatmatching. No se descarga audio.

## Biblioteca guardada

Con **+ Carpeta**, **+ Archivos** o arrastrando archivos/carpetas, la app guarda el *acceso* (File System Access API de Chrome/Edge; no copia la música) y los links de YouTube. Al volver aparece "Reconectar mi música": un click y vuelve todo, con los análisis ya hechos. Las carpetas se releen en cada visita, así que lo que agregues ahí aparece solo. La ✕ de cada fila saca un tema de la biblioteca.

## MIDI

El mapeo por defecto sale del archivo de Traktor (`src/midi/mapping.ts`). Lo marcado con **?** es inferido: confirmalo con el Monitor o reasignalo con **MIDI Learn** (se guarda en `localStorage`). LEDs: se devuelve la misma nota con velocity 127 (encendido) o 0 (apagado). Si el pitch fader va al revés, usá "Invertir pitch fader" en MIDI Learn.

## Tests

```bash
npm test
```

- `deck-core.test.ts`: error de la posición reportada con keylock (< 1 ms de media entre −10 % y +10 %).
- `plan.test.ts`: elección de frases, half/double time, ajuste de grilla y orden del set.
- `beatmatch.test.ts`: simula una mezcla 124→128 BPM y mide la alineación real de los golpes a la salida.

`npm run test-tracks` genera temas sintéticos en `test-audio/` (ignorado por git) para probar sin música propia.

## Licencia

Este proyecto es software libre bajo la **GNU AGPL-3.0 o posterior** (ver [LICENSE](LICENSE)): podés usarlo, estudiarlo, modificarlo y compartirlo; si publicás una versión modificada (también como servicio online) tenés que compartir su código con la misma licencia.

Dependencias: essentia.js (**AGPL-3.0**) y SoundTouchJS (**LGPL-2.1**). Los sonidos del sampler se sintetizan en el código, sin audios de terceros.

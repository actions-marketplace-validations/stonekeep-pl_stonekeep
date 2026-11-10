# Stonekeep demo video: prompts for ElevenLabs

ElevenLabs makes sound (voice, sound effects, music), not the picture. The picture is recorded from the
site by `record.mjs`. The video is assembled in any editor (CapCut, DaVinci Resolve, Premiere).
Names of ElevenLabs features and models change, so check them in your plan; the idea stays the same.

Language of the video: **Polish**. Length: **about 106 seconds**, 11 scenes (see `timeline.json`).

---

## 1. Voice (Text to Speech)

### Option A: design a new voice (Voice Design)

Paste into the voice description field:

```
A calm, confident Polish male voice, 35 to 45 years old, warm baritone. Speaks like the narrator of a
luxury watchmaker film: unhurried, precise, quietly authoritative, no hype and no salesman energy.
Clear diction, natural Polish pronunciation, slight pause after each sentence. Studio quality, close
microphone, no background noise.
```

Female variant (if you prefer):

```
A calm, composed Polish female voice, 30 to 40 years old, low and warm. Elegant, unhurried, precise,
like the narrator of a luxury brand film. Clear Polish diction, soft authority, no exaggerated
enthusiasm. Studio quality, no background noise.
```

### Option B: pick a ready voice

In the Voice Library filter: language **Polish**, style **narrative / professional**. Listen to the first
scene text before you commit.

### Settings (starting point, adjust by ear)

| Setting            | Value                                            | Why                                                |
| ------------------ | ------------------------------------------------ | -------------------------------------------------- |
| Model              | Multilingual (the newest one offered for Polish) | needed for good Polish                             |
| Stability          | 55 to 65%                                        | steady, "expensive" delivery                       |
| Similarity         | 75%                                              | keeps the voice consistent between scenes          |
| Style exaggeration | 0 to 10%                                         | no theatrics                                       |
| Speed              | 0.95 to 1.0                                      | the text is written for about 2.3 words per second |

### How to generate

Generate **each scene separately** (11 clips). Then every clip fits its slot in `timeline.json`, and a
retake of one scene does not change the others. The texts are in `script-pl.md`. If a clip is longer than its
slot, raise the speed to 1.05 or shorten the sentence; if shorter, leave silence.

Spelling for the model: numbers are written out in words on purpose ("siedemdziesiąt dwie godziny"), so
the voice does not read them in the wrong form. Say "UODO" as letters: if the voice reads it as a word, write
"U O D O" in that scene. "RODO" and "PESEL" are read as words, which is correct in Polish.

---

## 2. Music (one track, 110 seconds)

```
Minimal cinematic electronic score for a luxury technology film. Slow, restrained, elegant. Soft deep
piano notes and a warm sub-bass pulse, delicate watch-like ticking percussion in the background,
a faint shimmering pad. Tempo 76 BPM. Builds very gently in the middle, resolves with a single clean
chord at the end. No vocals, no drums drop, no big climax. Dark, precise, refined, like a Swiss
watch commercial. Instrumental.
```

Length: 110 s. Mix it **about 18 dB below the voice**. In the last 8 seconds (scene 11) let it rise by
3 dB and end on a held chord.

---

## 3. Sound effects (Sound Effects), 2 to 6 seconds each

| Scene (time)  | Prompt                                                                                        | Length |
| ------------- | --------------------------------------------------------------------------------------------- | ------ |
| 2 (6 s)       | `Soft low pulse like a heartbeat, subtle, cinematic tension, no melody`                       | 4 s    |
| 3 (15 s)      | `Quiet digital scanning sweep, thin high-frequency beam moving across, clean sci-fi UI`       | 3 s    |
| 3 to 4 (hits) | `Short crisp UI highlight tick, glassy, very quiet` (use 5 times, one per found field)        | 0.5 s  |
| 4 (28 s)      | `Single soft confirm click, premium UI button press`                                          | 0.5 s  |
| 5 (33 s)      | `Slow ticking clock, mechanical watch, close microphone, steady` (loop under the whole scene) | 9 s    |
| 9 (card)      | `Plastic payment card tapped on a card terminal, short contactless beep`                      | 1 s    |
| 9 (reader)    | `Payment terminal reading a card, rising electronic tones`                                    | 2 s    |
| 9 (approved)  | `Payment terminal approved confirmation beep, two short pleasant tones`                       | 1 s    |
| 10 (invoice)  | `Heavy rubber stamp pressed on paper, short dull thud, office`                                | 1 s    |
| 10 (delete)   | `Five quick soft digital erase sounds, data being wiped, clean, one after another`            | 4 s    |
| 11            | `Deep subtle cinematic hit with long fade, premium brand reveal`                              | 3 s    |

Exact moments to place the sounds are on the screen at: card tap about 70 s, approved about 76 s,
invoice stamp about 90 s (see "Sync" in `README.md`).

---

## 4. Optional: the same video in English

Ask for the English version by translating the lines in `script-pl.md`, keeping the length of each line.
Use the same Voice Design prompt, but replace "Polish" with "English".

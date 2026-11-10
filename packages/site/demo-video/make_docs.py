"""Builds script-pl.md and subtitles.srt from timeline.json. Run: python make_docs.py"""
import io, json, os

here = os.path.dirname(os.path.abspath(__file__))
tl = json.load(io.open(os.path.join(here, 'timeline.json'), encoding='utf-8'))


def stamp(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def clock(t):
    return f'{int(t // 60)}:{int(t % 60):02d}'


rows = []
srt = []
for i, s in enumerate(tl['scenes'], 1):
    words = len(s['vo'].split())
    span = s['to'] - s['from']
    rows.append(f"| {s['id']} | {clock(s['from'])} to {clock(s['to'])} | {span:g} s | {s['screen']} | {s['vo']} | {words} |")
    # subtitle appears 0.3 s after the scene starts and leaves 0.3 s before it ends
    srt.append(f"{i}\n{stamp(s['from'] + 0.3)} --> {stamp(s['to'] - 0.3)}\n{s['vo']}\n")

md = f"""# {tl['title']}: scenariusz i lektor

Długość: {tl['length_seconds']} s. Czytaj tempem około 2,3 słowa na sekundę (kolumna "Słowa" pokazuje długość).
Czasy odnoszą się do nagrania ekranu po odcięciu początku (patrz `out/offset.txt`).

| # | Czas | Okno | Na ekranie | Lektor (PL) | Słowa |
|---|---|---|---|---|---|
""" + '\n'.join(rows) + """

## Pełny tekst do jednego odczytu (do wklejenia w ElevenLabs, jeśli generujesz całość naraz)

"""
md += ' '.join(s['vo'] for s in tl['scenes']) + '\n'
io.open(os.path.join(here, 'script-pl.md'), 'w', encoding='utf-8', newline='\n').write(md)
io.open(os.path.join(here, 'subtitles.srt'), 'w', encoding='utf-8', newline='\n').write('\n'.join(srt))
print('ok', len(tl['scenes']), 'scenes')

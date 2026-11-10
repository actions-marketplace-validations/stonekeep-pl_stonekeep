# Stonekeep: demo video kit

Everything needed to make a ~106 s Polish demo video of the promo site.

| File                    | What it is                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `timeline.json`         | The single source of truth: 11 scenes, start and end second, what is on screen, voice-over line |
| `script-pl.md`          | Voice-over script as a table (generated from the timeline)                                      |
| `elevenlabs-prompts.md` | Voice design prompt, voice settings, music prompt, 11 sound-effect prompts                      |
| `subtitles.srt`         | Polish subtitles, timed to the scenes                                                           |
| `record.mjs`            | Records the site as 1920x1080 video, scene by scene, by the timeline                            |
| `make_docs.py`          | Rebuilds `script-pl.md` and `subtitles.srt` after you edit `timeline.json`                      |
| `out/screen.webm`       | The screen recording (made by `record.mjs`, ignored by git)                                     |

## Make the video, step by step

1. **Record the screen** (the site must be running):
   ```bash
   node packages/site/serve.mjs            # in one terminal, http://127.0.0.1:4173 (or PORT=4180)
   node packages/site/demo-video/record.mjs http://127.0.0.1:4173
   ```
   It takes about two minutes and needs no clicking: it scrolls, switches the scenes, types the form,
   pays at the terminal and deletes the data. It prints the page-load offset (about 3 s). **Trim that many
   seconds from the start of `out/screen.webm`** in your editor, then the times in `timeline.json` are exact.
   It can also record the AWS address instead: `node record.mjs https://d3p68103xdxjhz.cloudfront.net`.
2. **Voice**: follow `elevenlabs-prompts.md`, section 1. Generate 11 clips from `script-pl.md`.
3. **Music and sound effects**: sections 2 and 3 of the same file.
4. **Assemble** in any editor: screen video on track 1, voice clips on track 2 (each starts at the scene's
   `from` second), music on track 3 at about -18 dB, sound effects on track 4. Import `subtitles.srt`
   for captions (or burn them in).
5. **Export** 1920x1080, 30 fps, H.264 MP4.

## Sync

Two scenes depend on live animation (the timings below were measured before the receipt was removed, so run `record.mjs` again for exact numbers), so their real times drift a little from the plan. After
recording, `timeline.json` already holds the measured times (card scene to 83.5 s). Key moments:

| Moment                                          | About  |
| ----------------------------------------------- | ------ |
| Form submitted, full-screen payment scene opens | 73.5 s |
| Card tapped / terminal reads                    | 75 s   |
| Approved                                        | 77 s   |
| Deletion starts (button pressed)                | 85 s   |
| Invoice stamp "ZOSTAJE"                         | 90 s   |

If your machine is slower or faster, the numbers move by a second or two. Look at the recording and
shift the voice clips of scenes 9 and 10 by that amount.

## Change the video

- Different texts or timing: edit `timeline.json`, then `python packages/site/demo-video/make_docs.py`,
  then record again if you changed scene lengths (`record.mjs` reads the same file).
- The recording uses the demo data "Anna Kowalska, Sklep Lniany" (edit the `keyboard.type` lines in `record.mjs`).
  Nothing is sent anywhere while `demoEndpoint` in `config.js` is empty.

## Before you publish the video

- The numbers in the narration (72 hours, one month, EUR 20 million) are statements of the law (art. 33, art.
  12 ust. 3 and art. 83 ust. 5 RODO). The product claims ("Stonekeep czyści bazę, płatności i newsletter")
  describe what the connectors do in the demo; the PayU, Przelewy24 and Mailchimp connectors were written from
  public documentation and have not been tested on live accounts. Do not present them as proven until they are.
- The last line "Zamów demo" assumes the form delivers requests somewhere. It does not yet.

# subreview

A dashboard for proofreading translations for transcribed video files (in .mp4) written 
in Chinese and English. The translations are assumed to be properly formatted in JSON
and named with the `*.translated.json` convention. This dashboard is essentially
a subtitle editor suited for my specific needs. It can play the episode, preview 
subtitles as the generated ASS file (what is actually used for subtitles on streaming
platforms) would draw it, edit specific lines of translations, and generate ASS files.


## How a folder's subtitles look: subreview.json

There is one renderer, in `subrender/`, and every show goes through it. For 
a given folder with translation JSON files, there should be a `subreview.json`
file that is defined to describe the exact configuration and requirements
for actually rendering the ASS files; a subfolder such as `reviewed/` uses its 
parent's configuration.

```json
{
  "variants": ["combined", "chinese", "english"],
  "timing": {"fix_overlaps": true, "extend_short_cues": false},
  "style": { "zh_size": 0.0464, "box_covers": "chinese", ... }
}
```

- **variants** — which files Generate writes: `combined` (`<episode>.ass`,
  pinyin + hanzi + English), `chinese` (`.zh-CN.ass`) and `english` (`.en.ass`).
- **timing** — optional clean-up at render time, both off by default.
  `fix_overlaps` trims an end that laps the next cue and drops an overlapping
  exact duplicate; `extend_short_cues` holds a too-brief cue longer so it can be
  read. Whatever either would do shows in the cue list (`end → mm:ss.cc`,
  `dropped at render`) before you generate.
- **style** — every visual setting. `subrender/style.py` documents each field;
  the two configs on this machine spell all of them out, so the place to change
  a show's look is its own file. Sizes and spacings are fractions of the frame
  height, colours are RGB hex.

**What you type is what renders.** The renderer never edits text: the hanzi and
English are drawn exactly as the transcript has them. jieba decides where the
words fall, and a space you type into the hanzi forces a break there — `听明
白了吗?` puts 明 and 白 under separate pinyin. Pinyin is always derived from
the hanzi.

**Two rules the layout applies everywhere.** Punctuation closes up against the
word before it and never starts a row of its own (it may overhang the margin
instead); a line with no pinyin at all, such as English lyrics typed into the
hanzi field, drops the empty pinyin row.

## Reviewing

Pick an episode from the menu at the top. Click any cue to select it, which
seeks the video to its start and opens an inline editor.

The clock reads `MM:SS.cc`, and `⇱ here` / `⇲ here` set the selected cue's start
or end to the exact playhead position.

**Tags** flag things worth a second look: `2 lines` (the Chinese wrapped onto a
second row), `93% wide` (one more character and it will), `no English`,
`end ≤ start`, and the render-timing tags above. **Issues only** filters the
list down to just those.

**Removing a line** is two-stage. `Mark for removal` struck it through, hides it
from the preview, and shows every following cue's new number next to its old
one. Nothing leaves the file until you save, and marking is reversible.

**Any edit to a cue rewinds to its start** — a timestamp, the hanzi, or the
English — because the thing you want next is almost always to watch the cue
again and see whether it fits. `Enter` replays it. Nothing auto-plays: the
rewind leaves you paused so you can keep working.

Text edits use a longer pause before rewinding than timestamps do, since
rewriting a translation stops and starts far more than typing four digits.

**Pushing an end past the next cue moves that cue's start along**, since an
overlap is never what you want and the renderer would only trim it back. It
never moves a neighbour earlier, so shortening a cue reopens the gap rather than
dragging anything with it, and cues already marked for removal are skipped.

The rewind fires immediately for the buttons and the keyboard nudges. When you
*type* it follows your keystrokes at a distance instead, but the
overlap push waits until you commit with `Tab` or `Return` — otherwise typing
`95` would drag the next cue to `9` on the way past.

Because the rewind parks the playhead inside the cue, a second press of `O`
would set the end back to the start and invert the cue. Buttons and keys refuse
that and say so; typing is still free, and an inverted cue is flagged
`end ≤ start` in the list.

**Checking a cue against the burned-in original.** On a show with burned-in subtitles, our
subtitles sit on an opaque backdrop directly over the line burned into the
picture, so the thing you would need to see in order to confirm the Chinese was
read correctly is exactly the thing the overlay is covering. Two ways to get it
out of the way:

- **`◌ original`** in the cue's editor, or `Shift`+`Enter`, plays that one cue's
  time range with the overlay hidden and puts it straight back when the cue
  ends. Use this to read a line and compare.
- **`◉ Overlay on`** in the header, or `H`, is a standing switch for when you
  want to watch a stretch of the episode as it came.

Whatever stops playback ends a one-cue pass — the cue's end, `Space`, clicking
another cue — so the overlay is never left off by surprise. The standing switch
survives changing episode; a one-cue pass does not.

**Splitting a cue** (`⑃ split here`, or `S`) cuts the selected cue in two at the
playhead. The timing split is exact; the text is divided at the punctuation mark
nearest the split point — a comma, a full stop, an English sentence end — falling
back to proportion when there is nothing to break on. Treat it as a first guess
and check both halves.

**`+ cue below`** (or `N`) inserts an empty cue in the gap after the selected
one and puts the cursor in its hanzi field. New cues show as `new` until you
save, at which point they get their number along with everything else.

**Saving** (`⌘S`) writes the lean editable shape: marked cues dropped, `n` renumbered to a
clean `1..N`, pinyin recomputed, two decimal places on the timings. The first
save of a file copies the original to `<name>.json.bak` next to it; later saves
leave that backup alone, so it always holds the state before your first edit.
The write goes to a temp file and is swapped into place, so an interrupted save
cannot truncate a transcript.

## Getting your edits onto the video

**Generate** (`⇧⌘S`) saves first if there are unsaved edits, then writes the
`.ass` files the folder's `subreview.json` asks for into the transcript's own
folder, and nowhere else. A file it replaces is kept under
`backups/` beside the transcript; a file that would come out the same is left
alone and reported `unchanged`. The toast lists every file.

## Keyboard

| | |
|---|---|
| `Space` | play / pause |
| `Shift`+`<` / `>` | back / forward 1 second |
| `,` / `.` | back / forward 0.1 second |
| `←` / `→` | back / forward 1 second |
| `J` / `L` | back / forward 5 seconds |
| `↑` / `↓` | previous / next cue |
| `Enter` | play just the selected cue |
| `Shift`+`Enter` | play it with the overlay hidden, to read the burned-in subtitle |
| `H` | hide / show the overlay |
| `I` / `O` | set start / end to the playhead |
| `[` `]` | nudge start −/+ 0.05s |
| `{` `}` | nudge end −/+ 0.05s |
| `S` | split the cue in two at the playhead |
| `N` | add an empty cue below |
| `Delete` | mark / unmark for removal |
| `⌘S` | save |
| `⇧⌘S` | generate the `.ass` (saves first) |
| `Esc` | leave the text field |

Text fields swallow the playback keys — press `Esc` first to scrub. `⌘S` and the
timing buttons always work.

## Requirements

Mac fonts are used, so ideally use a Mac to run this.

## The browser build: Google Drive, no server

There are two folders to specify maintained via Google Drive:

- **Subtitles folder**, read and written: the `*.translated.json` files (in
  subfolders too), any `subreview.json`, and the `.ass` files Generate writes
  beside them.
- **Videos folder**, only ever read: contains the actual videos that are being
subtitled and matched to a transcript by file name

Saving and generating:

- **Save** keeps the first `.json.bak`.
- **Generate** renders what was saved, reports `unchanged`, and keeps a
  replaced `.ass` under `backups/`.

On top of that:

- **Changed elsewhere.** If a transcript changed in Drive since you opened it,
  saved from another computer for instance, Save asks before overwriting it.
- **The sign-in lasts an hour.** When it runs out, **Reconnect Google**
  appears at the top and your edits stay on screen until you save again.
- **The video is fetched whole** when you open an episode, about 50 MB. A
  `<video>` cannot send Drive's sign-in header, so it cannot stream from Drive.

### Setting up Google sign-in (once)

1. Make a project at <https://console.cloud.google.com/> and enable the
   **Google Drive API** for it (APIs & Services → Library).
2. **Google Auth Platform → Branding / Audience**:
   - Give the app any name and set the audience to *External*.
   - Leave it in **Testing**.
   - Add your own Google account under **Test users**. Nobody who is not on
     that list can sign in.
3. **Clients → Create client → Web application**. Under *Authorized
   JavaScript origins* add:
   - `https://mzhang8.github.io`

   No redirect URI is needed. Copy the client ID.
4. Open the page and paste in the client ID and the two folders (their links
   or IDs). They are kept in that browser's local storage, not in the code.

Google warns that the app is unverified: choose *Continue*. The app asks for
full Drive access, because that is the only scope that can rewrite a file it
did not create. The code reads only the two folders and writes only to the
subtitles one (`writable` in `web.js`).

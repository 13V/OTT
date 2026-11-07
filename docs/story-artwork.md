# Story artwork: the otter

The website and the app tell OT+T's story through one character, an otter, drawn in ink. This
page records the character, the style, where each scene is used and how the scenes were made, so
the next scene can match them.

## Why an otter

The ticker reads as "otter", and a mascot suits a coin that launches on pump.fun. People use it
as a profile picture and as stickers. Three real sea-otter habits carry the product:

- **A stone in the pocket.** Sea otters keep a favourite stone in a pouch of loose skin under the
  forearm. Ours keeps a SIM: the welcome eSIM a member gets for joining.
- **Holding paws.** Resting sea otters hold paws so they don't drift apart. That is the promise of
  a data plan: stay connected.
- **The raft.** A group of otters resting together is called a raft. Members share each week's
  fees together.

The captions on the site say these facts in plain words. The rules themselves (the burn, the 80%
share, the 3× cap) are always in the HTML next to the scene, never in the picture.

## The character

[`art/otter-model-sheet.webp`](art/otter-model-sheet.webp) is the model sheet. It has four turnaround views, four expressions, the paw
holding the glowing SIM, and the otter floating with its phone. Every scene was generated with it
as a reference.

- An adult sea otter with a sleek build (not a pup).
- Dark chocolate-brown fur; a pale cream face, muzzle, cheeks and throat.
- Small rounded ears, round dark eyes with an amber glint, a broad dark nose, long pale whiskers.
- One accessory: a knotted neckerchief, Poppy Red on the site (signal orange in the source files).
  In group scenes only our otter wears it.
- A calm, confident half-smile.

## The style

The style is a premium editorial ink illustration. It is chosen so the pictures sit inside the dark
interface instead of competing with it.

- Confident hand-inked linework, with flat fills in warm black (Raven Black, the site's `--bg`).
- Cream for the otter's face and for paper-light details.
- One accent, Poppy Red (`#CF2E2D`, the site's `--accent`), used only for light sources and the
  neckerchief.
- Fine risograph grain and halftone texture, and generous dark negative space.
- No text, letters, numbers, readable signs or logos in any scene.

On the page each scene sits in a rounded panel (`.ott-story-figure` in `site/home.css`). The
drawing's ground is the page's black, so a panel needs no frame. Captions are one line of the
story, laid over the bottom of the scene or set under it.

## Where each scene is used

| File (`site/assets/story/`) | Size | Bytes | Scene | Used on |
| --- | --- | --- | --- | --- |
| `otter-hero.webp` | 1120 × 1394 | 109018 | Floating on its back in a night harbour, reading its phone | Home hero; app Home |
| `otter-join.webp` | 1040 × 1300 | 86626 | By a fire bowl where a coin melts, tucking a glowing SIM into its pouch | Membership, chapter 1 |
| `otter-raft.webp` | 1440 × 956 | 106020 | Seven otters in a ring holding paws, threads of fee light running to each | Membership, chapter 2 |
| `otter-airport.webp` | 1440 × 956 | 108176 | On a suitcase at a night airport gate, phone connected | Membership, chapter 3; app plans for most places |
| `otter-pier.webp` | 1440 × 956 | 80126 | Strolling along a lamp-lit pier, phone in paw | Coverage ("at home and away"); app plans for the United States |
| `otter-tokyo.webp` | 1440 × 956 | 266066 | Checking a map at a Tokyo scramble crossing | Travel ("Shibuya, Tokyo"); app Japan plans |
| `otter-den.webp` | 1440 × 956 | 220528 | In its den on a woven cushion, backpack and map ready | My data preview; app eSIMs |
| `otter-operator.webp` | 1440 × 956 | 106806 | Night operator at an old telephone switchboard, receipts on a spike | Before you burn (trust) |
| `otter-paws.webp` | 1040 × 1300 | 86550 | Two otters asleep under the stars, holding paws | The closing banner ("Where are you heading?") |
| `otter-help.webp` | 960 × 960 | 100790 | Showing a phone screen to the viewer | About; app Help |

The service worker's `ART` list in `site/sw.js` names these files. A new scene goes into that list
too, or the installed app won't keep it for offline use.

## How they were made

The scenes were generated on Higgsfield with the `gpt_image_2_6` model, at medium quality and 2K
resolution (1 credit each). The approved test frame of the floating otter was upscaled to 2K
rather than regenerated. Every scene passed two references: the model sheet and that frame. The
scenes came out in the first palette, deep ink-navy with a signal-orange accent. Each was then
recoloured to the current one with [`art/recolor.py`](art/recolor.py) (Python 3 with Pillow and
NumPy), which turns the navy to a warm black that meets `#080202`, moves orange and the warm
browns to Poppy Red, deepens the darks and keeps the lights. It also scales the scene and writes
the WebP:

```sh
python3 docs/art/recolor.py source.png site/assets/story/otter-new.webp 1440 74
```

Every scene uses quality 74, except the two busiest (Tokyo and the den), which use 60. A new scene
goes through the same two steps: the prompt below with the two references, then the recolour.

Each prompt named the scene and its composition, then ended with the same block:

```text
Match the reference images exactly: the same otter (dark chocolate-brown fur, pale cream face and
throat, small rounded ears, long pale whiskers, knotted signal-orange neckerchief) and the same
premium editorial ink style — confident hand-inked linework, flat duotone fills in deep ink-navy
and near-black, cream for the otter's face and paper-light details, a single signal-orange
(#FF6A2C) accent used only for light sources and the neckerchief, fine risograph grain and
halftone texture, crisp graphic shapes, generous dark negative space. No text, letters, numbers or
readable signs anywhere, no logos, no watermark, no frame borders, no extra limbs or tails, no 3D
render look.
```

Scene briefs:

- **Joining (4:5):** night at the edge of a dark harbour. The otter stands on a flat rock beside a
  small iron fire bowl, where a coin dissolves into the embers and sparks rise. With one paw it
  tucks a glowing orange SIM card into the fold of fur under its left forearm.
- **The raft (3:2):** seen from slightly above. Seven otters float on their backs in a ring,
  holding paws; only the main otter wears the neckerchief. Streams of orange light flow from the
  distant city into the middle of the ring, and a thread runs from there to each otter's paws.
- **Tokyo (3:2):** a scramble crossing at night. The otter stands at the curb with a small navy
  backpack and a phone showing a glowing map route. Crowds are drawn as silhouettes, and the
  signboards are abstract rectangles with no readable characters.
- **Airport (3:2):** a quiet gate at night. The otter sits on a hard-shell suitcase by a tall
  window, phone glowing. An airliner with an orange beacon waits outside. A split-flap board shows
  only blank tiles and a few lit ones.
- **Operator (3:2):** the otter as the night operator of an old telephone exchange. It wears a
  headset and plugs a glowing patch cord into a cord switchboard. Blank receipts sit on a spike
  beside a brass desk lamp.
- **Holding paws (4:5):** two otters asleep on their backs under a starry sky, holding paws,
  loosely wrapped in kelp, with a dimmed phone on the main otter's belly.
- **Help (1:1):** a waist-up portrait. The otter holds a phone toward the viewer and points at an
  abstract orange grid on the screen (not a real QR code).
- **Den (3:2):** a riverside den at night. The otter sits on a woven cushion with its phone, a
  small navy backpack, a folded map and a mug; a round window shows the harbour.
- **Pier (3:2):** the otter walks upright along a wooden pier at night, phone in paw. Mooring posts
  carry small orange lamps, with the city across the water.

The art never shows balances, package sizes, activation details or installation status. Those
are always HTML.

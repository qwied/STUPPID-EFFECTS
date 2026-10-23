# STUPPID EFECTS

Stack video effects on photos, videos (with sound) and GIFs right in your browser. Attach a file, drag and drop it, or paste it with Ctrl+V.

- Timeline under the preview:
  - **black bar** — media length (drag its right end; trims a video, sets the length of a photo or GIF),
  - **blue bar** — where an effect is on (drag its name tab to move it, drag its ends to resize),
  - **green boxes** — single bursts of the effect (drag to move, stretch an edge to make it slower or faster, add one with "+ Burst" or a double-click on its row, select + Delete to remove; overlapping bursts get their own sub-rows).
- Unlimited effect layers: opacity, size, speed, blend mode (normal / screen / add — the template background is always removed), loop-fill button, order.
- Landscape, portrait and square media are detected automatically; effects keep their proportions and stretch to cover the whole frame.
- Save as MP4 (with the original audio) or GIF, from 144p to 4K — Original quality by default.
- Custom templates: use "Custom template" with any video on a green or black background; the background is detected and removed automatically.
- Nothing is uploaded to a server — everything runs on your device.

## Publish on GitHub Pages

1. Create a repository on GitHub and upload all files from this folder (`index.html`, `style.css`, `app.js`, `explosion.mp4`, `lightning.mp4`, `.nojekyll`, `README.md`).
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. In a minute the site is live at `https://<username>.github.io/<repository>/`.

## Add a built-in template

Put the video next to `index.html` and add a line at the top of `app.js`:

```js
{ id: 'smoke', name: 'Smoke', url: 'smoke.mp4', bg: 'green', mode: 'normal' }, // bg: green | black | none; mode: normal | screen | add
```

> MP4 and GIF are rendered frame by frame, so the result is smooth even on a slow device or a background tab.

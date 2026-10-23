# STUPPID EFECTS

Stack video effects on photos, videos (with sound) and GIFs right in your browser.

- Unlimited effect layers: start time, opacity, size, mode (chroma key / screen / normal), loop, order.
- Landscape, portrait and square media are detected automatically; effects rotate and stretch to cover the frame.
- Save as MP4 (with the original audio) or GIF, from 144p to 4K — Original quality by default.
- Custom templates: use "Custom template" with any video on a green or black background; the mode is detected automatically.
- Nothing is uploaded to a server — everything runs on your device.

## Publish on GitHub Pages

1. Create a repository on GitHub and upload all files from this folder (`index.html`, `style.css`, `app.js`, `explosion.mp4`, `lightning.mp4`, `.nojekyll`, `README.md`).
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. In a minute the site is live at `https://<username>.github.io/<repository>/`.

## Add a built-in template

Put the video next to `index.html` and add a line at the top of `app.js`:

```js
{ id: 'smoke', name: 'Smoke', url: 'smoke.mp4', mode: 'key' }, // key | screen | normal
```

> MP4 is recorded in real time: a 10-second clip takes about 10 seconds to save.

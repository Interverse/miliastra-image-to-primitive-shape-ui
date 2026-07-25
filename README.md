# Miliastra Wonderland Image Fitting Tool

A fully static, browser-only web app that approximates images with primitive shapes (circles, rectangles, triangles) for Genshin Impact's "Miliastra Wonderland" (千星奇域) UGC mode. The repository root is the deployable site ([index.html](index.html)): all fitting, GIA export, and GIA mode conversion run client-side with no backend, producing output that is bit-identical to the original Python/Go implementation. See [SITE.md](SITE.md) for deployment notes and [tests/parity](tests/parity/README.md) for the parity regression suites.

> This project's code is entirely AI-generated.
>
> Some parts of the code are not convenient to open-source; contact the author if you need them.

For the final technical design, see [tech.md](tech.md). For usage instructions, see [user_guide.md](user_guide.md).

## Features

- **Image asset-group fitting** — approximates an uploaded image with in-game primitive elements.

  ![](demo/demo2.png)

  Video tutorial (Bilibili): <https://www.bilibili.com/video/BV1kKDyB9EvY>

- **GIA export** — exports both **Beyond mode** and **Classic mode** `.gia` files, byte-identical to the original tool's output.
- **GIA mode conversion** — converts existing GIA files in both directions (Beyond ↔ Classic) from the upload page.
- **Enhanced mode (default)** — error-guided fitting, roughly 9x faster per primitive, fully deterministic.
- **Batch processing** — concurrent processing of multiple images via Web Workers.
- **15 UI languages** — all languages officially supported by Genshin Impact.
- **Additional export formats** — SVG, PNG, and CSS (see [Export options](#export-options)).

### Decoration outline fitting

![](demo/image2.png)

Decoration outline fitting is available from the **Decorations** link in the top bar and is covered by the parity test suite. (A deployment of a [historical commit](https://github.com/1475505/Miliastra-toolbox-primitive-shape/tree/b8045325a71a6b99fa07db8bd721d2ae289fcdec) of the earlier Python version remains available at <https://qx-shaper.up.railway.app/>.)

## Usage

Open the hosted GitHub Pages site (or a local server, see below), then:

1. Use the **Image Fitting** tab to upload one or more images, adjust settings, and run the fit.
2. Use the **GIA Mode Convert** tab to convert existing `.gia` files between Beyond and Classic modes.
3. From the result page, download the output in any of the export formats below.

## Export options

The result page currently offers:

- **Export SVG**
- **Export PNG**
- **Export CSS**
- **Export Beyond-mode GIA**
- **Export Classic-mode GIA**

### SVG

Converts the current primitive result to vector graphics using `ellipse`, `rect`, and `polygon` elements, preserving position, size, rotation, opacity, and color. If the result does not have a transparent background, the exported SVG adds a white background automatically.

### PNG

Exports the final rendered canvas from the result page — suitable for previewing, sharing, and archiving.

### CSS

Intended for front-end integration; it is **not** a drop-in single-file format. The export contains `.shaper-container`, `.shaper-element`, and `.shaper-element.shaper-e0` … `.shaper-eN` rules. You need at least one container node:

```html
<div class="shaper-container"></div>
```

and then create the matching child nodes with JavaScript:

```js
const container = document.querySelector('.shaper-container');
for (let i = 0; i < elementCount; i += 1) {
  const node = document.createElement('div');
  node.className = 'shaper-element shaper-e' + i;
  container.appendChild(node);
}
```

A ready-to-use `HTML + JavaScript` example is included as a comment at the top of the exported CSS file.

### GIA

Both **Beyond** and **Classic** GIA formats can be downloaded directly from the result page. To batch-convert existing GIA files, use the **GIA Mode Convert** tool on the upload page.

## Running locally

Serve the repository root with any static file server, e.g.:

```bash
python -m http.server
```

then open `http://localhost:8000/`. Opening `index.html` via `file://` does **not** work because the app uses Web Workers, which require an `http(s)` origin.

Deployment is plain GitHub Pages from the repository root — no build step or backend required.

## Project structure

- `index.html` — single-page app entry point
- `js/` — application and engine code
- `js/locales/` — UI translations (one file per language)
- `css/` — styles
- `tests/parity/` — bit-exact parity regression suites (Node-based)

## Testing

The parity suites verify that the JS port reproduces the original Python/Go implementation exactly. Each suite has a Python golden generator and a Node runner:

```bash
python tests/parity/<suite>/gen_goldens.py
node tests/parity/<suite>/run_tests.js
```

See [tests/parity/README.md](tests/parity/README.md) for the suite layout, the parity contract (determinism/libm caveats), and the reference environment.

## Localization

The UI is available in 15 languages (all languages officially supported by Genshin Impact): `de`, `en`, `es`, `fr`, `id`, `it`, `ja`, `ko`, `pt`, `ru`, `th`, `tr`, `vi`, `zh-CN`, `zh-TW`. To add a language, create a new file in `js/locales/` following the structure of an existing one (e.g. `en.js`) and register it alongside the others.

## Legacy Python backend (optional)

The repository also contains the original Python server (`server.py`), which the static port replaced. It is not needed for the web app, but can still be used directly. The GIA-export build artifacts require Python 3.13.

Install dependencies and run the server:

```bash
pip install -r requirements.txt
python server.py
```

Or export a GIA file directly from the CLI (supports `--gia-mode overlimit/classic` — the CLI keeps the legacy flag values, where `overlimit` is Beyond mode):

```bash
python server.py --cli --input demo.png --gia-mode classic --output output.gia
```

The backend requires the `primitive` executable in the `tools/` directory (the app fails when processing images without it). You can build it from source:

- Official repository: <https://github.com/fogleman/primitive/>
- With Go installed: `go install github.com/fogleman/primitive@latest`
- Windows: place it at `tools/primitive.exe`
- Linux/macOS: place it at `tools/primitive`

## Reference: in-game element IDs

### Circles

| Element | ID | Size |
| :--- | :--- | :--- |
| Adventure Coin | 10005009 | 1.0 |
| Electro Element Badge | 20001281 | 0.3 |
| Pyro Element Badge | 20001282 | 0.3 |
| Dendro Element Badge | 20001283 | 0.3 |
| Cryo Element Badge | 20001284 | 0.3 |
| Geo Element Badge | 20001285 | 0.3 |
| Hydro Element Badge | 20001286 | 0.3 |
| Anemo Element Badge | 20001287 | 0.3 |

### Rectangles

| Element | ID | Size |
| :--- | :--- | :--- |
| Wooden Crate | 20001224 | 1.0 |
| Stone Element Cube | 20001034 | 5.0 |
| Wooden Crate (Green) | 20001237 | 1.5 |
| Wooden Crate (Blue) | 20001238 | 1.5 |
| Wooden Crate (Purple) | 20001239 | 1.5 |
| Stone Wall (Yellow) | 20001869 | 3.0 |
| Stone Wall (Red) | 20001870 | 3.0 |
| Stone Wall (Gray) | 20001872 | 3.0 |
| Water Cube | 20001874 | 1.0 |
| Regular Cube (Cream Yellow) | 20001875 | 1.0 |
| Sturdy Cube (Dark Blue) | 20001876 | 1.0 |
| Ice Cube | 20001877 | 1.0 |
| Fire Cube | 20001878 | 1.0 |
| Electro Cube | 20001879 | 1.0 |
| Rectangular Wooden Low Cabinet | 20001082 | 1.0 |
| Building-Block Cube (Wood) | 20001096 | 6.0 |
| Building-Block Cube (Dark) | 20001097 | 6.0 |
| Building-Block Cube (Light) | 20001100 | 6.0 |
| Stone Ceiling (White) | 20002146 | 5.0 |
| Wooden Ceiling (Black) | 20002121 | 5.0 |
| Building-Block Platform (Green) | 10005014 | 5.0 |

## Links

- Knowledge base: <https://ugc.070077.xyz/>
- Repository: <https://github.com/Interverse/miliastra-image-to-primitive-shape-ui>
- Original repository (decoration fitting historical commit): <https://github.com/1475505/Miliastra-toolbox-primitive-shape>

## TODO

See the deployed web page.

## License

[MIT](LICENSE)

# Drift: a relative motion game

Drift is a turn-based browser game about flying one spacecraft near another. Each turn you choose one small burn, then the spacecraft coasts under the Clohessy-Wiltshire (CW) equations of relative motion. Stop a drift, move a perch, or circle the target on the least delta-V.

It is a companion to the [OTC OW interactive tools](https://brantleyforrest.github.io/OTC-OW-Pages/).

## Playing

- **Solo** play runs entirely in the browser and needs no server. Open `drift/index.html` from disk or from GitHub Pages.
- **Rooms** (a whole class flying the same scenario, or a two-player duel) use an optional WebSocket server that the site's owner runs. Room play is offline until that server is up.

## Layout

```
drift/      The game client (static files, no build step)
_server/    The optional multiplayer server (Node 20 or later, one package: ws)
assets/     Shared styles and helpers copied from the OTC OW site
practice/   KaTeX helpers copied from the OTC OW site
_template/  Page layout rules copied from the OTC OW site
```

Folders that start with an underscore are not published by GitHub Pages.

## Tests

```bash
node _server/test/core.test.js
```

## License

GNU GPL v3. See [LICENSE](LICENSE).

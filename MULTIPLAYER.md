# Playing co-op without npm, without admin rights

Everything here works on a machine where you cannot install software, cannot run
an installer, and cannot approve a Windows Firewall prompt.

---

## 1. You never needed npm

`package.json` has **no runtime dependencies**. Its `start` script is one line:

```
"start": "node tools/serve.js"
```

So `npm start` and `node tools/serve.js` do exactly the same thing — npm was only
ever forwarding the command. The single `devDependency` (`@types/three`) is there
so the editor can autocomplete three.js types; the game does not load it, and
`npm install` has never been required to play. `three` itself is vendored in
`vendor/three.module.js`.

Run the game with any of these:

```bat
play.cmd                      :: double-click it, or run it from a terminal
node tools/serve.js           :: the same thing, typed out
node tools/serve.js --port 9000
```

On macOS or Linux use `./play.sh` instead of `play.cmd`.

Then open <http://localhost:8080>. The terminal also prints your LAN address.

### If you want npm working again anyway

The usual no-admin failure on Windows is PowerShell refusing to run `npm.ps1`:

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
scripts is disabled on this system.
```

That is the execution policy, not a permissions problem, and there are three
fixes that need no administrator:

| Fix | How |
| --- | --- |
| Call the batch shim instead | `npm.cmd start` |
| Use Command Prompt instead of PowerShell | VS Code: **Terminal → New Terminal**, then pick **Command Prompt** from the dropdown next to the `+` |
| Allow scripts for your account only | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` — the `CurrentUser` scope writes to `HKCU` and does not prompt for elevation |

### If Node itself is missing

You still do not need admin. Download the **binary zip** (`node-vXX-win-x64.zip`,
not the `.msi` installer) from <https://nodejs.org/en/download>, unzip it into a
folder you own, and either add that folder to your user `PATH` or drop `node.exe`
into a `node\` folder next to `play.cmd` — the launcher looks there.

---

## 2. Why the Cloudflare extension said `spawn UNKNOWN`

The VS Code Cloudflare extension does not tunnel anything itself. It downloads
and launches a separate `cloudflared.exe`. `spawn UNKNOWN` is Windows telling
Node that it refused to start that process — the binary was never fetched, or it
landed somewhere your account is not allowed to execute from (AppData is a
common target of software-restriction policies), or an endpoint security product
quarantined it.

You cannot usually fix that without the rights you do not have. The options
below route around it instead.

---

## 3. Pick how your friends reach you

The relay runs inside the same server on the same port, so whatever exposes port
8080 exposes co-op too. **All of these work without admin, and none of them need
a firewall rule**, because a tunnel makes an *outbound* connection from your
machine — nothing has to be let in.

### Option A — Same house or same Wi-Fi: no tunnel at all

Run the server, read out the `http://192.168.x.x:8080` line it printed, and have
everyone open that. Simplest by far.

The catch on a locked-down machine: the first time Node listens, Windows shows
*"Allow Node.js to communicate on these networks"*, and clicking **Allow** needs
administrator rights. If you cannot approve it, inbound connections are dropped
and your friends will see nothing — use a tunnel below, which does not care.

### Option B — VS Code's built-in port forwarding (recommended for you)

This is already inside VS Code. No extension, no downloaded binary, nothing for
Windows to refuse to spawn — which is exactly the failure you hit.

1. Start the server (`play.cmd`).
2. In VS Code open the **Ports** panel — it is a tab next to **Terminal** in the
   bottom pane. If you cannot see it: **View → Command Palette → `Ports: Focus on Ports View`**.
3. Click **Forward a Port** and enter `8080`.
4. Sign in with GitHub or Microsoft when prompted.
5. **Right-click the row → Port Visibility → Public.** This step is not optional:
   left on *Private*, your friends hit a Microsoft login wall instead of the game.
6. Copy the generated address — it looks like
   `https://a1b2c3d4-8080.devtunnels.ms` — and send it to your friends.

### Option C — Run `cloudflared` yourself

Same service the extension wanted, minus the extension. You launch the binary, so
there is no mystery process for Windows to block.

1. Download `cloudflared-windows-amd64.exe` from
   <https://github.com/cloudflare/cloudflared/releases/latest>.
2. Rename it `cloudflared.exe` and put it in this project folder.
3. With the game server already running, in a **second** terminal:

   ```bat
   .\cloudflared.exe tunnel --url http://localhost:8080
   ```

4. It prints a `https://<random-words>.trycloudflare.com` address. Share that.

No account, no install, no admin. The address is new every time you restart it.

### Option D — `ssh -R`, using the SSH client Windows already ships

Zero downloads. Windows 10 and 11 include OpenSSH. With the server running:

```bat
ssh -R 80:localhost:8080 nokey@localhost.run
```

It prints an `https://<something>.lhr.life` address. Share that. Say `yes` to the
host-key prompt the first time.

### Option E — Port forwarding on your router

Forward external port 8080 to your machine's port 8080 and hand out your public
IP. Works, but needs router access, exposes your machine directly, and your home
IP can change. The tunnels above are less trouble.

---

## 4. How everyone actually joins

Once you have an address:

1. **Host:** open the game, **Co-op → Open a Lobby**. Note the four-letter code.
2. **Friends:** open *the host's address* — the tunnel URL or LAN address, not
   their own `localhost` — go to **Co-op**, type the code, and press **Join**.
   Leave the host/address box empty; because the page was served from your
   machine, the game already knows where to connect.
3. **Host:** press **Launch Descent**.

The host can keep playing on `http://localhost:8080` while friends come in over
the tunnel — it is one server process, so both land in the same lobby.

The address box on the Join screen only matters if someone is running their own
local copy of the game and wants to point it at your server. Pasting a full
`https://...devtunnels.ms` or `https://...trycloudflare.com` URL there works; the
game converts it to a `wss://` socket and does not append `:8080` to it.

---

## 5. When it goes wrong

| What you see | What it is |
| --- | --- |
| `Port 8080 is busy — trying 8081…` | Something else has the port. Harmless — the server moves up and prints the port it got. Tunnel *that* port. |
| Friends load the menu but **Join** fails | The tunnel is passing HTTP but not WebSockets, or (Option B) visibility is still **Private**. Set it to Public. |
| Friends get a Microsoft or GitHub login page | Same thing — visibility is Private. |
| `No lobby with that code.` | The code is per-lobby and dies with it. Have the host reopen the lobby and read out the new one. Codes never contain `I`, `O`, `0` or `1`. |
| `The host left the game.` | The host closed the tab or stopped the server. Only the host simulates the world, so the run ends for everyone. |
| `The lobby server did not answer.` | Friends opened their own `localhost` instead of the host's address, or the server is not running. |
| Game loads but nothing renders | The browser needs WebGL2. Chrome, Edge and Firefox are all fine; some remote-desktop sessions are not. |
| The `trycloudflare.com` address stopped working | Quick tunnels get a fresh address on every restart. Re-share it. |

## What it does
This is a Teams App that relays chat messages by storing them in a message queue and providing APIs for periodic polling. A shorter polling interval allows for real-time responsiveness.

<img width="2560" height="1417" alt="image" src="https://github.com/user-attachments/assets/a0ede674-396a-4605-9d77-a7341643fb7e" />

## What does it solve
This solution overcomes the limitations of the UiPath Integration Service Teams Connector to facilitate true real-time interaction between the user and the automated process.

## How to use
1. Provision a new server machine to host this Teams App
2. Assign public domain to the server (e.g. `teamsapp.company.com`)
3. Provision an Azure Bot in Microsoft Azure Portal
4. Prepare icons for this Teams App
5. Clone this repository
6. Create `.env` file, refering to `.env.example`
7. **Place `cert.pem` and `key.pem` in the repository root.** They are gitignored and
   therefore absent from a fresh clone. Both `msgqueue.js` and `teamsapp.js` read them
   with `fs.readFileSync` at module-load time, so the process fails during `require`
   if they are missing. The paths are relative, so the process must be started from
   the repository root (systemd: set `WorkingDirectory`). Restrict the key with
   `chmod 600 key.pem`.
8. Deploy nodejs server on the new machine and then run it to start listening on ports
9. Adjust `manifest.json` using information from the Azure Bot
10. Create Teams App package: Icon files and `manifest.json`
11. Deploy Teams App using the package
12. Perform tests using this Teams App


## Health check

`GET /` returns `200` only once the UiPath token has been obtained and the
schedulers are running. Before that, or after a token renewal fails, it returns
`503`. Point your monitor at it.

## Operational notes

- The process exits with code `1` when UiPath authentication fails at startup.
  Run it under a supervisor that restarts on failure (systemd
  `Restart=on-failure`).
- Global `unhandledRejection` / `uncaughtException` handlers are installed in
  `main.js` before the requires. Keep them there — they are what makes async
  failures visible in the journal.
- Set `RestartOnTrigger=false` to restore the previous behaviour where a trigger
  keyword typed during a running job is refused instead of restarting it.

## Known remaining items

| Item | Note |
|---|---|
| `restify` 11 → 12 | Two high-severity advisories (incl. `find-my-way` ReDoS) need this major upgrade. Not applied here: both HTTPS servers and `bodyParser` sit on restify and need a regression pass. |
| `conversationReference` | A single instance field shared by every user (`teamsapp.js`). Works in a single tenant because `serviceUrl` and the bot identity are constant, but it should be a `Map<userId, ref>`. `sendMessageToCurrentUser()` would deliver to whoever messaged last; it currently has no caller. |
| Trigger typos | Matching is exact-substring after whitespace removal and case folding, so transposition typos (`이에전트` for `에이전트`) still miss. Listing variants does not scale — an Adaptive Card button is the real fix, and needs manifest and Maestro-side changes. |
| `getAvailableRuntimes()` | No caller since `312ff30`. Its Machines query is tenant-scoped while its Jobs query is folder-scoped, so the figure it returns is overstated. Fix the scope before reusing it. |
| Webhook receiver auth | The webhook key header name was wrong until `68ec713`, yet the receiver still returned 200. Confirm the receiver actually validates it. |

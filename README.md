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


## Checks

```bash
npm run lint     # eslint - no-undef, no-unreachable
npm test         # msgqueue behaviour (mocked axios)
npm run check    # both
```

`npm run lint` is what catches an identifier used but never declared, and code
placed after a `throw`. Both classes of defect shipped to production in this
repository before these checks existed — run it before every push.

`npm test` runs two suites: `test/uipath.smoke.js` (pins the `stopJob` request
shape against the Orchestrator API docs) and `test/msgqueue.smoke.js`.
The latter needs `cert.pem`/`key.pem` present, since `msgqueue.js` opens an
HTTPS server at module load. A throwaway pair is fine:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes -subj "/CN=test.local"
```

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
- `RestartOnTrigger` defaults to **false**, because `stopJob()` has never run against a real
  Orchestrator. Verify it in staging (test T-5), then set `RestartOnTrigger=true`. Until then a
  trigger typed during a running job is refused rather than restarting it.
- Every outbound HTTP call has a timeout (`UiPathHttpTimeoutMs`, `WebhookHttpTimeoutMs`).
  Axios defaults to waiting forever; a socket that connects and never answers would otherwise
  leave `processRunInFlight` set and stop the scheduler for **every** user while `GET /` still
  returned 200. `ProcessRunWatchdogMs` is the backstop for that: the guard is released and the
  health check drops to 503 so the condition is visible.
- A failed token renewal retries every `TokenRecoveryIntervalSec` instead of waiting out the
  ~59 minute renewal period.

## Message delivery and the vestigial queue

The original design accumulated messages in `MessageQueue` and let the Maestro process
consume them one at a time through `/dequeue`. That was abandoned because a Maestro process
could not stay running long enough, and delivery moved to a webhook that reaches the process
directly. **Nothing polls `/dequeue` any more.**

That matters for failure handling. Pushing an undelivered message onto the queue is *not*
preservation — no one takes it out. So when both webhook attempts fail, the server now tells
the user (`AppMessage7`) so they can re-send. The queue push is kept only as a backstop in
case something still polls, and is capped at `MaxQueuePerUser` so an unconsumed queue cannot
grow without bound.

The second webhook, added earlier because a customer reported missing replies, was sent
unconditionally on the assumption that the receiver would ignore the duplicate. It did not —
that assumption is what produced the incident this branch fixes.

## Orchestrator URL path

The canonical path is `{domain}/{org}/{tenant}/{service}/odata/...`, where `{service}` is
`orchestrator_`, `dataservice_` and so on. This deployment also routes to Orchestrator
*without* the service segment, and that is the form currently in production.

Both forms are genuinely valid here — measured 2026-09-02 against `as.lgcnsrpa.com`:

| Path under `/innotek/DefaultTenant` | Status | Reading |
|---|---|---|
| `odata/Jobs` | 401 | reaches Orchestrator, only auth missing |
| `orchestrator_/odata/Jobs` | 401 | same |
| `bogus_/odata/Jobs` | 302 | unknown service falls through to the portal |
| `orchestrator_/odata/NoSuchEntity` | 404 | routed to Orchestrator, entity unknown |

`bogus_` returning 302 rather than 401 shows the auth gate is not in front of routing, so
the 401s mean the path resolved. The 8/31 production log independently confirms the
service-less form: `StartJobs` returned 201 with a job id.

`UiPathOrchestratorPath` defaults to empty so that deploying this branch does not change
any URL. **Do not hard-code the segment back into the five call sites.** To move to the
canonical form, verify in staging and then set one line in `.env`:

```
UiPathOrchestratorPath="orchestrator_"
```

The same line restores service if a platform upgrade ever stops accepting the
service-less form. Re-run the table above to re-diagnose.

## Trigger keywords

`ProcessTriggerKeywords` must contain **commands**, not business vocabulary. Matching is
substring-after-whitespace-removal, so a keyword like `거래선` fires on any answer that
happens to contain the word — and with `RestartOnTrigger=true` that kills the live session
and starts over. Keep them to explicit start phrases.

## Known remaining items

| Item | Note |
|---|---|
| Both HTTP ports bind `0.0.0.0` | `bodyParser` runs before `apiKeyAuth`, so an unauthenticated request's body is buffered before the 403. Body size is now capped (64 KB / 256 KB), but the ports should still be firewalled to the Bot Framework and UiPath source ranges. |
| UiPath OAuth scope | `uipath.js` requests ~60 scopes including `*.Write` on Administration, Users, Machines and Settings; the code only uses StartJobs, `Jobs({id})`, StopJobs and Machines. Narrow it with `UiPathAuthScope` once verified in staging — a leaked credential currently reaches the whole tenant. |
| `restify` 11 → 12 | Two high-severity advisories (incl. `find-my-way` ReDoS) need this major upgrade. Not applied here: both HTTPS servers and `bodyParser` sit on restify and need a regression pass. |
| `conversationReference` | A single instance field shared by every user (`teamsapp.js`). Works in a single tenant because `serviceUrl` and the bot identity are constant, but it should be a `Map<userId, ref>`. `sendMessageToCurrentUser()` would deliver to whoever messaged last; it currently has no caller. |
| Trigger typos | Matching is exact-substring after whitespace removal and case folding, so transposition typos (`이에전트` for `에이전트`) still miss. Listing variants does not scale — an Adaptive Card button is the real fix, and needs manifest and Maestro-side changes. |
| `getAvailableRuntimes()` | No caller since `312ff30`. Its Machines query is tenant-scoped while its Jobs query is folder-scoped, so the figure it returns is overstated. Fix the scope before reusing it. |
| `stopJob` untested against a live Orchestrator | The request shape now follows the documented bulk action (`POST /odata/Jobs/UiPath.Server.Configuration.OData.StopJobs`, body `{jobIds:[id], strategy:"Kill"}`) and is pinned by `test/uipath.smoke.js`, but it has never been executed against a real tenant. Verify in staging before enabling `RestartOnTrigger`. |
| Webhook receiver auth | The webhook key header name was wrong until `68ec713`, yet the receiver still returned 200. Confirm the receiver actually validates it. |

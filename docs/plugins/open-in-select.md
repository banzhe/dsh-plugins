# open-in-select — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## Host routes

The browser half makes two calls to the official `open-in-app` Host package,
addressed document-relative:

| Call | Route | Request | Success | Refusal |
|---|---|---|---|---|
| Application list | `GET open-in-app/apps` | `accept: application/json` | `200 {"apps": string[]}` | any non-2xx |
| Launch | `POST open-in-app/open` | `content-type: application/json`, body `{"app": id, "path": directory}` | `200` | `400`/`404`/`413`/`415`/`502` |

`path` is the Session's **absolute** workspace directory, which the header entry
reads from the Session list; the route opens the directory, not a file.

### Status contract

| Status | Meaning in the Host's route | Notice |
|---|---|---|
| `400` | the request body was rejected | `error.invalid` |
| `404` | unknown application id, or a path that does not exist | `error.missing` |
| `413` | the path is too long | `error.tooLong` |
| `415` | the application cannot open that kind of path | `error.unsupported` |
| `502` | the system launcher failed | `error.launch` |
| any other | not part of the documented refusal set | `error.status` with the number |

`src/client/api.ts` owns that table: `LaunchRefusal` names the documented
statuses, `REFUSAL_KEYS` maps each to its copy key, and `refusalKey()` answers
`null` for a status the Host does not document. Neither call rejects — an
unreadable list is an empty list, an unreachable Host is its own outcome — so a
gesture can never leave an unhandled rejection behind.

## One availability read per page

`apply()` reads the application list once and publishes it into a snapshot
store; every Session header subscribes to that one store. A failed, refused or
garbled read publishes an empty list, and the header then renders no control at
all rather than a broken one. Nothing re-reads the list for the life of the
page: an application installed later becomes available after a reload.

## The remembered application

The default is the application last picked from the list, persisted under the
storage key `dsh.open-in-select.app.v1` in local storage. The control prefers the remembered
application while the Host still reports it, and falls back to the Host's first
entry when nothing is remembered or the remembered id is gone.

The choice is written only when the picked application actually opened: a
refused or unreachable launch keeps the previous default. `createSnapshotStore`
disables persistence when local storage is unavailable (no document, private
mode, quota refusal), and the choice then lives in memory for the page's
lifetime.

## Why not reuse `ui-open-in-app`

The official control is a client plugin, not a service: it provides nothing
`ctx` can inject, and its components are package values another plugin may not
import — the client purity gate rejects a runtime value import of another
feature package. This plugin therefore restates the two route strings of the
Host's published `./shared` module in `src/client/routes.ts` (a value import
would inline a Host package into the browser artifact) and recomposes the
control from `ui-primitives` instead of importing it.

## Accessibility

The control is icon-only: the application's name and the action reach the user
as the button's accessible name and its tooltip (`Open in VS Code`, localized),
never as a text node. The chevron is a labelled `menu` trigger that reports its
expanded state, and the list marks the current application as selected. A launch
in flight marks both halves `aria-disabled` and drops further presses, so one
gesture produces one request: the halves stay focusable and keep the pointer
cursor and their hover feedback, because a control that goes dead mid-gesture
reads as broken rather than busy.

## Known limitations

- Header-only: there is no context-menu row, keyboard shortcut, or command
  entry for the same action.
- The list is read once per page (see above); a newly installed application
  needs a reload.
- A Host without `open-in-app` (or older than the peer range) answers `404` on
  both routes, so no control is rendered at all.
- The control opens the Session's workspace directory only; opening a file at a
  line is `file-link-open`'s job.
- Application names are this Bundle's own id-to-name table; an id it does not
  know is shown as itself.

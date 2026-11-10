# Roadmap

What to work on next, in priority order within each section. Written against v2.8.0 plus the fixes in #11 and #12.

Sizes are rough: **S** is an afternoon, **M** is a few days, **L** is a week or more. "Breaking" means existing prompts, rules or clients would need to change, so the item belongs in a major release.

## 0. Contacts: rewrite `update_contact` first

`update_contact` has the same flaw #11 fixed in `update_event`: it parses the card into a few fields and writes a new card from them. Running a typical card created on an iPhone through an update that changes only the note produced these changes:

| What happens | Example |
|---|---|
| Middle name, prefix and suffix are deleted | `N:Smith;Jane;Marie;Dr.;Jr.` becomes `N:Smith;Jane;;;` |
| All but one URL is deleted | Two `URL` lines become one |
| An empty address is added | Apple's `item3.X-ABADR:us` (the address's country code) is read as a second address and written back as a blank `ADR`; the country code is lost |
| Custom labels move to the wrong entry | `item1.X-ABLabel:Assistant` belonged to an email; phones are renumbered from `item1`, so the label now sits on a phone |
| Every phone, email and address is marked preferred | The real preferred entry is lost |
| Types are rewritten | An unlabeled phone becomes type `phone`; a work email with no explicit type becomes `home`; `CELL;VOICE` becomes `cell` |
| Birthday parameters are dropped | `BDAY;value=date:` becomes `BDAY:`; a birthday with no year loses the marker that says so |
| A new `phone` or `email` is ignored | When the contact already has one, the single-value field is dropped and the old list is written back. Only `phones[]` / `emails[]` take effect |

Reading has its own problems:

| What happens | Detail |
|---|---|
| Photo data is returned to the model | Unknown lines, including base64 `PHOTO`, come back in `_rawLines`. One photo can cost tens of thousands of tokens |
| A failed request looks like an empty address book | `list_contacts` and `search_contacts` do not check the HTTP status. A 401 returns `{ contacts: [], count: 0 }` |
| XML entities are not decoded | A company named `AT&T` is returned as `AT&amp;T` |
| vCard escapes are not decoded | `1 Main St\, Apt 2` keeps its backslash |
| Groups are listed as contacts | A contact group is a card too; it shows up as a nameless contact and an update would break it |
| Paging re-reads everything | Each page asks for `limit + offset` cards and slices; there is no stable order |
| Search is narrow | Name, email and phone only (not company or note), and a phone matches only in the exact format stored |
| Only the first address book is used | Shared or secondary books are ignored |

The fix is the one used for events: edit only the lines for the fields the caller passed and write every other line back unchanged, guarded by the ETag. Size **M**, and it should come before any new contact feature.

## 1. Known bugs

Small, verified against the code, and worth fixing before anything new.

| Item | Detail | Size |
|---|---|---|
| Refused flag changes are reported as success | imapflow returns `false` when the server refuses a command. #11 handles this for copy, move and delete; `flag_email`, `mark_as_read` and the bulk flag and mark tools still ignore it. | S |
| `update_digest_state` schema rejects its own data | `processedUids` is declared as numbers, but UIDs from non-default accounts are strings such as `umd:12345`. A strict client refuses the call. | S |
| Calendar and contact calls cannot be cancelled | A timed-out DAV request keeps running (the same class of problem #11 fixed for IMAP). Pass an `AbortSignal` to `fetch`. | S |
| Event text is under-escaped, and entities are not decoded | Event text does not escape `,` and `;`, and long lines are not folded. Event titles from a calendar query can come back with `&amp;` in them, as contacts do. | S |
| All-day events created without `end` have zero length | `DTEND` is written equal to `DTSTART`; it should be the next day. | S |
| Retry treats most server errors as transient | Any message containing `BAD` or `NO ` is retried, including permanent refusals. | S |
| Error text names iCloud for every account | A Gmail failure says "Could not reach imap.mail.me.com". | S |
| `get_thread` strips one subject prefix | `Re: Fwd: Re:` leaves two behind, so the candidate search misses. | S |
| State files are not written atomically | Rules, digest and session files are written in place. The move manifest was fixed in #11. Two HTTP sessions can also overwrite each other. | S |
| Startup requires `IMAP_USER` | The server exits when only numbered `IMAP_ACCOUNT_N_*` accounts are set, and Calendar and Contacts always use `IMAP_USER`. | S |

## 2. Make the tools easier for a model to use

| Item | Detail | Size |
|---|---|---|
| Cut the tool list from 86 to about 40 | Fold `*_by_sender`, `*_by_domain` and `*_older_than` into the filter tools, drop `get_inbox_summary` (identical to `get_mailbox_summary`), merge `bulk_mark_read` and `bulk_mark_unread`. The list costs about 12,000 tokens per session today and near-duplicates cause wrong tool choices. **Breaking.** | M |
| Richer `get_email` | Sender name, To and Cc by default. Keep links when HTML is stripped, so a confirm or unsubscribe URL is visible. Add `offset` so mail over 12 KB can be read to the end. | M |
| Compact, structured results | Results are pretty-printed JSON text. Drop the indentation (roughly a quarter fewer tokens) and return `structuredContent` with an `outputSchema` per tool. | M |
| Mark mail content as untrusted | Wrap message bodies, subjects and event text so a model can tell quoted content from instructions. The README covers prompt injection; the output does not help with it yet. | S |
| Batch list fetches | `search_emails`, unread `read_inbox`, by-sender and date-range fetch one message per round trip. One batched fetch each. | S |
| Bounds on inputs | `limit`, `sampleSize`, `maxChars` and `days` are unchecked. Add minimums, maximums and enums to the schemas. | S |
| Progress on long operations | Send MCP progress notifications from safe move and bulk delete, so a client shows chunk progress and does not time out. | M |
| `resume_move` | The manifest records exactly where a move stopped, but the only option is `abandon_move`. Finish an interrupted move from the manifest. | M |
| Confirm tokens for destructive calls | A dry run returns a token; the real call must present it and is refused if the matching set has changed. Makes "preview first" enforced, not advisory. | M |
| MCP prompts | Ship the common workflows (inbox triage, email to event, weekly review) as server prompts. | S |
| Rename the server | It reports itself as `icloud-mail`. **Breaking** for clients that key on the name. | S |

## 3. Mail features

| Item | Detail | Size |
|---|---|---|
| Attachments on send and draft | `compose_email`, `reply_to_email`, `forward_email` and `save_draft` cannot attach a file. Forwarding also drops the original's attachments and HTML. | M |
| Quote the original in replies | A reply sends only the new text. | S |
| Draft management | `list_drafts`, `update_draft`, `delete_draft`, and `send_draft` behind the send mode. Fits a draft-first workflow where a person reviews before sending. | M |
| Threads across folders | `get_thread` searches one mailbox, so it misses your own replies in Sent. | M |
| Search across mailboxes and accounts | One call that searches several folders or every account. Add a `to` filter. On Gmail accounts, accept Gmail search syntax through `X-GM-RAW`. | M |
| Send from an alias | iCloud allows sending from the account's aliases. Add a validated `from`. | S |
| One-click unsubscribe | `get_unsubscribe_info` only reports the header. Support the RFC 8058 POST, gated like sending. | M |
| Flag colors | Apple Mail's seven flag colors are stored as IMAP keywords. Read and set them. Needs a probe first. | S |

## 4. Calendar and contacts features

| Item | Detail | Size |
|---|---|---|
| Expand recurring events | Reads return the series master with its original start date, so "what is on Thursday" is wrong for a weekly event. Expand occurrences in the requested range; the expansion code already exists for subscribed calendars. Fix `detect_conflicts` on the same data, including overlaps within one calendar. | M |
| `find_free_slots` | Given calendars, a range, a duration and working hours, return open slots. Depends on expansion. | S |
| Edit one occurrence | Change or cancel a single instance of a series (`RECURRENCE-ID`, `EXDATE`). #11 preserves these; nothing can create them. | M |
| Attendees and invitations | Add attendees to an event, and accept or decline an invitation. | L |
| Changes since last sync | `list_calendars` already returns a sync token. Add "what changed since" for calendars and contacts, so a digest reads only the difference. | M |
| Contact groups | List groups, list members, add and remove. | M |
| Contact tools | Find duplicates, merge two contacts, list upcoming birthdays. | M |

## 5. New surfaces: more of iCloud and the Mac

Apple publishes no API for most of iCloud, so these work through the Mac itself. Each should be opt-in, hidden on other platforms, and absent from the `remote-safe` profile unless it is read-only.

| Item | How | Notes | Size |
|---|---|---|---|
| Reminders and Calendar through EventKit | A small bundled Swift helper | Replaces the JXA scripts, which block the server for up to 90 seconds. Adds recurrence, alarms and location to reminders, and reads every calendar account configured on the Mac, not only iCloud. The best first step here. | L |
| iCloud Drive | The local folder under `~/Library/Mobile Documents` | List, search, read and write files; report whether a file is downloaded. Restrict to configured folders. | M |
| Notes | Notes.app scripting | List, search, read, create and append. Rich formatting and attachments are limited. | M |
| Shortcuts | The `shortcuts` command line tool | List and run the user's Shortcuts with input. One bridge to Home, Focus modes, and anything else the user has automated. Allowlist the shortcuts that may run. | S |
| Messages | Read from the local Messages database; send by scripting | Reading needs Full Disk Access. Sending should follow the send mode and default to off. | L |
| Photos | Photos.app scripting | Search by album, date and keyword; export a photo to attach to mail. | M |
| Safari | Local data files | Reading List, bookmarks, and tabs open on other devices. Read-only. | M |
| Spotlight | `mdfind` | Search files and local mail by content, as a fallback when IMAP search is weak. | S |
| Notifications | `osascript` | Post a macOS notification when a long move or digest finishes. | S |
| Travel time | MapKit through the Swift helper | "Leave by" for an event with a location. | M |

Not feasible without private, unstable APIs: Find My, Hide My Email, iCloud Mail server-side rules, Screen Time, iCloud Keychain passwords.

Tools that combine surfaces, once the pieces exist:

- **Brief me on a person**: contact card, recent mail both ways, upcoming and past events with them.
- **Email to reminder**: create a reminder that links back to the message.
- **Meeting prep**: for the next event, the thread that set it up and its attachments.

## 6. Project health

| Item | Detail | Size |
|---|---|---|
| Dependency advisories | `npm audit` reports 11 advisories (1 critical, 7 high), mostly through the MCP SDK's dependencies. Refresh the lockfile. | S |
| Unused and undeclared dependencies | `fast-xml-parser` is declared and never imported. `iconv-lite` is imported and not declared; Node's `TextDecoder` covers it. | S |
| Use an XML parser for DAV responses | Responses are parsed with regular expressions. They hold up against iCloud today; a parser is safer. | M |
| CI | Test on Node 20, 22 and 24; add lint; publish to npm from a tagged release with provenance. | S |
| Live suite | Update `tests/live-destructive.test.js` for the Trash default from #11. Reuse the in-memory IMAP server from `tests/offline/safe-move.test.js` for more of `lib/imap.js`. | M |
| Split `lib/imap.js` | About 2,300 lines: connections, the move pipeline, rules and every mail function. | M |
| Packaging | A one-click bundle for Claude Desktop and a listing in the MCP registry. | S |
| Docs | Add CHANGELOG, CONTRIBUTING and issue templates. Split the README: setup first, the tool reference and remote access in their own files. | S |
| Safer defaults | Default the send mode to `drafts` for new installs. **Breaking.** | S |

## Suggested order

1. Section 0: the contacts rewrite.
1. Section 1, as one or two PRs.
2. `get_email`, batched fetches, compact results (section 2).
3. Recurring event expansion and `find_free_slots` (section 4).
4. Attachments, quoted replies and draft management (section 3).
5. A 3.0 release: the tool consolidation, server rename and send-mode default together.
6. The EventKit helper, then iCloud Drive and Shortcuts (section 5).

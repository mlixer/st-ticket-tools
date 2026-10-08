# st-ticket-tools

SillyTavern extension: the chat side of
[ticket-server](https://github.com/mlixer/ticket-server). Part of
[The Braid](https://github.com/mlixer/the-braid).

- **Four function tools** the model can call when you ask for background
  work: `open_ticket`, `get_result`, `list_tickets`, `followup_ticket`
  (follow-ups resume the worker's session with full context).
- **Auto-delivery**: polls `/tickets/check` every message; finished results
  are injected into context so the assistant surfaces them in its own voice,
  then acked one cycle later (crash-safe: redelivery, not loss).

**Install**: ST → Extensions → Install extension → this repo's Git URL.
Requires a Chat Completion source with function calling enabled for the
tools; auto-delivery works regardless.

**Server address**: location-aware default — loopback when browsing ST on
the box, `https://<host>:8443` over a private tailnet (reverse-proxied to
the server). Override via the `ticket_tools_server` extension setting.

## License

AGPL-3.0.

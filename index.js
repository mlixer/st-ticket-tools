/*
 * ticket-tools — SillyTavern extension
 *
 * Bridges the ST assistant to the Hermes ticket server (default 127.0.0.1:8002).
 *
 * Two distinct mechanisms, on purpose (see DESIGN_DECISIONS.md):
 *
 *   1. REGISTRY TOOLS (model-driven): open_ticket, get_result, list_tickets,
 *      followup. These are things the USER asks for, so the model deciding when
 *      to call them is correct. Registered via registerFunctionTool().
 *
 *   2. AUTO-HOOK (not a tool): the check/deliver poll. This must run every
 *      message regardless of what the user said, so it CANNOT be a tool — and ST
 *      forbids background prompts from calling tools anyway. It runs on a
 *      generation event, injects finished results into context before the model
 *      replies, and acks on a ONE-CYCLE DELAY so a result is only marked
 *      delivered after the turn that surfaced it has actually been committed.
 *
 * SERVER ADDRESS: the fetch() below runs in the BROWSER, not on the box. So the
 * address must be reachable from wherever ST is loaded. The default is
 * location-aware (same pattern as state-bridge): browsing ST on the box →
 * loopback :8002; browsing over a tailnet hostname → https://<host>:8443,
 * where a reverse proxy (e.g. `tailscale serve`) terminates TLS and forwards
 * to the loopback-bound server. Override via the `ticket_tools_server`
 * extension setting if your topology differs. Remember the server's CORS
 * allowlist (TICKET_CORS_ORIGINS) must include the ST origin you load from.
 */

// Location-aware default: loopback locally, :8443 reverse proxy otherwise.
function defaultServer() {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return 'http://127.0.0.1:8002';
    return `https://${h}:8443`;
}

function resolveServer() {
    try {
        const ctx = SillyTavern.getContext();
        const fromSettings = ctx?.extensionSettings?.ticket_tools_server;
        if (typeof fromSettings === 'string' && fromSettings.trim()) {
            return fromSettings.trim().replace(/\/+$/, '');
        }
    } catch { /* context not ready — fall through to default */ }
    return defaultServer();
}

console.log(`[ticket-tools] Ticket server resolves to ${resolveServer()} (re-resolved per request). ` +
    `(If you see "Failed to fetch", that address is not reachable from THIS device — ` +
    `check the reverse proxy and the server's CORS allowlist.)`);

// ----------------------------------------------------------------- http helpers
async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${resolveServer()}${path}`, opts);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        // Surface the server's own error message (e.g. the 409 guard text) so the
        // model — and the logs — see WHY, not just a status code.
        const detail = data && data.detail ? data.detail : text || `HTTP ${res.status}`;
        throw new Error(`${res.status}: ${detail}`);
    }
    return data;
}

// ----------------------------------------------------------------- registry tools
function registerTools() {
    const ctx = SillyTavern.getContext();
    const { registerFunctionTool, isToolCallingSupported } = ctx;

    if (typeof registerFunctionTool !== 'function') {
        console.warn('[ticket-tools] registerFunctionTool unavailable — update SillyTavern. Auto-hook still active.');
        return;
    }
    if (typeof isToolCallingSupported === 'function' && !isToolCallingSupported()) {
        // Not fatal: the auto-hook (delivery) does not need tool calling. Only the
        // user-driven actions do. Warn so "open_ticket does nothing" is diagnosable.
        console.warn('[ticket-tools] Tool calling not supported/enabled on this API. ' +
            'Registry tools (open_ticket etc.) will be inert until you switch the ST assistant ' +
            'to a Chat Completion source and enable "Enable function calling". Auto-delivery still works.');
    }

    registerFunctionTool({
        name: 'open_ticket',
        displayName: 'Open Ticket',
        description:
            'Hand a task to the Hermes background worker. Use this when the user asks for ' +
            'research, web lookups, or any task that runs on its own and may take a while — ' +
            'NOT for things you can answer directly in chat. Returns immediately with a ticket ' +
            'id; the result is delivered automatically later when it finishes. Do not promise ' +
            'to "check back" — say the task is filed and you will surface the result when ready.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                instruction: {
                    type: 'string',
                    description: 'The full task for the worker, as a self-contained instruction. ' +
                        'Include everything it needs; it does not see this chat.',
                },
            },
            required: ['instruction'],
        },
        action: async ({ instruction }) => {
            const t = await api('POST', '/tickets', { instruction });
            return `Filed ticket ${t.id} (status: ${t.status}). The result will arrive automatically when it finishes.`;
        },
        formatMessage: ({ instruction }) => `Filing ticket: ${String(instruction).slice(0, 60)}…`,
    });

    registerFunctionTool({
        name: 'get_result',
        displayName: 'Get Ticket Result',
        description:
            'Look up one specific ticket by id and return its current status and result (if ' +
            'finished). Use when the user asks about a particular ticket number. Finished ' +
            'results normally arrive on their own, so reach for this mainly when the user names ' +
            'a specific ticket or wants to re-see one.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'The ticket id to look up.' },
            },
            required: ['id'],
        },
        action: async ({ id }) => {
            const t = await api('GET', `/tickets/${id}`);
            if (t.status === 'done') return `Ticket ${id} (done): ${t.result}`;
            if (t.status === 'error') return `Ticket ${id} (error): ${t.result}`;
            return `Ticket ${id} is ${t.status} — not finished yet.`;
        },
        formatMessage: ({ id }) => `Looking up ticket ${id}…`,
    });

    registerFunctionTool({
        name: 'list_tickets',
        displayName: 'List Tickets',
        description:
            'List all tickets and their statuses (open, running, done, error). Use when the ' +
            'user asks what is in progress, what is still cooking, or for an overview of ' +
            'outstanding work. This is the "what is pending" view — finished results are ' +
            'delivered automatically and do not need this.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {},
        },
        action: async () => {
            const rows = await api('GET', '/tickets');
            if (!rows || rows.length === 0) return 'No tickets.';
            const lines = rows.map(t => {
                const parent = t.parent_id ? ` (follow-up of ${t.parent_id})` : '';
                return `#${t.id} [${t.status}]${parent}: ${String(t.instruction).slice(0, 60)}`;
            });
            return lines.join('\n');
        },
        formatMessage: () => 'Listing tickets…',
    });

    registerFunctionTool({
        name: 'followup_ticket',
        displayName: 'Follow Up On Ticket',
        description:
            'Push an existing FINISHED ticket further, continuing the same worker session with ' +
            'full context (the worker remembers the earlier exchange). Use when the user wants ' +
            'to refine, extend, or ask a follow-up question about a ticket that has already ' +
            'completed. The parent must be finished; if it is still running, wait.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'The finished ticket to continue from.' },
                instruction: { type: 'string', description: 'The follow-up request for the worker.' },
            },
            required: ['id', 'instruction'],
        },
        action: async ({ id, instruction }) => {
            const t = await api('POST', `/tickets/${id}/followup`, { instruction });
            return `Filed follow-up ticket ${t.id} continuing ticket ${id}. Result will arrive automatically when it finishes.`;
        },
        formatMessage: ({ id }) => `Following up on ticket ${id}…`,
    });

    console.log('[ticket-tools] Registry tools registered.');
}

// ----------------------------------------------------------------- auto-hook: check + deferred ack
//
// State carried between cycles: ids we injected last fire but have not yet acked.
// We ack them at the START of the next fire — by then the assistant turn that
// surfaced them has been committed to chat, so the explicit-ack window is honored:
// a result keeps reappearing in /check until we have actually surfaced it once.
let pendingAck = [];
// Whether we set a standing note last cycle that now needs clearing. Tracked
// separately from pendingAck because "a note is showing" and "tickets need acking"
// are distinct facts, even though they currently coincide.
let noteInjected = false;

async function deliverCycle() {
    const ctx = SillyTavern.getContext();

    // 1. Retract last cycle's note + ack its tickets. Both are deferred by one cycle:
    //    by now the turn that surfaced them has been committed, so we clear the standing
    //    note (or the model re-reads and re-announces it) and mark the tickets delivered.
    if (noteInjected) {
        clearInjectedNote(ctx);
        noteInjected = false;
    }
    if (pendingAck.length) {
        const toAck = pendingAck;
        pendingAck = [];
        for (const id of toAck) {
            try {
                await api('POST', `/tickets/${id}/ack`);
            } catch (e) {
                // If ack failed (e.g. server restart), the ticket stays undelivered and
                // will simply be re-injected below — no result is lost. Log and move on.
                console.warn(`[ticket-tools] ack of ticket ${id} failed, will redeliver:`, e.message);
            }
        }
    }

    // 2. Check for newly finished, unacked tickets.
    let finished;
    try {
        finished = await api('GET', '/tickets/check');
    } catch (e) {
        // Server down / unreachable: do nothing this turn. The assistant just answers
        // normally; nothing is lost, /check is retried next message.
        console.warn('[ticket-tools] check failed (server unreachable?):', e.message);
        return;
    }
    if (!finished || finished.length === 0) return; // nothing to surface — stay silent

    // 3. Inject the results into context so the model naturally surfaces them this turn.
    const blocks = finished.map(t => {
        const verb = t.status === 'error' ? 'failed' : 'finished';
        const parent = t.parent_id ? ` (follow-up of ticket ${t.parent_id})` : '';
        return `• Ticket ${t.id}${parent} ${verb}.\n  Task: ${t.instruction}\n  Result: ${t.result}`;
    });
    const note =
        '[Ticket update — background work has come back. Tell the user about ' +
        (finished.length === 1 ? 'this result' : 'these results') +
        ' in your reply, in your own voice:]\n' + blocks.join('\n\n');

    injectContext(ctx, note);
    noteInjected = true;

    // 4. Defer the ack: remember these ids; they get acked at the top of the NEXT cycle,
    //    once this turn (which surfaces them) is committed. The note is cleared then too.
    pendingAck = finished.map(t => t.id);
}

// setExtensionPrompt sets a STANDING prompt under KEY — it is STICKY, not one-shot.
// It stays in context on every generation until we overwrite or clear it. That is why
// a delivery note MUST be explicitly cleared once surfaced (see clearInjectedNote),
// or the model keeps re-reading the same finished result and re-announcing it.
const INJECT_KEY = 'ticket_tools_delivery';

function injectContext(ctx, text) {
    if (typeof ctx.setExtensionPrompt === 'function') {
        // position 1 = IN_PROMPT (in-context), depth 0, role system where supported.
        ctx.setExtensionPrompt(INJECT_KEY, text, 1, 0);
    } else {
        console.warn('[ticket-tools] setExtensionPrompt unavailable; cannot inject delivery note.');
    }
}

// Retract the standing note by setting it empty. Called one cycle after injection,
// alongside the ack, once the surfacing turn has been committed.
function clearInjectedNote(ctx) {
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(INJECT_KEY, '', 1, 0);
    }
}

// ----------------------------------------------------------------- wiring
function attachHook() {
    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes } = ctx;
    if (!eventSource || !eventTypes) {
        console.error('[ticket-tools] eventSource/eventTypes unavailable — cannot attach auto-hook.');
        return;
    }
    // Fire before generation so the injected note is in-context for this reply.
    // GENERATION_AFTER_COMMANDS fires after slash-commands are processed, just
    // before the prompt is built — the right spot to inject for the current turn.
    const evt = eventTypes.GENERATION_AFTER_COMMANDS || eventTypes.GENERATION_STARTED;
    eventSource.on(evt, async () => {
        try {
            await deliverCycle();
        } catch (e) {
            console.error('[ticket-tools] deliverCycle threw:', e);
        }
    });
    console.log(`[ticket-tools] Auto-hook attached on ${String(evt)}.`);
}

// ----------------------------------------------------------------- init
(function init() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        console.error('[ticket-tools] SillyTavern context not found.');
        return;
    }
    try { registerTools(); } catch (e) { console.error('[ticket-tools] registerTools failed:', e); }
    try { attachHook(); } catch (e) { console.error('[ticket-tools] attachHook failed:', e); }
    console.log('[ticket-tools] loaded.');
})();

# Memorize Chat requirements verification

Passing a deterministic release gate does not establish that the SillyTavern
entry point, browser lifecycle, and host persistence are wired correctly.

| Requirement | Existing evidence | Still needed |
| --- | --- | --- |
| Fresh Start, empty history, first provider dispatch | The startup gate calls the real reset helper and Session tier pipeline. It supplies its own lifecycle hook, applies events to an in-memory ledger, and counts dispatch locally. | Drive Fresh Start and Memorize Chat through their extension handlers with a stubbed host save and provider. At first provider invocation, verify that the saved registration, journal, and obligation all identify that same request. A rejected save must result in zero transmissions. |
| Reload or cancellation followed by repeated Resume | The fault matrix and replay gates exercise deterministic interruption, recovery, and transaction settlement. | Recreate the extension runtime from saved chat metadata. Verify interrupted work is resumable, committed records are not written twice, and repeated Resume does not register duplicate work. |
| Full and compact exports after failure | DTO and fault-injection tests exercise projections and fallback classification. | Use the ordinary export entry point after an injected failure, then force the full projection to fail and verify the compact export retains the original failure without exposing response text. |

Use an isolated chat fixture and a scripted provider for host-level tests.
Exercise the existing handler wiring rather than testing a second implementation
of the workflow. Start with the save-to-dispatch ordering test; that host seam
can also support reload and export cases.

The startup transaction integration gate now drives the reset helper and tier
pipeline through the real leased checkpoint transaction with a scripted
SillyTavern save. It verifies saved registration before the dispatch boundary
and zero dispatches on a rejected save. It does not exercise the click handlers.

The projection used by Export Diagnostics now has a regression test for both
full output and compact fallback after full validation rejects a non-finite
field. The fallback preserves the original run error and omits provider
response bodies. A second test calls the same download handler registered by
the settings UI with simulated DOM and URL APIs. It verifies the actual JSON
Blob, filename, and URL cleanup. Live browser wiring and upstream report
assembly are not covered.

The first two-tier chunk now has a transaction integration test using scripted
tier completions. It saves Long-Term coverage while leaving the contiguous
offset at zero, reopens the serialized checkpoint, skips the covered tier, and
advances the durable offset to 20 after Session completes. This does not
exercise the actual extraction adapters or the browser handler. A separate
test now runs the real multi-owner Long-Term adapter with a scripted provider
and host save. It verifies the saved running state at dispatch, the retained
reply after receipt failure, and a durable 20-message checkpoint after an
explicit no-update response passes the real unit-of-work reducer.
A record-producing case now saves real Long-Term extraction output, reloads
the serialized group-save payload, selects only Session, and drives the real
Session extractor through an explicit no-update response. It verifies the
first two-tier commit at offset 20 and that neither tier is selected again.
The test invokes both adapters with scripted host callbacks; the full browser
handler and live SillyTavern server remain unverified.

Both real extraction adapters also have a transport failure → reload → success
case. A scripted HTTP 503 leaves a verified acknowledgement and does not advance
coverage; the next dispatch completes the range and saves offset 20. The Session
case proves the saved Long-Term record is not duplicated. The tests use the
shared settlement function and group save serialization, but do not invoke the
settings event handler or production provider transport.

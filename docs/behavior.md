# Response behavior

For a matched operation, selection follows this order:

| Priority | Source            | Behavior                                                                                                     |
| -------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| 1        | Control headers   | Status, named example, or forced failure selects the requested response. A delay header only changes timing. |
| 2        | Config overrides  | Operation ID wins over METHOD /path; first matching rule, then a sequence or fixed response.                 |
| 3        | In-memory state   | Detected collections perform CRUD only when a state response is selected.                                    |
| 4        | Spec examples     | First named example, media example, then schema example(s).                                                  |
| 5        | Schema generation | Deterministic generation for JSON media; unsupported media without examples returns 501.                     |

Default status is the lowest declared 2xx, then default (served as 200), then 200. Explicit status controls may request a status not declared in the spec;
without a matching response or default, its body is empty. Control headers can
be disabled with controlHeaders.allow: false.

The configured failure rate is evaluated per operation/request counter after
selection; it can replace any selected response. X-Mockline-Error forces the
first configured error status. Failure randomness advances even when the data
generation counter is disabled. Delay precedence is control header, override,
then global latency. Sequences loop only with loop: true; otherwise they stay
at the last entry. reset() resets sequences, counters and collection seed data.

Accept selects declared media by quality value and wildcard matching. When no
declared media match, the response is 406. Overrides and stateful responses are
also subject to negotiation. Override bodies and examples are trusted and are
not schema-validated; generated JSON values are validated before serving.

Unknown paths return 404 and wrong methods return 405 with Allow. Both use
application/problem+json and include the nearest known path. Strict validation
runs before selection and can reject a request regardless of control headers.

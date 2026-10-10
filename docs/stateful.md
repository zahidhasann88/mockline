# In-memory state

A collection requires GET /things with an array response, POST /things, and
GET /things/{id} whose item schema matches the array item schema and contains
the configured ID property (id by default). Matching PUT/PATCH/DELETE item
routes participate; other operations use normal response selection.

Seeded items default to three; stateful.seedItems: 0 starts empty. POST stores
an item and assigns an ID if needed, GET lists or retrieves, PUT replaces,
PATCH shallow-merges, and DELETE returns 204. Declared limit/offset query
parameters paginate lists. Missing GET/PUT/PATCH items return 404. Deleting a
missing item still returns 204. Overrides and response-selection controls do
not execute the state handler. reset() and POST /__mockline/reset regenerate
seed data and reset deterministic counters; request history remains available.

This is a development store, not a database: state is lost on restart, updates
are shallow, relations and transactions are absent, and arbitrary resource
wrappers or workflow schemas are not detected. Constrained ID namespaces may
be exhausted; use a broad integer/string ID schema for stateful demos.

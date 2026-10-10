# Schema generation

Responses use a seed derived from the configured seed, HTTP method, matched
path template and optional operation-local counter. generation.counter is false
by default, so repeated requests to one operation return the same generated
body and requests to other routes do not alter it. Date generation uses a fixed
2020-01-01 reference time so wall-clock time does not change seeded output.

Generation respects supported primitive constraints, formats, object properties,
required fields, arrays, compositions and local schema references. writeOnly
response properties and readOnly request properties are omitted. Property hints
apply only when stronger constraints are absent; hints can be disabled or set
per property in config. OpenAPI 3.0 uses the draft-07 validator with nullable
support; OpenAPI 3.1 uses the JSON Schema 2020-12 validator.

Simple regex patterns are generated directly; complex patterns use candidate
fallbacks and warnings. Every candidate is schema-validated, including calls
without an OpenAPI root. Up to twelve deterministic attempts are made. If no
valid candidate can be generated, the library throws and the server returns a
500 problem response; it does not silently return invalid generated data.

Depth limits prune optional recursive fields. Schemas requiring infinite nested
objects have no finite JSON value and fail with a bounded error. Not every valid
JSON Schema can be synthesized: complex regexes, constrained composition
intersections and unsupported keywords may fail generation even though the spec
itself is valid. Examples are the practical fallback for those operations.

# 1. Summary & generation strategy
`JsGrammar` is a type-directed recursive-descent generator that constructs Babel
expression nodes and returns a Babel `File`; the class is declared at
`src/generator/js-grammar.ts:89`, and its constructor merges a partial grammar
configuration before installing a seeded `mulberry32` RNG
(`src/generator/js-grammar.ts:93-100`). The type vocabulary is the `TypeHint`
union (`src/generator/ast.ts:28-43`).

Generation starts in `generateProgram`, which creates or accepts a `Scope`, emits
two depth-1 declarations, then emits a random number of statements using the
configured expression depth (`src/generator/js-grammar.ts:102-119`). An optional
tier-up block is appended independently of expression selection
(`src/generator/js-grammar.ts:122-130`).

`generateExpression` is the typed entry point. It switches on the requested hint
and delegates to a producer; at `depth <= 0` it calls
`generateTerminalExpression` (`src/generator/js-grammar.ts:365-414`). The
terminal producer emits one-step literals or empty containers/callables for each
supported hint, with an `any`/unknown fallback to a number
(`src/generator/js-grammar.ts:417-452`). Recursive calls normally pass a reduced
depth, while the `generateAnyExpression` table itself decrements once before
invoking each producer (`src/generator/js-grammar.ts:455-505`). Thus the design
has a bounded recursion protocol with a deterministic base case, although the
resulting AST size still depends on producer arity and inline choices.

# 2. Structure map
The dispatch path is:

`generateProgram` -> `generateStatement` -> `generateExpression(hint)` ->
`generateAnyExpression` (untyped choice table) -> per-type producer.

`generateProgram` selects `statementCount` in `[1, maxStatements]`, seeds the
scope, and calls `generateStatement` at `maxExpressionDepth`
(`src/generator/js-grammar.ts:102-119`). `generateStatement` has eleven base
entries (declaration, expression, loops, conditionals, switch/try, function,
GC, and two assignment entries), then conditionally appends async and class
entries (`src/generator/js-grammar.ts:155-181`).

`generateExpression` maps number, bigint, string, boolean, array, object,
function, typedarray, promise, symbol, weakmap, weakset, and
finalizationregistry to dedicated producers; the remaining/default route is
`generateAnyExpression` (`src/generator/js-grammar.ts:365-414`). The untyped
table contains 19 closures covering primitive literals, containers, identifiers,
operators, templates, calls, member reads, regular expressions, symbols, and
method calls (`src/generator/js-grammar.ts:460-490`). Async promises, generator
yield, and generator invocation are appended as context/configuration permits
(`src/generator/js-grammar.ts:492-503`). Representative producer locations are
number/bigint/string (`src/generator/js-grammar.ts:522-582`), operators and
composites (`src/generator/js-grammar.ts:585-625,749-793`), and typed runtime
objects (`src/generator/js-grammar.ts:985-1088`).

Scopes are a tree of `VariableSlot` records carrying a `TypeHint`
(`src/generator/ast.ts:22-26,50-120`); producers consult this tree when choosing
identifiers and typed receivers (`src/generator/js-grammar.ts:283-300,720-738`).

# 3. Output distribution & diversity analysis
**CONFIRMED.** With positive depth, the 19 base entries are all syntactically
reachable from `generateAnyExpression` (`src/generator/js-grammar.ts:455-490`).
The method-call entry can deliberately fall back to a member read when no
eligible receiver exists or while a declaration initializer is being built
(`src/generator/js-grammar.ts:484-489`), so its *method-call AST* is not
guaranteed in every scope. Async adds one entry when enabled; generator yield is
added only inside a generator; generator invocation is added outside declaration
initializers when generators are enabled (`src/generator/js-grammar.ts:492-503`).

**CONFIRMED.** `pick` selects an array index with one uniform integer draw
(`src/generator/js-grammar.ts:1100-1105`). Consequently, the 19 base entries
each receive `1/19` conditional probability when both optional additions are
disabled. Under the default configuration, a normal untyped context has 21
entries (19 + async + generator invocation), so each base entry is approximately
`1/21`; a generator body has 22 entries and approximately `1/22` per base entry
(`src/generator/js-grammar.ts:492-503`). These are table-selection probabilities,
not node frequencies: recursive producers add zero or more children and are also
called through typed branches (`src/generator/js-grammar.ts:370-414,522-717`).

**LIKELY.** Numbers, strings, arrays, and objects are over-represented in final
ASTs relative to their single table slot because they are used as typed operands,
declaration initializers, and recursively nested children
(`src/generator/js-grammar.ts:522-579,676-717,749-762`). Regular-expression and
symbol nodes are likely under-represented in untyped output because each has one
base slot and is otherwise leaf-like; BigInt has the same single slot but can
add recursive binary children with probability 0.35
(`src/generator/js-grammar.ts:460-490,550-563,651-673`). This is a distribution
hypothesis rather than a measured frequency; scope availability and depth alter
the effective rates.

**LIKELY.** Inline probabilities further skew the shape distribution. Array
spreads occur at 0.15 and holes at 0.20 per element
(`src/generator/js-grammar.ts:676-686`); object spreads occur at 0.15 and a
getter is added at 0.25 (`src/generator/js-grammar.ts:689-717`). Class
instantiation is gated at 0.4 when a visible class exists
(`src/generator/js-grammar.ts:381-391`). Async and class statement entries are
each admitted with an inline 0.15 gate before the table is sampled
(`src/generator/js-grammar.ts:174-179`). Because these constants are distributed
through producer bodies, there is no single probability vector to report or
replay as an experimental independent variable.

**CONFIRMED.** No centralized weight/probability table exists: the table is
constructed inline (`src/generator/js-grammar.ts:460-505`), and secondary rates
are literals in individual producers (`src/generator/js-grammar.ts:174-179,
388,616-624,680-706`). A diversity experiment should therefore record
per-production counters and context (hint, depth, feature flags, and fallback
path), rather than infer distribution from the 19-entry table alone.

# 4. Well-formedness & type-direction soundness
**CONFIRMED.** Number, bigint, string, and boolean branches select producers
whose literals and identifiers have the requested primitive type
(`src/generator/js-grammar.ts:370-378,522-579,640-649`). The number branch has a
specific exception: `generateBinaryExpression` chooses equality and relational
operators as well as arithmetic/bitwise operators
(`src/generator/js-grammar.ts:56-77,749-762`), so a requested `number` can
produce a boolean-valued binary expression (CONFIRMED).

**CONFIRMED.** Array, object, function, typedarray, promise, symbol, weakmap,
weakset, and finalizationregistry branches construct the corresponding Babel
node families (`src/generator/js-grammar.ts:379-411,676-717,938-1050,
1052-1075`). An `object` hint may also instantiate a visible class, which is
object-like in JavaScript (`src/generator/js-grammar.ts:381-391`). There is no
dedicated `class` case in the `generateExpression` switch; it falls through to
`generateAnyExpression` via the default arm (`src/generator/js-grammar.ts:370-414`),
so a `class` hint is not type-directed (CONFIRMED). The `any` hint is intentionally
unconstrained and its terminal form is a number (`src/generator/js-grammar.ts:417-458`).

**CONFIRMED.** `Scope.allVisible` walks the current scope and ancestors
(`src/generator/ast.ts:101-114`), and `generateIdentifier` normally chooses one
of those slots with a threshold of 1.0 when undeclared identifiers are disabled
or declaration initializers are active (`src/generator/js-grammar.ts:720-733`).
The fallback is the global `undefined` binding, which is not represented in the
scope tree (`src/generator/js-grammar.ts:735-738`); therefore references are
declared-in-scope when selected from `vars`, but the generator does not provide a
strict in-scope guarantee for every emitted identifier. `Scope.declare` also
retains overwrite semantics for non-identical redeclarations
(`src/generator/ast.ts:59-83`), so a separate declaration policy would be needed
for a strict uniqueness invariant.

**CONFIRMED.** The `declaredOnlyIdents` guard suppresses the empty-scope
identifier choice and method calls during declaration initialization
(`src/generator/js-grammar.ts:467-473,484-489,740-741`).
`activeFunctionNames` prevents selecting the function currently being built as a
callee (`src/generator/js-grammar.ts:771-787,898-916`), and
`activeClassNames` prevents self-instantiation while a class body is generated
(`src/generator/js-grammar.ts:381-389,961-980`). These guards improve well-formed
scope references and bounded call construction, but they also make effective
production reachability context-dependent (LIKELY; same evidence).

**LIKELY.** The depth protocol terminates recursive descent: both typed and
untyped entry points switch to terminals at zero, and the untyped closures pass
`depth - 1` into their producers (`src/generator/js-grammar.ts:365-367,455-505`).
Several producers pass their already-reduced parameter unchanged to children
(for example conditional/logical/sequence and array/object elements
(`src/generator/js-grammar.ts:585-612,676-700`)); this preserves a decreasing
step at the table boundary but can increase AST width substantially. A depth
audit with per-node maximum-depth assertions would convert this termination
assessment into a measured invariant.

# 5. Edge-value & operator coverage
**CONFIRMED.** `EDGE_NUMBERS` has 13 entries: signed zero, unit values, NaN and
infinities, 32-bit boundary values, `2^32`, and `+/-2^53`
(`src/generator/js-grammar.ts:40-54`). Edge values are selected on 30% of
number terminals; otherwise the generator samples the small integer interval
[-100,100] (`src/generator/js-grammar.ts:522-548`). Signed zero, NaN, and
infinities are encoded as AST expressions so Babel printing preserves their
meaning (`src/generator/js-grammar.ts:81-86,538-545`).

**LIKELY.** Input-space coverage omits several useful numeric partitions: the
largest safe integers `2^53-1`, `-(2^53-1)`, `2^31-1`'s negative successor,
`2^32-1`, subnormal/fractional values, and `Number.MAX_VALUE`, `MIN_VALUE`, and
`EPSILON` are absent from the table (`src/generator/js-grammar.ts:40-54`).
Typed-array lengths add only `0.5`, selected negatives, and `2^53` as explicit
validation edges (`src/generator/js-grammar.ts:997-1007`).

**CONFIRMED.** The binary operator table contains 20 operators spanning
arithmetic, exponentiation, equality, relational, bitwise, and shift families;
the logical table contains `&&`, `||`, and `??`
(`src/generator/js-grammar.ts:56-79`). Binary operands are always requested as
numbers (`src/generator/js-grammar.ts:749-762`), so mixed-type coercion is
primarily reached indirectly through other producers. Operators such as `in`,
`instanceof`, bitwise assignment, and unsigned numeric literals are not present
in these tables (LIKELY coverage gap; `src/generator/js-grammar.ts:56-79`).

**LIKELY.** Literal arrays are compact: six decimal BigInt values
(`src/generator/js-grammar.ts:550-563`), eight strings including an empty value,
bracket-like text, and a line-separator escape (`src/generator/js-grammar.ts:565-582`),
four regular-expression patterns with five flags (`src/generator/js-grammar.ts:664-673`),
and five typed-array constructors (`src/generator/js-grammar.ts:985-992`). They
provide representative families but leave alternate numeric bases, longer and
Unicode-rich strings, broader regular-expression flags, and additional typed
array element types unrepresented.

# 6. Configurability & reproducibility
**CONFIRMED.** `GrammarConfig` exposes statement, loop, expression-depth, and
mutation limits, feature toggles for async/generators/classes/Wasm/tier-up,
tier-up probability, and undeclared-identifier policy
(`src/generator/js-grammar.ts:12-24`). Defaults are fixed in one object
(`src/generator/js-grammar.ts:26-38`). The constructor applies overrides and
seeds `mulberry32`; `setSeed` resets the stream (`src/generator/js-grammar.ts:93-100,
1109-1118`). Async/generator switches gate optional expression entries
(`src/generator/js-grammar.ts:492-503`), while statement and loop limits are
consumed at `src/generator/js-grammar.ts:105,117-125,811,849`.

**CONFIRMED.** Production weights are not configuration fields. Uniform table
selection is implemented by `pick` (`src/generator/js-grammar.ts:1100-1105`),
whereas rates such as 0.15, 0.25, 0.30, 0.35, 0.40, and 0.65 are embedded in
producers (`src/generator/js-grammar.ts:174-179,388,538,616-618,642-646,680-706`).
Changing a rate requires a source edit, and the resulting distribution is not
described by `GrammarConfig`.

**CONFIRMED.** Seeded replay also depends on process-global identifier state:
`freshId` increments a module-global counter (`src/generator/ast.ts:122-129`),
while reset and crossover-oriented advancement are separate functions
(`src/generator/ast.ts:131-150`). Reproducing source text therefore requires the
same seed, configuration, base-scope contents, and identifier-counter state;
resetting only the RNG is insufficient (LIKELY for source-level differences,
because generated names are printed).

For an experiment that treats distribution as an independent variable, expose a
central descriptor containing production names and weights, instrument selected
and fallback outcomes, and serialize seed, configuration, scope seed, counter
state, and generator version with each sample. The descriptor should define
whether optional async/generator entries are normalized into the same probability
vector or reported as separate contexts; this follows directly from their
conditional insertion (`src/generator/js-grammar.ts:492-503`).

# 7. Prioritized improvement list
1. **Centralize production descriptors and weights** (`src/generator/js-grammar.ts:460-505,1100-1105`): make the probability vector explicit, configurable, and loggable for experiment replication.
2. **Add per-production reachability and distribution counters** (`src/generator/js-grammar.ts:467-503`): distinguish selected entries from context-driven fallbacks and report rates by hint/depth/configuration.
3. **Close type-hint inconsistencies** (`src/generator/js-grammar.ts:370-414,56-77,749-762`): add a `class` producer/branch and separate boolean-valued comparison operators from number-producing binary choices.
4. **Define a strict scope-identity policy** (`src/generator/ast.ts:59-114,122-150; src/generator/js-grammar.ts:720-738`): deduplicate shadowed slots, make global fallbacks explicit, and reset/record the fresh-ID counter for source-stable replay.
5. **Extend edge and literal tables** (`src/generator/js-grammar.ts:40-79,550-582,664-673,985-1007`): add safe-integer neighbors, floating-point classes, alternate literal encodings, broader regexp flags, and more typed-array constructors.
6. **Make depth accounting auditable** (`src/generator/js-grammar.ts:455-505,585-612,676-700`): standardize child-depth decrements or attach a remaining-budget invariant to control width and compare AST-size distributions.
7. **Move inline secondary rates into configuration** (`src/generator/js-grammar.ts:174-179,388,616-618,680-706`): allow controlled ablations of spreads, getters, interpolations, and class/async choices without code changes.

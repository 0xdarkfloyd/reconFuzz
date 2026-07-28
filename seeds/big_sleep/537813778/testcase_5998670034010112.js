const raw = ("a".repeat(32) + "ሴ").slice(0, 32);
let s = createExternalizableTwoByteString(raw);
externalizeString(s);
let shared = %ShareObject(s);
%ConstructInternalizedString(shared);
function f(x) { return x.slice(0, 4); }
%SimulateNewspaceFull();
let result = f(shared);
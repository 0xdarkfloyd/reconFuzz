// Flags: --allow-natives-syntax --shared-string-table --transition-strings-during-gc-with-stack --gc-global --turboshaft-verify-load-elimination

let g;
function f(a) {
  let sub1 = a.slice(0, 4);
  g = {}; // Trigger GC / transition
  let sub2 = a.slice(0, 4);
  return [sub1, sub2];
}

const s_warm = "x".repeat(16) + "\u1234";
function get_sliced_warm() {
  return s_warm.slice(0, 16);
}

%PrepareFunctionForOptimization(f);
for (let i = 0; i < 1000; i++) {
  f(get_sliced_warm());
}
%OptimizeFunctionOnNextCall(f);
f(get_sliced_warm());

const s = "x".repeat(16) + "\u1234";
let a = %ShareObject(s.slice(0, 16));    // Shared, 2-byte sliced string containing only ASCII
%ConstructInternalizedString(a);  // Added to StringForwardingTable.
%SimulateNewspaceFull();

const result = f(a);
print("result: " + result);

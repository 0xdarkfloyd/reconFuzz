// Flags: --allow-natives-syntax --debug-code --maglev --no-turbofan --specialize-code-for-one-byte-seq-strings

function factory() {
  let s = String.fromCharCode(97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97,  97, 97, 97, 97, 97, 97, 97, 97);
  function foo(i) {
    return s.charCodeAt(i);
  }
  return {foo, s};
}

let {foo, s} = factory();

%PrepareFunctionForOptimization(foo);
foo(0);
%OptimizeMaglevOnNextCall(foo);
foo(0);

print("Is Maglev: " + %ActiveTierIsMaglev(foo));

// Internalize s
let obj = {};
obj[s] = 1;

print("Internalized s");

foo(0);
// Flags: --turbolev --maglev-verify-dominance
function foo(x) {
  let phi = 0;
  for (let i = x; i; i--) {
    phi ^ 1;
    phi = i;
  }
}

%PrepareFunctionForOptimization(foo);
foo(10);
%OptimizeFunctionOnNextCall(foo);
foo(10);
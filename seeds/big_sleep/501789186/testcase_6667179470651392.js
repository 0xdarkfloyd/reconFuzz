// Flags: --allow-natives-syntax
let f64 = new Float64Array(1);
f64[0] = 1.0;
let hn = f64[0];

let script_var_1 = hn;
let script_var_2 = 1;
script_var_2 = 2;

function foo(x) {
  script_var_1 = x;
  script_var_2 = x;
}

%PrepareFunctionForOptimization(foo);
%OptimizeMaglevOnNextCall(foo);

foo(hn);

print("script_var_2: " + script_var_2);
%DebugPrint(script_var_2);

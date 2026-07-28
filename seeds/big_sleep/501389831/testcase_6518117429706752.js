// Flags: --allow-natives-syntax

let f64 = new Float64Array(1);
f64[0] = 42;
const heap_num = f64[0]; 

var global_const = heap_num; 

function push_it(arr, x) {
    arr.push(x);
}

function test(x, arr) {
    global_const = x; 
    push_it(arr, x);  
}

let smi_arr = [1, 2, 3]; smi_arr.push(4);
let obj_arr = [{}, {}, {}];

%PrepareFunctionForOptimization(push_it);
%PrepareFunctionForOptimization(test);

push_it(smi_arr, 1);
push_it(obj_arr, {});

test(heap_num, smi_arr);

%OptimizeMaglevOnNextCall(test);

let arr = [1, 2, 3]; arr.push(4); // PACKED_SMI_ELEMENTS
test(heap_num, arr);

%HeapObjectVerify(arr);

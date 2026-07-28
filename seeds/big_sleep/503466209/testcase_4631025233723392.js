// Flags: --wasm-jitless --experimental-wasm-type-reflection
try {
    let target = function() { print("JS called"); };
    let bound = target.bind({a: 1});
    let f = new WebAssembly.Function({parameters: ["v128"], results: []}, bound);
    print("Calling f...");
    f();
    print("Done");
} catch (e) {
    print("Caught: " + e);
}

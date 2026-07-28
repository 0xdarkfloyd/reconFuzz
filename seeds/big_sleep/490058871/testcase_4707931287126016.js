function test() {
    let sab = new SharedArrayBuffer(1024);
    let i32 = new Int32Array(sab);
    Atomics.waitAsync(i32);
    gc();
        let sab2 = new SharedArrayBuffer(1024);
        let i32_2 = new Int32Array(sab2);
        Atomics.notify(i32_2);
}
for (let i = 0; i < 10; i++) {
    test();
}
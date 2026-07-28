d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

function makeModule() {
    let types = [
        [0x60, 0x00, 0x00],             // 0: sig () -> ()
        [0x65, 0x4d, 0x02, 0x5f, 0x00], // 1: Shared Struct T, descriptor 2
        [0x65, 0x4c, 0x01, 0x5f, 0x00]
    ];
    let codes = [[
        0, // 0 locals
        0xfb, 0x00, 2, // struct.new 2 (D)
        0x1a, // drop
        0x0b  // end
    ]];
    let buffer = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    function addSection(id, contents) {
        buffer.push(id);
        buffer.push(...wasmUnsignedLeb(contents.length));
        buffer.push(...contents);
    }
    addSection(1, [1, 0x4e, 3, ...types.flat()]);
    addSection(3, [1, 0]);
    addSection(7, [1, 4, 116, 101, 115, 116, 0, 0]);
    addSection(10, [1, ...wasmUnsignedLeb(codes[0].length), ...codes[0]]);
    return new Uint8Array(buffer);
}
try {
    let module = new WebAssembly.Module(makeModule());
    let instance = new WebAssembly.Instance(module);
    instance.exports.test();
} catch (e) {
}
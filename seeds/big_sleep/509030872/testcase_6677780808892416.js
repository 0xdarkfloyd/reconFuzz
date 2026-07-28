let mem = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true});
let sab = mem.buffer;
mem.grow(1);
let worker = new Worker('onmessage = function(e) { let sab = e.data; postMessage([sab.byteLength, sab.maxByteLength, sab.growable]); }', {type: 'string'});
worker.postMessage(sab);
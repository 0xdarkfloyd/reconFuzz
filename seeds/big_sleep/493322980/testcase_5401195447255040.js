// Flags: --gc-memory-reducer-start-delay-ms=0 --memory-reducer --trace-memory-reducer
function f() {}
for (let i = 0; i < 10000; i++) f();

// Flags: --no-experimental-wasm-legacy-eh
for (let i = 0; i < 100; i++) {
  %WasmGenerateRandomModule();
}

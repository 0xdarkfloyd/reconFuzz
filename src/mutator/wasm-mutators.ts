/**
 * Structure-aware mutators for WebAssembly module bytes.
 */
import { WasmModule } from '../generator/ast';

export type WasmMutator = (module: WasmModule) => WasmModule;

export function bitFlip(module: WasmModule): WasmModule {
  const bytes = new Uint8Array(module.bytes);
  if (bytes.length < 9) return { ...module };

  const clone = new Uint8Array(bytes);
  const idx = 8 + Math.floor(Math.random() * (clone.length - 8));
  const bit = Math.floor(Math.random() * 8);
  clone[idx] ^= 1 << bit;

  return { name: module.name, bytes: clone };
}

export function truncateTail(module: WasmModule): WasmModule {
  const bytes = new Uint8Array(module.bytes);
  if (bytes.length < 9) return { ...module };

  const newLen = 8 + Math.floor(Math.random() * (bytes.length - 8));
  return { name: module.name, bytes: bytes.slice(0, newLen) };
}

export function insertNop(module: WasmModule): WasmModule {
  const bytes = new Uint8Array(module.bytes);
  const clone = new Uint8Array(bytes.length + 1);
  clone.set(bytes);
  clone[bytes.length] = 0x01; // nop
  return { name: module.name, bytes: clone };
}

export const WASM_MUTATORS: WasmMutator[] = [
  bitFlip,
  truncateTail,
  insertNop,
];

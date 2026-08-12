/**
 * Structure-aware mutators for WebAssembly module bytes.
 */
import { WasmModule } from '../generator/ast';

const WASM_HEADER_SIZE = 8;

function randomIndex(length: number, rng: () => number): number {
  const sample = rng();
  if (!Number.isFinite(sample)) {
    throw new RangeError('rng() must return a finite number');
  }
  return Math.floor(Math.min(1 - Number.EPSILON, Math.max(0, sample)) * length);
}

export type WasmMutator = (module: WasmModule, rng: () => number) => WasmModule;

export function bitFlip(
  module: WasmModule,
  rng: () => number,
): WasmModule {
  const bytes = new Uint8Array(module.bytes);
  if (bytes.length < WASM_HEADER_SIZE + 1) return { name: module.name, bytes };

  const clone = new Uint8Array(bytes);
  const idx = WASM_HEADER_SIZE + randomIndex(clone.length - WASM_HEADER_SIZE, rng);
  const bit = randomIndex(8, rng);
  clone[idx] ^= 1 << bit;

  return { name: module.name, bytes: clone };
}

export function truncateTail(
  module: WasmModule,
  rng: () => number,
): WasmModule {
  const bytes = new Uint8Array(module.bytes);
  if (bytes.length < WASM_HEADER_SIZE + 1) return { name: module.name, bytes };

  const newLen =
    WASM_HEADER_SIZE + randomIndex(bytes.length - WASM_HEADER_SIZE, rng);
  return { name: module.name, bytes: bytes.slice(0, newLen) };
}

export function insertNop(module: WasmModule, _rng?: () => number): WasmModule {
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

var kWasmH0 = 0;
var kWasmH1 = 0x61;
var kWasmH2 = 0x73;
var kWasmH3 = 0x6d;
var kWasmV0 = 0x1;
var kWasmV1 = 0;
var kWasmV2 = 0;
var kWasmV3 = 0;
let kTypeSectionCode = 1;        // Function signature declarations
let kFunctionSectionCode = 3;    // Function declarations
let kMemorySectionCode = 5;      // Memory attributes
let kExportSectionCode = 7;      // Exports
let kCodeSectionCode = 10;       // Function code
let kWasmFunctionTypeForm = 0x60;
let kNoSuperType = 0xFFFFFFFF;
let kWasmI32 = 0x7f;
let kWasmS128 = 0x7b;
let kExternalFunction = 0;
function makeSig(params, results) {
  return {params: params, results: results};
}
const kWasmOpcodes = {
  'End': 0x0b,
  'LocalGet': 0x20,
  'LocalSet': 0x21,
  'I32Const': 0x41,
};
function defineWasmOpcode(name, value) {
  Object.defineProperty(globalThis, name, {value: value});
}
for (let name in kWasmOpcodes) {
  defineWasmOpcode(`kExpr${name}`, kWasmOpcodes[name]);
}
const kPrefixOpcodes = {
  'Simd': 0xfd,
};
for (let prefix in kPrefixOpcodes) {
  defineWasmOpcode(`k${prefix}Prefix`, kPrefixOpcodes[prefix]);
}
let kTrapMsgs = [
];
class Binary {
  constructor() {
    this.length = 0;
    this.buffer = new Uint8Array(8192);
  }
  trunc_buffer() {
    return new Uint8Array(this.buffer.buffer, 0, this.length);
  }
  emit_u8(val) {
    this.buffer[this.length++] = val;
  }
  emit_leb_u(val) {
      let v = val & 0xff;
        this.buffer[this.length++] = v;
  }
  emit_u32v(val) {
    this.emit_leb_u(val);
  }
  emit_bytes(data) {
    this.buffer.set(data, this.length);
    this.length += data.length;
  }
  emit_string(string) {
    let string_utf8 = string;
    this.emit_u32v(string_utf8.length);
    for (let i = 0; i < string_utf8.length; i++) {
      this.emit_u8(string_utf8.charCodeAt(i));
    }
  }
  emit_type(type) {
      this.emit_u8(type >= 0 ? type : type & kLeb128Mask);
  }
  emit_header() {
    this.emit_bytes([
      kWasmH0, kWasmH1, kWasmH2, kWasmH3, kWasmV0, kWasmV1, kWasmV2, kWasmV3
    ]);
  }
  emit_section(section_code, content_generator) {
    this.emit_u8(section_code);
    const section = new Binary;
    content_generator(section);
    this.emit_u32v(section.length);
    this.emit_bytes(section.trunc_buffer());
  }
}
class WasmFunctionBuilder {
  constructor(module, name) {
    this.module = module;
    this.name = name;
    this.locals = [];
  }
  exportAs(name) {
    this.module.addExport(name, this.index);
  }
  exportFunc() {
    this.exportAs(this.name);
  }
  addBody(body) {
    this.body = body.concat([kExprEnd]);
    return this;
  }
  addLocals(type, count) {
    this.locals.push({type: type, count: count});
    return this;
  }
}
class WasmModuleBuilder {
  constructor() {
    this.types = [];
    this.exports = [];
    this.memories = [];
    this.functions = [];
  }
  addMemory(min, max, shared) {
    this.memories.push(
        {min: min, max: max, shared: shared || false, is_memory64: false});
  }
  addType(type, supertype_idx = kNoSuperType = true,
          is_shared = false) {
    var type_copy = {params: type.params, results: type.results,
                     supertype: supertype_idx};
    this.types.push(type_copy);
  }
  addFunction(name, type, arg_names) {
    let type_index =typeof type == 'number' ? type : this.addType(type);
    let func = new WasmFunctionBuilder(this, name);
    this.functions.push(func);
    return func;
  }
  addExport(name, index) {
    this.exports.push({name: name, kind: kExternalFunction, index: index});
  }
  toBuffer() {
    let binary = new Binary;
    let wasm = this;
    binary.emit_header();
      binary.emit_section(kTypeSectionCode, section => {
        let length_with_groups = wasm.types.length;
        section.emit_u32v(length_with_groups);
        for (let i = 0; i < wasm.types.length; i++) {
          let type = wasm.types[i];
          if (type.supertype != kNoSuperType) {
          } else {
            section.emit_u8(kWasmFunctionTypeForm);
            section.emit_u32v(type.params.length);
            for (let param of type.params) {
              section.emit_type(param);
            }
            section.emit_u32v();
          }
        }
      });
      binary.emit_section(kFunctionSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
          section.emit_u32v();
      });
      binary.emit_section(kMemorySectionCode, section => {
        section.emit_u32v(wasm.memories.length);
        for (let memory of wasm.memories) {
          const is_memory64 = !!memory.is_memory64;
          section.emit_u8();
          let emit = val =>
              is_memory64 ? section.val : section.emit_u32v();
 emit();
        }
      });
    var exports_count = wasm.exports.length;
      binary.emit_section(kExportSectionCode, section => {
        section.emit_u32v(exports_count);
        for (let exp of wasm.exports) {
          section.emit_string(exp.name);
          section.emit_u8();
          section.emit_u32v();
        }
      });
      binary.emit_section(kCodeSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        let header;
        for (let func of wasm.functions) {
          if (func.locals.length == 0) {
          } else {
            if (!header) header = new Binary;
            header.emit_u32v(func.locals.length);
            for (let decl of func.locals) {
              header.emit_u32v(decl.count);
              header.emit_type(decl.type);
            }
            section.emit_u32v(header.length + func.body.length);
            section.emit_bytes(header.trunc_buffer());
          }
          section.emit_bytes(func.body);
        }
      });
    return binary.trunc_buffer();
  }
  instantiate() {
    let module = this.toModule();
    let instance = new WebAssembly.Instance(module);
    return instance;
  }
  toModule() {
    return new WebAssembly.Module(this.toBuffer());
  }
}
const builder = new WasmModuleBuilder();
builder.addMemory();
builder.addFunction("test", makeSig([kWasmI32], []))
  .addLocals(kWasmS128, 15)
  .addBody([
    kExprLocalGet, 1,
    kExprI32Const, 42,
    kSimdPrefix, 23, 0,
    kExprLocalSet, 2,
    kExprLocalGet, 1,
    kExprI32Const, 43,
    kSimdPrefix, 23, 1,
    kExprLocalSet, 3,
    kExprLocalGet, 3,
    kExprLocalSet, 4,
    kExprLocalGet, 4,
    kExprI32Const, 44,
    kSimdPrefix, 23, 2,
    kExprLocalSet, 5,
    kExprLocalGet, 1,
    kExprI32Const, 45,
    kSimdPrefix, 23, 3,
    kExprLocalSet, 6,
    kExprLocalGet, 0,
    kExprLocalGet, 6, // D
    kSimdPrefix, 11, 0, 16,
    kExprLocalGet, 0,
    kExprLocalGet, 3, // C
    kSimdPrefix, 11, 0, 0,
    kExprLocalGet, 0,
    kExprLocalGet, 5, // B
    kSimdPrefix, 11, 0, 48,
    kExprLocalGet, 0,
    kExprLocalGet, 2, // A
    kSimdPrefix, 11, 0, 32,
    kExprLocalGet, 0,
    kExprLocalGet, 1,
    kSimdPrefix, 11, 0, 80,
    kExprLocalGet, 0,
    kExprLocalGet, 1,
    kSimdPrefix, 11, 0, 64, 0,
  ])
  .exportFunc();
const instance = builder.instantiate();
  instance.exports.test();
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
let kExportSectionCode = 7;      // Exports
let kCodeSectionCode = 10;       // Function code
let kWasmSharedTypeForm = 0x65;
let kWasmFunctionTypeForm = 0x60;
let kWasmStructTypeForm = 0x5f;
let kNoSuperType = 0xFFFFFFFF;
let kWasmI32 = 0x7f;
let kWasmRef = 0x64;
class RefTypeBuilder {
  constructor(opcode) {
    this.opcode = opcode;
  }
}
function wasmRefType() {
  return new RefTypeBuilder(kWasmRef);
}
let kExternalFunction = 0;
function makeSig(params, results) {
  return {params: params, results: results};
}
const kWasmOpcodes = {
  'End': 0x0b,
  'LocalGet': 0x20,
};
function defineWasmOpcode(name, value) {
  Object.defineProperty(globalThis, name, {value: value});
}
for (let name in kWasmOpcodes) {
  defineWasmOpcode(`kExpr${name}`, kWasmOpcodes[name]);
}
const kPrefixOpcodes = {
  'GC': 0xfb,
};
for (let prefix in kPrefixOpcodes) {
  defineWasmOpcode(`k${prefix}Prefix`, kPrefixOpcodes[prefix]);
}
let kExprStructNewDefault = 0x01;
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
  emit_heap_type() {
    this.emit_bytes(wasmSignedLeb());
  }
  emit_type(type) {
    if ((typeof type) == 'number') {
      this.emit_u8(type >= 0 ? type : type & kLeb128Mask);
    } else {
      this.emit_u8(type.opcode);
      this.emit_heap_type();
    }
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
  constructor(module, name, type_index) {
    this.module = module;
    this.name = name;
    this.type_index = type_index;
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
}
function makeField(type, mutability) {
  return {type: type, mutability: mutability};
}
class WasmStruct {
  constructor(fields, is_final, is_shared) {
    this.fields = fields;
    this.is_shared = is_shared;
  }
}
class WasmModuleBuilder {
  constructor() {
    this.types = [];
    this.exports = [];
    this.functions = [];
    this.num_imported_funcs = 0;
  }
  addType(type, supertype_idx = kNoSuperType = true,
          is_shared = false) {
    var type_copy = {params: type.params, results: type.results,
                     supertype: supertype_idx};
    this.types.push(type_copy);
    return this.types.length - 1;
  }
  addStruct(fields, supertype_idx = kNoSuperType, is_final = false,
            is_shared = false) {
    this.types.push(
        new WasmStruct(fields, is_shared, supertype_idx));
  }
  addFunction(name, type, arg_names) {
    let type_index =typeof type == 'number' ? type : this.addType(type);
    let func = new WasmFunctionBuilder(this, name, type_index);
    func.index = this.functions.length + this.num_imported_funcs;
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
          if (type.is_shared) section.emit_u8(kWasmSharedTypeForm);
          if (type instanceof WasmStruct) {
            section.emit_u8(kWasmStructTypeForm);
            section.emit_u32v(type.fields.length);
            for (let field of type.fields) {
              section.emit_type(field.type);
              section.emit_u8(field.mutability ? 1 : 0);
            }
          } else {
            section.emit_u8(kWasmFunctionTypeForm);
            section.emit_u32v(type.params.length);
            for (let param of type.params) {
              section.emit_type(param);
            }
            section.emit_u32v(type.results.length);
            for (let result of type.results) {
              section.emit_type(result);
            }
          }
        }
      });
      binary.emit_section(kFunctionSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {
          section.emit_u32v(func.type_index);
        }
      });
    var exports_count = wasm.exports.length;
      binary.emit_section(kExportSectionCode, section => {
        section.emit_u32v(exports_count);
        for (let exp of wasm.exports) {
          section.emit_string(exp.name);
          section.emit_u8();
          section.emit_u32v(exp.index);
        }
      });
      binary.emit_section(kCodeSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {
            section.emit_u32v(func.body.length + 1);
            section.emit_u8();  // 0 locals.
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
function wasmSignedLeb(val, max_len = 5) {
  let res = [];
    let v = val & 0x7f;
      res.push(v);
      return res;
};
let builder = new WasmModuleBuilder();
  let struct_idx = builder.addStruct([makeField(kWasmI32, true)]);
  builder.addFunction("create", makeSig([], [wasmRefType()]))
    .addBody([
      kGCPrefix, kExprStructNewDefault, struct_idx
    ])
    .exportFunc();
  builder.addFunction("test", makeSig([wasmRefType(), kWasmI32], []))
    .addBody([
      kExprLocalGet, 0,
      kExprLocalGet, 1,
      0xfe, 0x5f, // struct.atomic.set
      0x01, // memory order AcqRel
,
      0x00 // field index 0
    ])
    .exportFunc();
  let instance = builder.instantiate();
  let struct = instance.exports.create();
  instance.exports.test(struct);